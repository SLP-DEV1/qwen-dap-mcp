import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildCodeLldbAttachConfiguration,
  buildCodeLldbLaunchConfiguration,
  discoverCodeLldb,
} from '../src/adapters/codelldb.js';

function adapterName(): string {
  return process.platform === 'win32' ? 'codelldb.exe' : 'codelldb';
}

test('discovers the newest CodeLLDB VS Code extension adapter', () => {
  const root = mkdtempSync(join(tmpdir(), 'qwen-dap-mcp-codelldb-'));
  try {
    for (const version of ['1.11.0', '1.12.2']) {
      const adapterDir = join(root, `vadimcn.vscode-lldb-${version}`, 'adapter');
      mkdirSync(adapterDir, { recursive: true });
      writeFileSync(join(adapterDir, adapterName()), 'fixture');
    }

    const result = discoverCodeLldb({
      extensionRoots: [root],
      env: {},
      allowPathFallback: false,
    });

    assert.equal(result.source, 'extension');
    assert.match(result.command, /1\.12\.2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('explicit adapter path wins over discovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'qwen-dap-mcp-codelldb-explicit-'));
  try {
    const adapter = join(root, adapterName());
    writeFileSync(adapter, 'fixture');
    const result = discoverCodeLldb({ explicitPath: adapter, allowPathFallback: false });
    assert.equal(result.source, 'explicit');
    assert.equal(result.command, adapter);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CodeLLDB launch profile validates the local program and keeps debuggee I/O in the DAP console', () => {
  const root = mkdtempSync(join(tmpdir(), 'qwen-dap-mcp-launch-'));
  try {
    const program = join(root, 'native-smoke.exe');
    writeFileSync(program, 'fixture');

    const config = buildCodeLldbLaunchConfiguration({
      program,
      args: ['one', 'two'],
      stopOnEntry: true,
    });

    assert.equal(config.type, 'lldb');
    assert.equal(config.request, 'launch');
    assert.equal(config.terminal, 'console');
    assert.equal(config.stopOnEntry, true);
    assert.equal(config.program, program);
    assert.equal(config.cwd, root);
    assert.deepEqual(config.args, ['one', 'two']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CodeLLDB launch profile rejects a missing local program before contacting the adapter', () => {
  const root = mkdtempSync(join(tmpdir(), 'qwen-dap-mcp-launch-missing-'));
  try {
    assert.throws(
      () => buildCodeLldbLaunchConfiguration({ program: join(root, 'missing.exe') }),
      /Program executable does not exist/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CodeLLDB attach profile uses a concrete PID', () => {
  const config = buildCodeLldbAttachConfiguration({ pid: 4242, stopOnEntry: true });
  assert.equal(config.type, 'lldb');
  assert.equal(config.request, 'attach');
  assert.equal(config.pid, 4242);
});
