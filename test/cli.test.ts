import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function runCli(flag: '--help' | '--version') {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', flag], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
  });
}

test('CLI exposes the package version without starting stdio transport', () => {
  const result = runCli('--version');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^\d+\.\d+\.\d+\s*$/);
  assert.equal(result.stderr, '');
});

test('CLI exposes concise help without starting stdio transport', () => {
  const result = runCli('--help');

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /qwen extensions install SLP-DEV1\/qwen-dap-mcp/);
  assert.match(result.stdout, /npx -y @slp-dev1\/qwen-dap-mcp/);
  assert.equal(result.stderr, '');
});
