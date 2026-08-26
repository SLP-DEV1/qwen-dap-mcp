import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { discoverLldbDap } from '../src/adapters/lldb-dap.js';

test('discovers lldb-dap from a toolchain directory candidate when it is not on PATH', () => {
  const root = mkdtempSync(join(tmpdir(), 'qwen-dap-mcp-lldb-toolchain-'));
  try {
    const adapter = join(root, process.platform === 'win32' ? 'lldb-dap.exe' : 'lldb-dap');
    writeFileSync(adapter, 'fixture');

    const result = discoverLldbDap({
      env: {},
      toolchainCandidates: [adapter],
      allowPathFallback: false,
      allowXcrunFallback: false,
    });

    assert.equal(result.source, 'toolchain');
    assert.equal(result.command, adapter);
    assert.deepEqual(result.searched, [adapter]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
