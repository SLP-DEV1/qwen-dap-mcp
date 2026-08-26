import assert from 'node:assert/strict';
import test from 'node:test';

import { DapConnection } from '../src/dap/connection.js';
import { currentDapOperationContext, runWithDapOperationContext } from '../src/dap/operation-context.js';

const delayedAdapterScript = String.raw`
let buffer = Buffer.alloc(0);
const sep = Buffer.from('\r\n\r\n');
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf(sep);
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString('ascii');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const start = headerEnd + sep.length;
    if (buffer.length < start + length) return;
    const request = JSON.parse(buffer.subarray(start, start + length).toString('utf8'));
    buffer = buffer.subarray(start + length);
    setTimeout(() => {
      const response = {
        seq: 1000 + request.seq,
        type: 'response',
        request_seq: request.seq,
        command: request.command,
        success: true,
        body: { ok: true },
      };
      const payload = Buffer.from(JSON.stringify(response));
      process.stdout.write(Buffer.from('Content-Length: ' + payload.length + '\r\n\r\n'));
      process.stdout.write(payload);
    }, 120);
  }
});
setInterval(() => {}, 1000);
`;

test('operation context is request-local and aborts at its deadline', async () => {
  assert.equal(currentDapOperationContext(), undefined);
  await assert.rejects(
    runWithDapOperationContext({ label: 'deadline-test', timeoutMs: 20 }, async (context) => {
      assert.equal(currentDapOperationContext(), context);
      await new Promise((resolve) => setTimeout(resolve, 40));
      context.throwIfAborted();
    }),
    /deadline-test cancelled|deadline exceeded/,
  );
  assert.equal(currentDapOperationContext(), undefined);
});

test('DAP request cancellation removes pending authority and late response becomes orphaned', async () => {
  const connection = new DapConnection();
  let orphanResponses = 0;
  connection.on('orphanResponse', () => { orphanResponses += 1; });

  await connection.start({ command: process.execPath, args: ['-e', delayedAdapterScript] });
  try {
    await assert.rejects(
      runWithDapOperationContext({ label: 'compare-deadline', timeoutMs: 25 }, async () => {
        await connection.sendRequest('threads', {}, 5_000);
      }),
      /cancelled by compare-deadline/,
    );

    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(orphanResponses, 1);
  } finally {
    await connection.stop();
  }
});

test('DAP event waits inherit operation cancellation', async () => {
  const connection = new DapConnection();
  await connection.start({ command: process.execPath, args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000);'] });
  try {
    await assert.rejects(
      runWithDapOperationContext({ label: 'event-deadline', timeoutMs: 20 }, async () => {
        await connection.waitForEvent('stopped', 5_000);
      }),
      /event wait 'stopped' cancelled by event-deadline/,
    );
  } finally {
    await connection.stop();
  }
});

test('transport generation advances across adapter replacement', async () => {
  const connection = new DapConnection();
  const initial = connection.generation;
  await connection.start({ command: process.execPath, args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000);'] });
  const started = connection.generation;
  assert.ok(started > initial);
  await connection.stop();
  const stopped = connection.generation;
  assert.ok(stopped > started);
  await connection.start({ command: process.execPath, args: ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000);'] });
  assert.ok(connection.generation > stopped);
  await connection.stop();
});
