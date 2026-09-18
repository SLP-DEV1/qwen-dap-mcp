import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

import { ManagedRrReplay } from '../src/adapters/rr-replay.js';
import { recordWithRr } from '../src/adapters/rr.js';

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate loopback port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

if (process.platform !== 'linux') {
  throw new Error('rr real smoke requires Linux');
}

const root = mkdtempSync(join(tmpdir(), 'qwen-dap-rr-'));
const traceDir = join(root, 'trace');
const recording = recordWithRr({
  program: '/bin/true',
  traceDir,
  timeoutMs: 60_000,
  env: { RR_ALLOW_UNKNOWN_CPUS: '1' },
});

assert.equal(recording.success, true, 'rr record failed: ' + recording.stderr);
assert.equal(recording.commandIdentity.shell, false);
assert.ok(recording.requestedTraceDir);

const port = await freeLoopbackPort();
const replay = new ManagedRrReplay();

try {
  const started = await replay.start({ traceDir, port, readyTimeoutMs: 5_000 });
  assert.equal(started.running, true);
  assert.ok(started.pid && started.pid > 0);
  assert.equal(started.port, port);

  const status = replay.status();
  assert.equal(status.running, true);
  assert.equal(status.traceDir, traceDir);

  console.log(JSON.stringify({
    ok: true,
    rr: recording.rr,
    traceDir,
    replay: {
      pid: status.pid,
      port: status.port,
      stderrTail: status.stderrTail,
    },
  }, null, 2));
} finally {
  const stopped = await replay.stop();
  assert.equal(stopped.running, false);
}
