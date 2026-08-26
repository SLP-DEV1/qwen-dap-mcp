import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { GuardedDapSession } from '../src/dap/guarded-session.js';
import { runToStop, type RunToStopSession } from '../src/tools/run-to-stop.js';

const fixture = fileURLToPath(new URL('./fixtures/mock-dap-adapter.mjs', import.meta.url));

function mockStartOptions() {
  return {
    command: process.execPath,
    args: [fixture],
    adapterId: 'mock',
    requestTimeoutMs: 2_000,
  };
}

test('runToStop captures an immediate launch stop and returns a bounded snapshot', async (t) => {
  const session = new GuardedDapSession();
  t.after(async () => session.reset());

  await session.start(mockStartOptions());

  const result = await runToStop(session, {
    request: 'launch',
    configuration: { program: '/tmp/fake-app' },
    breakpoints: [{ source: '/tmp/main.cpp', lines: [42] }],
    timeoutMs: 2_000,
    snapshot: { includeModules: true },
  });

  assert.equal(result.request, 'launch');
  assert.equal(result.outcome.event, 'stopped');
  assert.deepEqual(result.outcome.body, {
    reason: 'entry',
    threadId: 1,
    allThreadsStopped: true,
  });
  assert.equal(result.snapshot?.thread.id, 1);
  assert.equal(result.snapshot?.frame.name, 'main');
  assert.equal(result.snapshot?.frame.line, 42);
  assert.equal(result.snapshot?.locals[0]?.name, 'answer');
  assert.equal(result.snapshot?.locals[0]?.value, '42');
  assert.equal(result.snapshot?.modules?.[0]?.name, 'fake-app');
});

test('runToStop captures a fast exit without attempting a runtime snapshot', async () => {
  const events = new EventEmitter();
  let snapshotCalls = 0;

  const session: RunToStopSession = {
    connection: events,
    async runExclusiveLifecycle<T>(_operation: string, action: () => Promise<T>): Promise<T> { return action(); },
    isPostmortem: () => false,
    async launch() {
      events.emit('event', {
        seq: 1,
        type: 'event',
        event: 'exited',
        body: { exitCode: 17 },
      });
      return { launched: true };
    },
    async attach() { throw new Error('attach should not be called'); },
    async runtimeSnapshot() {
      snapshotCalls += 1;
      throw new Error('snapshot should not be called after exit');
    },
    snapshot: () => ({ configured: true }),
  };

  const result = await runToStop(session, {
    configuration: { program: '/tmp/fast-exit' },
    timeoutMs: 1_000,
  });

  assert.equal(result.outcome.event, 'exited');
  assert.deepEqual(result.outcome.body, { exitCode: 17 });
  assert.equal(result.snapshot, undefined);
  assert.equal(snapshotCalls, 0);
});

test('runToStop preserves the original launch failure after the outcome wait already timed out', async () => {
  const events = new EventEmitter();
  const originalError = new Error('launch failed with actionable adapter detail');

  const session: RunToStopSession = {
    connection: events,
    async runExclusiveLifecycle<T>(_operation: string, action: () => Promise<T>): Promise<T> { return action(); },
    isPostmortem: () => false,
    async launch() {
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw originalError;
    },
    async attach() { throw new Error('attach should not be called'); },
    async runtimeSnapshot() { throw new Error('snapshot should not be called'); },
    snapshot: () => ({}),
  };

  await assert.rejects(
    runToStop(session, {
      configuration: { program: '/tmp/failing-app' },
      timeoutMs: 10,
    }),
    (error) => error === originalError,
  );
});

test('runToStop fails immediately when the adapter exits without a terminal DAP event', async () => {
  const events = new EventEmitter();
  const session: RunToStopSession = {
    connection: events,
    async runExclusiveLifecycle<T>(_operation: string, action: () => Promise<T>): Promise<T> { return action(); },
    isPostmortem: () => false,
    async launch() {
      events.emit('adapterExit', { code: 7, signal: null });
      return { launched: true };
    },
    async attach() { throw new Error('attach should not be called'); },
    async runtimeSnapshot() { throw new Error('snapshot should not be called'); },
    snapshot: () => ({}),
  };

  await assert.rejects(
    runToStop(session, {
      configuration: { program: '/tmp/adapter-died' },
      timeoutMs: 5_000,
    }),
    /adapter exited before stopped\/exited\/terminated/i,
  );
});

test('runToStop rejects live execution from a postmortem session', async () => {
  const events = new EventEmitter();
  const session: RunToStopSession = {
    connection: events,
    async runExclusiveLifecycle<T>(_operation: string, action: () => Promise<T>): Promise<T> { return action(); },
    isPostmortem: () => true,
    async launch() { throw new Error('launch should not be called'); },
    async attach() { throw new Error('attach should not be called'); },
    async runtimeSnapshot() { throw new Error('snapshot should not be called'); },
    snapshot: () => ({}),
  };

  await assert.rejects(
    runToStop(session, { configuration: { program: '/tmp/fake-app' } }),
    /Cannot run to stop in a postmortem crash-dump session/i,
  );
});
