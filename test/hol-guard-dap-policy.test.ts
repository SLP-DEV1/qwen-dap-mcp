import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import test from 'node:test';
import type { DebugProtocol } from '@vscode/debugprotocol';

import { GuardedDapSession } from '../src/dap/guarded-session.js';
import {
  buildHolGuardBridgeEnvironment,
  sanitizeAdapterArgsForHolGuard,
  type HolGuardAction,
  type HolGuardDecision,
  type HolGuardEvaluator,
} from '../src/dap/hol-guard-policy.js';
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

test('HOL Guard blocks protected requests before writeMessage while variables stays on the read-only fast path', async () => {
  const evaluated: HolGuardAction[] = [];
  const session = new GuardedDapSession({
    dapPolicyMode: 'standard',
    holGuardEvaluator: evaluator((action) => {
      evaluated.push(action);
      if (action.kind === 'dap-request' && ['evaluate', 'launch', 'setVariable'].includes(action.command)) {
        return { allow: false, action: 'block', reason: 'fixture denied mutable debugger action' };
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
  await assert.rejects(
    session.connection.sendRequest('setVariable', { variablesReference: 1, name: 'x', value: '1' }),
    /HOL Guard.*block/i,
  );
  assert.equal(requests.length, 0, 'blocked DAP requests must never reach writeMessage');

  const variablesResponse = session.connection.sendRequest('variables', { variablesReference: 1 });
  assert.equal(requests.length, 1, 'read-only requests must not insert an async policy hop');
  await variablesResponse;
  assert.equal(requests[0]?.command, 'variables');
  assert.equal(requests[0]?.seq, 1, 'denied requests must not consume DAP sequence numbers');
  assert.deepEqual(
    evaluated.map((action) => action.kind === 'dap-request' ? action.command : action.kind),
    ['evaluate', 'launch', 'setVariable'],
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

test('active adapter identity, workspace and environment are bound without forwarding raw secrets', async () => {
  const evaluated: HolGuardAction[] = [];
  let transportStartOptions: unknown;
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
  (session.connection as unknown as { start: (options: unknown) => Promise<void> }).start = async (options) => {
    transportStartOptions = options;
    makeRequestable(session.connection);
  };

  await session.start({
    command: process.execPath,
    args: ['--stdio', '--token', 'adapter-cli-secret'],
    cwd: '/workspace/project-a',
    env: { QWEN_DAP_TEST_SECRET: 'never-forward-this-value' },
    adapterId: 'fixture',
  });
  assert.equal(requests[0]?.command, 'initialize');

  const adapterAction = evaluated.find(
    (action): action is Extract<HolGuardAction, { kind: 'adapter-start' }> => action.kind === 'adapter-start',
  );
  assert.ok(adapterAction);
  assert.equal(adapterAction.adapterCommand, process.execPath);
  assert.equal(adapterAction.adapterResolvedCommand, realpathSync(process.execPath));
  assert.match(adapterAction.adapterExecutableHash ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.match(adapterAction.adapterIdentityHash ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(adapterAction), /adapter-cli-secret|never-forward-this-value/);
  assert.match(adapterAction.args[2] ?? '', /^<redacted:sha256:[a-f0-9]{64}>$/);

  const started = transportStartOptions as { command?: string; args?: string[] };
  assert.equal(started.command, realpathSync(process.execPath), 'spawn path must be the executable that was approved');
  assert.deepEqual(started.args, ['--stdio', '--token', 'adapter-cli-secret'], 'real adapter still receives original args');

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
  assert.equal(protectedAction.adapterResolvedCommand, realpathSync(process.execPath));
  assert.match(protectedAction.adapterExecutableHash ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.match(protectedAction.adapterIdentityHash ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.match(protectedAction.envHash ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.ok(protectedAction.envKeys?.includes('QWEN_DAP_TEST_SECRET'));
  assert.doesNotMatch(JSON.stringify(protectedAction), /adapter-cli-secret|never-forward-this-value/);
});

test('DAP secrets are hashed for HOL Guard while the actual adapter receives the original request', async () => {
  let protectedAction: HolGuardAction | undefined;
  const session = new GuardedDapSession({
    holGuardEvaluator: evaluator((action) => {
      protectedAction = action;
      return { allow: true, action: 'allow', reason: 'fixture allowed' };
    }),
  });
  makeRequestable(session.connection);
  const requests = installLoopbackTransport(session.connection);
  const launchArgs = {
    program: '/tmp/app',
    env: {
      API_TOKEN: 'dap-env-secret',
      NORMAL_VALUE: 'also-private-env-value',
    },
    apiKey: 'top-level-api-secret',
    nested: {
      password: 'nested-password-secret',
      visible: 'safe-value',
    },
  };

  await session.connection.sendRequest('launch', launchArgs);
  assert.ok(protectedAction && protectedAction.kind === 'dap-request');
  const serializedGuardAction = JSON.stringify(protectedAction);
  assert.doesNotMatch(
    serializedGuardAction,
    /dap-env-secret|also-private-env-value|top-level-api-secret|nested-password-secret/,
  );
  assert.match(serializedGuardAction, /sha256:[a-f0-9]{64}/);
  assert.match(serializedGuardAction, /safe-value/);

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.command, 'launch');
  assert.deepEqual(requests[0]?.arguments, launchArgs, 'policy redaction must never mutate the real DAP request');
});

test('HOL Guard bridge environment strips unrelated process secrets', () => {
  const environment = buildHolGuardBridgeEnvironment({
    PATH: '/usr/bin',
    HOME: '/home/fixture',
    HOL_GUARD_HOME: '/tmp/guard',
    OPENAI_API_KEY: 'must-not-cross-bridge',
    AWS_SECRET_ACCESS_KEY: 'must-not-cross-bridge-either',
  });
  assert.equal(environment.PATH, '/usr/bin');
  assert.equal(environment.HOME, '/home/fixture');
  assert.equal(environment.HOL_GUARD_HOME, '/tmp/guard');
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
});

test('adapter CLI secret flags are hash-redacted without losing exact identity semantics', () => {
  const sanitized = sanitizeAdapterArgsForHolGuard([
    '--stdio',
    '--token',
    'secret-one',
    '--api-key=secret-two',
    'ordinary',
  ]);
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, /secret-one|secret-two/);
  assert.match(sanitized[2] ?? '', /^<redacted:sha256:[a-f0-9]{64}>$/);
  assert.match(sanitized[3] ?? '', /^--api-key=<redacted:sha256:[a-f0-9]{64}>$/);
  assert.equal(sanitized[4], 'ordinary');
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
