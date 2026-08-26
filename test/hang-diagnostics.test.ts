import assert from 'node:assert/strict';
import test from 'node:test';
import type { DebugProtocol } from '@vscode/debugprotocol';

import {
  captureAllThreadHangEvidence,
  registerHangDiagnosticTool,
} from '../src/tools/hang-diagnostics.js';

function stackFrame(id: number, name: string): DebugProtocol.StackFrame {
  return { id, name, line: 1, column: 1 };
}

test('debug_this_hang pauses remaining threads when the existing stop is not global', async () => {
  let registration: {
    config: Record<string, unknown>;
    handler: (args: Record<string, unknown>) => Promise<unknown>;
  } | undefined;
  const server = {
    registerTool(
      _name: string,
      config: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) {
      registration = { config, handler };
      return { disable() {}, enable() {}, update() {}, remove() {} };
    },
  };

  const pauseCalls: Array<{ threadId: number; waitForStop: boolean }> = [];
  const threads: DebugProtocol.Thread[] = [
    { id: 1, name: 'already stopped' },
    { id: 2, name: 'still running' },
  ];
  const frames = new Map<number, DebugProtocol.StackFrame[]>([
    [1, [stackFrame(101, 'pthread_mutex_lock')]],
    [2, [stackFrame(201, '__lll_lock_wait')]],
  ]);

  const status = {
    adapterRunning: true,
    initialized: true,
    configured: true,
    activeRequest: 'attach' as const,
    recentEvents: [
      { event: 'stopped', body: { reason: 'pause', threadId: 1, allThreadsStopped: false } },
    ],
    recentAdapterStderr: [],
    postmortem: false,
  };

  const session = {
    runExclusiveLifecycle: async <T>(_name: string, action: () => Promise<T>) => action(),
    snapshot: () => status,
    isPostmortem: () => false,
    threads: async () => threads,
    pause: async (threadId: number, waitForStop: boolean) => {
      pauseCalls.push({ threadId, waitForStop });
      return {
        requestedAction: 'pause',
        stopped: { reason: 'pause', threadId, allThreadsStopped: threadId === 2 },
      };
    },
    stackTrace: async (threadId: number) => frames.get(threadId) ?? [],
    scopes: async (frameId: number) => [{
      name: 'Locals',
      presentationHint: 'locals' as const,
      variablesReference: frameId + 1000,
      expensive: false,
    }],
    variables: async (_reference: number) => [{
      name: 'mutex',
      value: '0x1234',
      type: 'Mutex *',
      variablesReference: 0,
    }],
  };

  registerHangDiagnosticTool(server as never, session as never);
  assert.ok(registration);

  const result = await registration.handler({
    mode: 'current',
    request: 'launch',
    requestTimeoutMs: 30_000,
    observeMs: 5_000,
    pauseTimeoutMs: 10_000,
    captureTimeoutMs: 30_000,
    maxThreads: 32,
    stackLevels: 24,
    maxVariablesPerFrame: 50,
    framesWithVariables: 2,
  }) as {
    structuredContent: {
      observation: { pause: { allThreadsStopped: boolean; requestedThreadIds: number[] } };
      evidence: Array<{ thread: { id: number } }>;
      diagnosis: { deadlock: { cycleProven: boolean } };
    };
  };

  assert.deepEqual(pauseCalls, [{ threadId: 2, waitForStop: true }]);
  assert.equal(result.structuredContent.observation.pause.allThreadsStopped, true);
  assert.deepEqual(result.structuredContent.observation.pause.requestedThreadIds, [2]);
  assert.deepEqual(result.structuredContent.evidence.map((item) => item.thread.id), [1, 2]);
  assert.equal(result.structuredContent.diagnosis.deadlock.cycleProven, false);

  const schema = registration.config.outputSchema as {
    safeParse(value: unknown): { success: boolean };
  };
  assert.equal(schema.safeParse(result.structuredContent).success, true);
});

test('all-thread evidence collection returns partial evidence at the global capture deadline', async () => {
  const threads: DebugProtocol.Thread[] = [
    { id: 1, name: 'stalled adapter request' },
    { id: 2, name: 'not reached' },
  ];
  let stackCalls = 0;
  const session = {
    threads: async () => threads,
    stackTrace: async (_threadId: number) => {
      stackCalls += 1;
      return await new Promise<DebugProtocol.StackFrame[]>(() => undefined);
    },
    scopes: async () => [],
    variables: async () => [],
  };

  const evidence = await Promise.race([
    captureAllThreadHangEvidence(session as never, {
      maxThreads: 2,
      captureTimeoutMs: 20,
    }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('capture deadline was not enforced')), 500);
    }),
  ]);

  assert.equal(evidence.length, 2);
  assert.equal(stackCalls, 1);
  assert.match(evidence[0]?.collectionErrors?.join(' ') ?? '', /capture deadline exceeded/i);
  assert.match(evidence[1]?.collectionErrors?.join(' ') ?? '', /capture deadline exceeded/i);
});