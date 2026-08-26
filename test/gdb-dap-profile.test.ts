import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildGdbDapCoreConfiguration,
  buildGdbDapLaunchConfiguration,
  buildGdbDapPidAttachConfiguration,
  buildGdbDapRemoteAttachConfiguration,
  parseGdbVersion,
  resolveGdbDapRemoteEndpoint,
} from '../src/adapters/gdb-dap.js';

function fixtureFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'qwen-gdb-dap-'));
  const path = join(dir, name);
  writeFileSync(path, 'fixture');
  return path;
}

test('parseGdbVersion accepts release and distro version strings', () => {
  assert.deepEqual(parseGdbVersion('GNU gdb (GDB) 17.2\n'), { major: 17, minor: 2, raw: 'GNU gdb (GDB) 17.2' });
  assert.equal(parseGdbVersion('GNU gdb (Ubuntu 15.0.50.20240403-0ubuntu1) 15.0.50\n')?.major, 15);
  assert.equal(parseGdbVersion('not gdb'), undefined);
});

test('GDB DAP launch configuration uses documented launch fields', () => {
  const program = fixtureFile('app');
  const configuration = buildGdbDapLaunchConfiguration({
    program,
    args: ['--repro'],
    env: { TESTING: '1' },
    stopOnEntry: true,
    stopAtBeginningOfMainSubprogram: false,
  });
  assert.equal(configuration.program, program);
  assert.deepEqual(configuration.args, ['--repro']);
  assert.deepEqual(configuration.env, { TESTING: '1' });
  assert.equal(configuration.stopOnEntry, true);
  assert.equal(configuration.stopAtBeginningOfMainSubprogram, false);
});

test('GDB DAP supports PID, hardened target-remote, and core-file attach shapes', () => {
  const program = fixtureFile('app');
  const coreFile = fixtureFile('core');
  assert.deepEqual(buildGdbDapPidAttachConfiguration({ pid: 42, program }), { pid: 42, program });
  assert.deepEqual(buildGdbDapRemoteAttachConfiguration({ host: 'localhost', port: 1234, program }), { target: 'localhost:1234', program });
  assert.deepEqual(buildGdbDapRemoteAttachConfiguration({ target: '[::1]:1234', program }), { target: '[::1]:1234', program });
  assert.deepEqual(buildGdbDapCoreConfiguration({ coreFile, program }), { coreFile, program });
});

test('GDB remote attach rejects arbitrary target syntax and unapproved network hosts', () => {
  assert.throws(
    () => buildGdbDapRemoteAttachConfiguration({ target: '/dev/ttyS0' }),
    /must use host:port/,
  );
  assert.throws(
    () => buildGdbDapRemoteAttachConfiguration({ host: 'debug.example.test', port: 2345, policyEnv: {} }),
    /is not allowed/,
  );
  assert.deepEqual(
    resolveGdbDapRemoteEndpoint({
      host: 'debug.example.test',
      port: 2345,
      policyEnv: { QWEN_DAP_MCP_REMOTE_DEBUG_HOSTS: 'debug.example.test' },
    }),
    { host: 'debug.example.test', port: 2345, target: 'debug.example.test:2345', loopback: false },
  );
});
