import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ManagedRrReplay } from '../src/adapters/rr-replay.js';

test('managed rr replay starts, reports and stops a fixed-argv replay process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qwen-dap-fake-rr-'));
  const traceDir = join(root, 'trace');
  mkdirSync(traceDir);
  const fakeRr = join(root, 'rr');
  const script = [
    '#!/usr/bin/env node',
    "const args = process.argv.slice(2);",
    "if (args[0] === '--version') {",
    "  console.log('rr version fake-1.0');",
    "  process.exit(0);",
    "}",
    "if (args[0] === 'replay') {",
    "  console.error('Listening for gdb connection');",
    "  setInterval(() => {}, 1000);",
    "}",
    '',
  ].join('\n');
  writeFileSync(fakeRr, script, 'utf8');
  chmodSync(fakeRr, 0o755);

  const replay = new ManagedRrReplay();
  try {
    const started = await replay.start({
      traceDir,
      port: 50555,
      rrPath: fakeRr,
      readyTimeoutMs: 2_000,
    });
    assert.equal(started.running, true);
    assert.equal(started.port, 50555);
    assert.equal(started.traceDir, traceDir);
    assert.ok(started.stderrTail.some((line) => /Listening for gdb/i.test(line)));
  } finally {
    const stopped = await replay.stop();
    assert.equal(stopped.running, false);
  }
});