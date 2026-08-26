import assert from 'node:assert/strict';
import test from 'node:test';
import type { DebugProtocol } from '@vscode/debugprotocol';

import {
  analyzeHang,
  classifyThreadWait,
  type HangThreadEvidence,
} from '../src/diagnostics/hang-analysis.js';

function frame(
  id: number,
  name: string,
  sourcePath?: string,
): DebugProtocol.StackFrame {
  return {
    id,
    name,
    line: 1,
    column: 1,
    ...(sourcePath ? { source: { path: sourcePath, name: sourcePath.split('/').pop() } } : {}),
  };
}

function variable(
  name: string,
  value: string,
  type?: string,
  memoryReference?: string,
): DebugProtocol.Variable {
  return {
    name,
    value,
    variablesReference: 0,
    ...(type ? { type } : {}),
    ...(memoryReference ? { memoryReference } : {}),
  };
}

function evidence(
  threadId: number,
  threadName: string,
  stack: DebugProtocol.StackFrame[],
  variables: DebugProtocol.Variable[] = [],
): HangThreadEvidence {
  return {
    thread: { id: threadId, name: threadName },
    stack,
    variableFrames: stack[0]
      ? [{ frameIndex: 0, frame: stack[0], variables }]
      : [],
  };
}

test('classifies common synchronization and I/O wait primitives', () => {
  const mutex = evidence(1, 'mutex waiter', [frame(1, 'pthread_mutex_lock')]);
  const io = evidence(2, 'io waiter', [frame(2, 'epoll_wait')]);

  assert.deepEqual(
    { kind: classifyThreadWait(mutex).kind, blocked: classifyThreadWait(mutex).blocked },
    { kind: 'mutex', blocked: true },
  );
  assert.deepEqual(
    { kind: classifyThreadWait(io).kind, blocked: classifyThreadWait(io).blocked },
    { kind: 'io', blocked: true },
  );
});

test('reports a deadlock candidate without pretending a lock cycle is proven', () => {
  const result = analyzeHang([
    evidence(1, 'a', [frame(1, 'pthread_mutex_lock')]),
    evidence(2, 'b', [frame(2, '__lll_lock_wait')]),
  ]);

  assert.equal(result.classification, 'deadlock-candidate');
  assert.equal(result.confidence, 'medium');
  assert.equal(result.deadlock.cycleProven, false);
  assert.equal(result.deadlock.ownershipGraphAvailable, false);
  assert.deepEqual(result.deadlock.blockedThreadIds, [1, 2]);
});

test('does not promote ordinary condition-variable worker waits to deadlock', () => {
  const result = analyzeHang([
    evidence(1, 'worker-1', [frame(1, 'pthread_cond_wait')]),
    evidence(2, 'worker-2', [frame(2, 'std::condition_variable::wait')]),
  ]);

  assert.equal(result.classification, 'global-wait');
  assert.equal(result.deadlock.cycleProven, false);
});

test('Pointer-Provenance v2 groups synchronization aliases across threads', () => {
  const result = analyzeHang([
    evidence(
      1,
      'a',
      [frame(1, 'pthread_mutex_lock')],
      [variable('mutex', '0x0000000000001234', 'pthread_mutex_t *')],
    ),
    evidence(
      2,
      'b',
      [frame(2, '__lll_lock_wait')],
      [variable('lock_ptr', 'opaque', 'Mutex *', '0x1234')],
    ),
  ]);

  assert.equal(result.pointerProvenance.version, 2);
  const group = result.pointerProvenance.groups.find((item) => item.address === '0x1234');
  assert.ok(group);
  assert.equal(group.sharedAcrossThreads, true);
  assert.equal(group.synchronizationRelevant, true);
  assert.deepEqual(group.threadIds, [1, 2]);
  assert.deepEqual(new Set(group.aliases), new Set(['lock_ptr', 'mutex']));
});

test('a runnable project top frame suppresses the deadlock-candidate classification', () => {
  const result = analyzeHang([
    evidence(1, 'waiter', [frame(1, 'pthread_mutex_lock')]),
    evidence(2, 'worker', [frame(2, 'project::event_loop', '/repo/src/main.cpp')]),
  ], { projectRoots: ['/repo'] });

  assert.equal(result.classification, 'mixed-wait');
  assert.deepEqual(result.deadlock.runnableProjectThreadIds, [2]);
});

test('a deeper project frame does not prove the thread is currently running project code', () => {
  const thread = evidence(1, 'worker', [
    frame(1, 'mystery_runtime_wait'),
    frame(2, 'project::event_loop', '/repo/src/main.cpp'),
  ]);

  const wait = classifyThreadWait(thread, { projectRoots: ['/repo'] });
  assert.equal(wait.kind, 'unknown');
  assert.equal(wait.blocked, false);
  assert.match(wait.rationale.join(' '), /deeper project frame/i);
});

test('unclassified threads prevent promotion to deadlock-candidate', () => {
  const result = analyzeHang([
    evidence(1, 'a', [frame(1, 'pthread_mutex_lock')]),
    evidence(2, 'b', [frame(2, '__lll_lock_wait')]),
    evidence(3, 'unknown', [frame(3, 'mystery_runtime_wait')]),
  ]);

  assert.equal(result.classification, 'mixed-wait');
  assert.equal(result.deadlock.cycleProven, false);
  assert.match(result.deadlock.evidence.join(' '), /remain unclassified/i);
});

test('all-thread blocking I/O is classified separately from deadlock', () => {
  const result = analyzeHang([
    evidence(1, 'io-1', [frame(1, 'epoll_wait')]),
    evidence(2, 'io-2', [frame(2, 'recv')]),
  ]);

  assert.equal(result.classification, 'io-wait');
  assert.equal(result.confidence, 'high');
});