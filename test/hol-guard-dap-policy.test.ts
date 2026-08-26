import assert from 'node:assert/strict';
import test from 'node:test';
import type { DebugProtocol } from '@vscode/debugprotocol';

import { GuardedDapSession } from '../src/dap/guarded-session.js';
import type { HolGuardAction, HolGuardDecision, HolGuardEvaluator } from '../src/dap/hol-guard-policy.js';
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
  decide: (action: HolGuardAction) => HolGuardDecision | Promise<HolGuardDecision>,
): HolGuardEvaluator {
  return { enabled: true, evaluate: async (action) => decide(action) };
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

test('active adapter workspace and hashed environment are bound into later protected requests', async () => {
  const evaluated: HolGuardAction[] = [];
  const session = new GuardedDapSession({
    holGuardEvaluator: evaluator(async (action) => {
      evaluated.push(action);
      if (action.kind === 'dap-request' && action.command === 'evaluate') {
        return { allow: false, action: 'review', reason: 'approval required', reviewCommand: 'hol-guard approvals approve fixture' };
      }
      return { allow: true, action: 'allow', reason: 'fixture allowed' };
    }),
  });
  const requests = installLoopbackTransport(session.connection);
  (session.connection as unknown as { start: (options: unknown) => Promise<void> }).start = async () => {
    makeRequestable(session.connection);
  };

  await session.start({
    command: 'fixture-adapter',
    args: ['--stdio'],
    cwd: '/workspace/project-a',
    env: { QWEN_DAP_TEST_SECRET: 'never-forward-this-value' },
    adapterId: 'fixture',
  });
  assert.equal(requests[0]?.command, 'initialize');

  await assert.rejects(
    session.connection.sendRequest('evaluate', { expression: 'dangerous_call()' }),
    /hol-guard approvals approve fixture/i,
  );

  const protectedAction = evaluated.find(
    (action): action is Extract<HolGuardAction, { kind: 'dap-request' }> =>
      action.kind === 'dap-request' && action.command === 'evaluate',
  );
  assert.ok(protectedAction);
  assert.equal(protectedAction.cwd, '/workspace/project-a');
  assert.equal(protectedAction.adapterCommand, 'fixture-adapter');
  assert.deepEqual(protectedAction.adapterArgs, ['--stdio']);
  assert.match(protectedAction.envHash ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.ok(protectedAction.envKeys?.includes('QWEN_DAP_TEST_SECRET'));
  assert.doesNotMatch(JSON.stringify(protectedAction), /never-forward-this-value/);
});

test('async HOL Guard failure is fail-closed before request state or transport allocation', async () => {
  const session = new GuardedDapSession({
    holGuardEvaluator: evaluator(async () => {
      await Promise.resolve();
      throw new Error('Guard process unavailable');
    }),
  });
  makeRequestable(session.connection);
  const requests = installLoopbackTransport(session.connection);

  await assert.rejects(
    session.connection.sendRequest('evaluate', { expression: 'f()' }),
    /policy failed closed/i,
  );
  assert.equal(requests.length, 0);

  // Swap to an allowed read request; denied/failed policy calls must not have
  // consumed a DAP sequence number.
  await session.connection.sendRequest('variables', { variablesReference: 1 });
  assert.equal(requests[0]?.seq, 1);
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
