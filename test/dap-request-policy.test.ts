import assert from 'node:assert/strict';
import test from 'node:test';
import type { DebugProtocol } from '@vscode/debugprotocol';

import { DapConnection } from '../src/dap/connection.js';
import { createDapRequestPolicy, resolveDapPolicyMode } from '../src/dap/request-policy.js';

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
        body: request.command === 'variables'
          ? { variables: [] }
          : request.command === 'stackTrace'
            ? { stackFrames: [], totalFrames: 0 }
            : {},
      } as DebugProtocol.Response);
    });
  };
  return requests;
}

test('inspect-only policy denies evaluate and launch before transport or request-state side effects', async () => {
  const connection = new DapConnection({ policyMode: 'inspect-only' });
  makeRequestable(connection);
  const requests = installLoopbackTransport(connection);

  await assert.rejects(
    connection.sendRequest('evaluate', { expression: 'dangerous_call()' }),
    /blocked by policy/i,
  );
  await assert.rejects(
    connection.sendRequest('launch', { program: 'wrong-process.exe' }),
    /blocked by policy/i,
  );

  assert.equal(requests.length, 0, 'denied requests must never reach writeMessage');

  await connection.sendRequest('variables', { variablesReference: 1 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.command, 'variables');
  assert.equal(requests[0]?.seq, 1, 'denied requests must not consume DAP sequence numbers');
});

test('inspect-only policy still allows variables and stackTrace inspection requests', async () => {
  const connection = new DapConnection({ policyMode: 'inspect-only' });
  makeRequestable(connection);
  const requests = installLoopbackTransport(connection);

  await connection.sendRequest('variables', { variablesReference: 1 });
  await connection.sendRequest('stackTrace', { threadId: 1, startFrame: 0, levels: 20 });

  assert.deepEqual(requests.map((request) => request.command), ['variables', 'stackTrace']);
});

test('custom policy failures are fail-closed before transport side effects', async () => {
  const connection = new DapConnection({
    requestPolicy: () => {
      throw new Error('HOL Guard unavailable');
    },
  });
  makeRequestable(connection);
  const requests = installLoopbackTransport(connection);

  await assert.rejects(connection.sendRequest('evaluate', { expression: 'f()' }), /failed closed/i);
  assert.equal(requests.length, 0);
});

test('policy helpers classify read-only aliases without silently accepting unknown modes', () => {
  assert.equal(resolveDapPolicyMode('read-only'), 'inspect-only');
  assert.equal(resolveDapPolicyMode('readonly'), 'inspect-only');
  assert.equal(createDapRequestPolicy('inspect-only')({ command: 'variables' }).allow, true);
  assert.equal(createDapRequestPolicy('inspect-only')({ command: 'evaluate' }).allow, false);
  assert.throws(() => resolveDapPolicyMode('anything-goes'), /unsupported/i);
});
