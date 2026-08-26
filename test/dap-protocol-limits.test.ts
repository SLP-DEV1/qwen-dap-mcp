import assert from 'node:assert/strict';
import test from 'node:test';

import { DapConnection } from '../src/dap/connection.js';

type TestableConnection = DapConnection & {
  onStdout(chunk: Buffer): void;
};

function makeRequestable(connection: DapConnection): void {
  (connection as unknown as { child: unknown }).child = {
    exitCode: null,
    signalCode: null,
    stdin: { write: () => true },
  };
}

test('rejects an oversized DAP header even when the terminator is present', () => {
  const connection = new DapConnection() as TestableConnection;
  let protocolError: Error | undefined;
  connection.once('protocolError', (error) => {
    protocolError = error as Error;
  });

  const oversizedHeader = Buffer.from(`X-Test: ${'a'.repeat(70 * 1024)}\r\nContent-Length: 2\r\n\r\n{}`);
  connection.onStdout(oversizedHeader);

  assert.ok(protocolError);
  assert.match(protocolError.message, /header exceeded 65536 bytes/i);
});

test('rejects an unterminated DAP header once it exceeds the safety bound', () => {
  const connection = new DapConnection() as TestableConnection;
  let protocolError: Error | undefined;
  connection.once('protocolError', (error) => {
    protocolError = error as Error;
  });

  connection.onStdout(Buffer.from(`X-Test: ${'b'.repeat(70 * 1024)}`));

  assert.ok(protocolError);
  assert.match(protocolError.message, /without a terminator/i);
});

test('malformed DAP headers reject outstanding requests immediately', async () => {
  const connection = new DapConnection() as TestableConnection;
  makeRequestable(connection);
  const request = connection.sendRequest('threads', {}, 10_000);

  connection.onStdout(Buffer.from('X-Test: missing-length\r\n\r\n{}', 'ascii'));

  await assert.rejects(request, /invalid DAP header/i);
});

test('duplicate Content-Length fields are rejected instead of being ambiguously parsed', async () => {
  const connection = new DapConnection() as TestableConnection;
  makeRequestable(connection);
  const request = connection.sendRequest('threads', {}, 10_000);

  connection.onStdout(Buffer.from('Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}', 'ascii'));

  await assert.rejects(request, /multiple Content-Length/i);
});

test('invalid DAP JSON rejects outstanding requests instead of waiting for request timeout', async () => {
  const connection = new DapConnection() as TestableConnection;
  makeRequestable(connection);
  const request = connection.sendRequest('threads', {}, 10_000);
  const payload = '{x';

  connection.onStdout(Buffer.from(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`, 'utf8'));

  await assert.rejects(request, /failed to parse DAP JSON/i);
});
