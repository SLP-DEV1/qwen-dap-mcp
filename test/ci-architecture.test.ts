import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const workflow = (name: string) => path.join(root, '.github', 'workflows', name);

async function text(name: string): Promise<string> {
  return readFile(workflow(name), 'utf8');
}

test('default CI stays fast and preserves Node 20/22 coverage', async () => {
  const ci = await text('ci.yml');
  assert.match(ci, /node-version: \[20, 22\]/);
  assert.match(ci, /npm run check/);
  assert.match(ci, /Crash Lab smoke/);
  assert.match(ci, /Hang Lab smoke/);
  assert.doesNotMatch(ci, /^\s{2}hol-guard:/m);
  assert.doesNotMatch(ci, /^\s{2}container:/m);
});

test('native real-adapter coverage is consolidated and path-selected on PRs', async () => {
  const native = await text('native-smoke.yml');
  assert.match(native, /^\s{2}pull_request:/m);
  assert.match(native, /^\s{2}schedule:/m);
  assert.match(native, /^\s{2}workflow_dispatch:/m);
  assert.match(native, /^\s{2}workflow_call:/m);
  assert.match(native, /Select smoke suites/);

  for (const job of ['codelldb', 'dump', 'gdb', 'lldb', 'differential', 'multi']) {
    assert.match(native, new RegExp(`^\\s{2}${job}:`, 'm'), `missing consolidated ${job} smoke job`);
  }

  for (const removed of [
    'codelldb-windows.yml',
    'codelldb-windows-dump.yml',
    'gdb-dap-linux.yml',
    'lldb-dap-linux.yml',
    'differential-linux.yml',
    'multi-session-remote-linux.yml',
  ]) {
    await assert.rejects(access(workflow(removed)), `${removed} should be consolidated into native-smoke.yml`);
  }
});

test('expensive integration workflows are targeted and reusable', async () => {
  for (const name of ['hol-guard-compat.yml', 'extension-package-smoke.yml', 'container-smoke.yml']) {
    const contents = await text(name);
    assert.match(contents, /^\s{2}pull_request:/m, `${name} must be path-targeted on PRs`);
    assert.match(contents, /^\s{2}workflow_dispatch:/m, `${name} must remain manually runnable`);
    assert.match(contents, /^\s{2}workflow_call:/m, `${name} must be reusable by the release gate`);
    assert.match(contents, /cancel-in-progress: true/);
  }
});

test('release publication waits for all integration gates', async () => {
  const release = await text('release-extension.yml');
  assert.match(release, /uses: \.\/\.github\/workflows\/native-smoke\.yml/);
  assert.match(release, /uses: \.\/\.github\/workflows\/hol-guard-compat\.yml/);
  assert.match(release, /uses: \.\/\.github\/workflows\/extension-package-smoke\.yml/);
  assert.match(release, /uses: \.\/\.github\/workflows\/container-smoke\.yml/);
  assert.match(release, /needs:\s*\n\s*- native-smoke\s*\n\s*- hol-guard\s*\n\s*- extension-smoke\s*\n\s*- container-smoke/);
});
