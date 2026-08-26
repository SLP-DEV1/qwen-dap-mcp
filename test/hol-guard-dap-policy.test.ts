import assert from 'node:assert/strict';
import test from 'node:test';
import type { DebugProtocol } from '@vscode/debugprotocol';

import { GuardedDapSession } from '../src/dap/guarded-session.js';
import type { HolGuardAction, HolGuardEvaluator } from '../src/dap/hol-guard-policy.js';
import type { DapConnection } from '../src/dap/connection.js';

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
        body: request.command === 'variables' ? { variables: [] } : {},
      } as DebugProtocol.Response);
    });
  };
  return requests;
}

function evaluator(
  decide: (action: HolGuardAction) => { allow: boolean; action: string; reason: string },
): HolGuardEvaluator {
  return { enabled: true, evaluate: decide };
}

test('HOL Guard blocks evaluate/launch before writeMessage while variables stays read-only', async () => {
  const evaluated: HolGuardAction[] = [];
  const session = new GuardedDapSession({
    dapPolicyMode: 'standard',
    holGuardEvaluator: evaluator((action) => {
      evaluated.push(action);
      if (action.kind === 'dap-request' && ['evaluate', 'launch'].includes(action.command)) {
        return { allow: false, action: 'block', reason: 'fixture denied executable debugger action' };
      }
      return { allow: true, action: 'allow', reason: 'fixture allowed' };
    }),
  });
  makeRequestable(session.connection);
  const requests = installLoopbackTransport(session.connection);

  await assert.rejects(
    session.connection.sendRequest('evaluate', { expression: 'dangerous_call()' }),
    /HOL Guard.*block/i,
  );
  await assert.rejects(
    session.connection.sendRequest('launch', { program: 'wrong-process.exe' }),
    /HOL Guard.*block/i,
  );
  assert.equal(requests.length, 0, 'blocked DAP requests must never reach writeMessage');

  await session.connection.sendRequest('variables', { variablesReference: 1 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.command, 'variables');
  assert.equal(requests[0]?.seq, 1, 'denied requests must not consume DAP sequence numbers');
  assert.deepEqual(
    evaluated.map((action) => action.kind === 'dap-request' ? action.command : action.kind),
    ['evaluate', 'launch'],
    'read-only variables must bypass HOL Guard evaluation',
  );
});

test('HOL Guard blocks adapter start before DapConnection.start can spawn a process', async () => {
  let transportStarts = 0;
  const session = new GuardedDapSession({
    dapPolicyMode: 'standard',
    holGuardEvaluator: evaluator((action) => action.kind === 'adapter-start'
      ? { allow: false, action: 'block', reason: 'fixture denied wrong adapter process' }
      : { allow: true, action: 'allow', reason: 'fixture allowed' }),
  });

  (session.connection as unknown as { start: (options: unknown) => Promise<void> }).start = async () => {
    transportStarts += 1;
  };

  await assert.rejects(
    session.start({ command: 'wrong-adapter.exe', adapterId: 'fixture' }),
    /HOL Guard blocked DAP adapter start/i,
  );
  assert.equal(transportStarts, 0, 'denied adapter start must not reach the spawn-capable connection path');
});

test('built-in inspect-only policy remains authoritative before HOL Guard', async () => {
  let holGuardCalls = 0;
  const session = new GuardedDapSession({
    dapPolicyMode: 'inspect-only',
    holGuardEvaluator: evaluator(() => {
      holGuardCalls += 1;
      return { allow: true, action: 'allow', reason: 'fixture would allow' };
    }),
  });
  makeRequestable(session.connection);
  const requests = installLoopbackTransport(session.connection);

  await assert.rejects(
    session.connection.sendRequest('evaluate', { expression: 'f()' }),
    /inspect-only|blocked by policy/i,
  );
  assert.equal(holGuardCalls, 0, 'local fail-closed policy must run before external HOL Guard evaluation');
  assert.equal(requests.length, 0);
});
