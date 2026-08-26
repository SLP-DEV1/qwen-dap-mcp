import assert from 'node:assert/strict';
import test from 'node:test';

import { DapConnection } from '../src/dap/connection.js';

type TestableConnection = DapConnection & {
  onStdout(chunk: Buffer): void;
};

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
