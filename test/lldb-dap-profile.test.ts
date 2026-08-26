import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildLldbDapAttachConfiguration,
  buildLldbDapCoreConfiguration,
  buildLldbDapLaunchConfiguration,
  discoverLldbDap,
} from '../src/adapters/lldb-dap.js';

function adapterName(): string {
  return process.platform === 'win32' ? 'lldb-dap.exe' : 'lldb-dap';
}

test('explicit lldb-dap path wins over all discovery fallbacks', () => {
  const root = mkdtempSync(join(tmpdir(), 'qwen-dap-mcp-lldb-dap-explicit-'));
  try {
    const adapter = join(root, adapterName());
    writeFileSync(adapter, 'fixture');
    const result = discoverLldbDap({
      explicitPath: adapter,
      env: { LLDB_DAP_PATH: join(root, 'ignored') },
      allowPathFallback: false,
      allowXcrunFallback: false,
    });
    assert.equal(result.source, 'explicit');
    assert.equal(result.command, adapter);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('LLDB_DAP_PATH provides deterministic environment discovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'qwen-dap-mcp-lldb-dap-env-'));
  try {
    const adapter = join(root, adapterName());
    writeFileSync(adapter, 'fixture');
    const result = discoverLldbDap({
      env: { LLDB_DAP_PATH: adapter },
      allowPathFallback: false,
      allowXcrunFallback: false,
    });
    assert.equal(result.source, 'environment');
    assert.equal(result.command, adapter);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lldb-dap launch profile uses the upstream version-neutral configuration shape', () => {
  const root = mkdtempSync(join(tmpdir(), 'qwen-dap-mcp-lldb-dap-launch-'));
  try {
    const program = join(root, 'native-smoke');
    writeFileSync(program, 'fixture');
    const config = buildLldbDapLaunchConfiguration({
      program,
      args: ['one', 'two'],
      env: { FOO: '1' },
      stopOnEntry: true,
    });

    assert.equal(config.type, 'lldb-dap');
    assert.equal(config.request, 'launch');
    assert.equal(config.program, program);
    assert.equal(config.cwd, root);
    assert.equal('console' in config, false);
    assert.equal('runInTerminal' in config, false);
    assert.equal(config.stopOnEntry, true);
    assert.deepEqual(config.args, ['one', 'two']);
    assert.deepEqual(config.env, { FOO: '1' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lldb-dap attach profile validates PID and optional program', () => {
  const root = mkdtempSync(join(tmpdir(), 'qwen-dap-mcp-lldb-dap-attach-'));
  try {
    const program = join(root, 'native-smoke');
    writeFileSync(program, 'fixture');
    const config = buildLldbDapAttachConfiguration({ pid: 4242, program, stopOnEntry: true });
    assert.equal(config.type, 'lldb-dap');
    assert.equal(config.request, 'attach');
    assert.equal(config.pid, 4242);
    assert.equal(config.program, program);

    for (const pid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      assert.throws(() => buildLldbDapAttachConfiguration({ pid }), /positive safe integer/i);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lldb-dap core profile uses coreFile and converts sourceMap to upstream pair arrays', () => {
  const root = mkdtempSync(join(tmpdir(), 'qwen-dap-mcp-lldb-dap-core-'));
  try {
    const coreFile = join(root, 'crash.core');
    const program = join(root, 'native-smoke');
    writeFileSync(coreFile, 'fixture');
    writeFileSync(program, 'fixture');

    const config = buildLldbDapCoreConfiguration({
      coreFile,
      program,
      sourceMap: { '/build/src': '/workspace/src', '/old': '/new' },
    });

    assert.equal(config.type, 'lldb-dap');
    assert.equal(config.request, 'attach');
    assert.equal(config.coreFile, coreFile);
    assert.equal(config.program, program);
    assert.deepEqual(config.sourceMap, [
      ['/build/src', '/workspace/src'],
      ['/old', '/new'],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lldb-dap core profile requires an existing matching program image', () => {
  const root = mkdtempSync(join(tmpdir(), 'qwen-dap-mcp-lldb-dap-core-missing-'));
  try {
    const coreFile = join(root, 'crash.core');
    writeFileSync(coreFile, 'fixture');
    assert.throws(
      () => buildLldbDapCoreConfiguration({ coreFile, program: join(root, 'missing') }),
      /Program image does not exist/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
