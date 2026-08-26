import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { DapConnection } from '../src/dap/connection.js';

const fixture = fileURLToPath(new URL('./fixtures/mock-dap-adapter.mjs', import.meta.url));

test('late output and errors from a retired adapter cannot contaminate the current generation', async (t) => {
  const connection = new DapConnection();
  await connection.start({ command: process.execPath, args: [fixture] });
  const oldChild = (connection as unknown as { child: any }).child;
  assert.ok(oldChild);
  t.after(() => {
    try { oldChild.kill('SIGKILL'); } catch {}
  });

  const fakeCurrent = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    stdin: { write: (chunk: Buffer) => boolean };
    pid: number;
  };
  fakeCurrent.exitCode = null;
  fakeCurrent.signalCode = null;
  fakeCurrent.pid = 99999;
  fakeCurrent.stdin = { write: () => true };
  (connection as unknown as { child: unknown }).child = fakeCurrent;

  const pending = connection.sendRequest('threads', {}, 5_000);

  oldChild.stderr.emit('data', 'stale stderr from retired adapter\n');
  oldChild.stdout.emit('data', Buffer.from('not a DAP frame at all', 'utf8'));
  oldChild.emit('error', new Error('late retired process error'));

  assert.deepEqual(connection.recentStderr, []);

  const response = JSON.stringify({
    seq: 2,
    type: 'response',
    request_seq: 1,
    success: true,
    command: 'threads',
    body: { threads: [] },
  });
  (connection as unknown as { onStdout(chunk: Buffer): void }).onStdout(
    Buffer.from(`Content-Length: ${Buffer.byteLength(response)}\r\n\r\n${response}`, 'utf8'),
  );

  const resolved = await pending;
  assert.equal(resolved.success, true);
});
