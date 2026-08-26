import assert from 'node:assert/strict';
import test from 'node:test';
import type { DebugProtocol } from '@vscode/debugprotocol';

import { DapConnection } from '../src/dap/connection.js';
import type { DapRequestPolicyDecision } from '../src/dap/request-policy.js';

type TestableConnection = DapConnection & {
  writeMessage(message: DebugProtocol.ProtocolMessage): void;
  handleMessage(message: DebugProtocol.ProtocolMessage): void;
};

function makeRequestable(connection: DapConnection): void {
  (connection as unknown as { child: unknown }).child = {
    exitCode: null,
    signalCode: null,
    stdin: { write: () => true },
  };
}

function installLoopbackTransport(connection: DapConnection): DebugProtocol.Request[] {
  const testable = connection as TestableConnection;
  const requests: DebugProtocol.Request[] = [];
  testable.writeMessage = (message) => {
    if (message.type !== 'request') return;
    const request = message as DebugProtocol.Request;
    requests.push(request);
    queueMicrotask(() => {
      testable.handleMessage({
        seq: 10_000 + request.seq,
        type: 'response',
        request_seq: request.seq,
        command: request.command,
        success: true,
        body: {},
      } as DebugProtocol.Response);
    });
  };
  return requests;
}

test('synchronous DAP policies preserve immediate request-state allocation', async () => {
  const connection = new DapConnection({ requestPolicy: () => ({ allow: true }) });
  makeRequestable(connection);
  const requests = installLoopbackTransport(connection);

  const response = connection.sendRequest('threads');
  assert.equal(requests.length, 1, 'sync policies must not insert a microtask before writeMessage');
  assert.equal(requests[0]?.seq, 1);
  await response;
});

test('asynchronous DAP policies finish before request state or transport allocation', async () => {
  let release!: (decision: DapRequestPolicyDecision) => void;
  const connection = new DapConnection({
    requestPolicy: () => new Promise<DapRequestPolicyDecision>((resolve) => {
      release = resolve;
    }),
  });
  makeRequestable(connection);
  const requests = installLoopbackTransport(connection);

  const response = connection.sendRequest('threads');
  assert.equal(requests.length, 0, 'async policies must hold the execution boundary closed while pending');

  release({ allow: true });
  await response;
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.seq, 1);
});
