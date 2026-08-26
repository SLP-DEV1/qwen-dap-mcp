import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import type { DebugProtocol } from '@vscode/debugprotocol';
import type { GuardedDapSession } from '../src/dap/guarded-session.js';
import { findWriter } from '../src/tools/find-writer.js';

function snapshot(frameName: string): any {
  return {
    stopped: { reason: 'breakpoint', threadId: 7 },
    thread: { id: 7, name: 'main' },
    stack: [{ id: 101, name: frameName, line: 12, column: 1, instructionPointerReference: '0x1000' }],
    frame: { id: 101, name: frameName, line: 12, column: 1, instructionPointerReference: '0x1000' },
    scopes: [],
    locals: [],
    registers: [],
    disassembly: [],
  };
}

function stoppedConnection() {
  return new EventEmitter();
}

function emitWatchpointStop(connection: EventEmitter) {
  queueMicrotask(() => connection.emit('event', {
    seq: 1,
    type: 'event',
    event: 'stopped',
    body: { reason: 'data breakpoint', threadId: 7, description: 'watchpoint trigger' },
  } satisfies DebugProtocol.Event));
}

test('findWriter preserves prior native DAP watchpoints and reports the immediate writer stop', async () => {
  const calls: DebugProtocol.DataBreakpoint[][] = [];
  const previous: DebugProtocol.DataBreakpoint[] = [{ dataId: 'existing', accessType: 'write' }];
  let snapshotCount = 0;
  const connection = stoppedConnection();
  const session = {
    isPostmortem: () => false,
    runExclusiveLifecycle: async (_name: string, action: () => Promise<unknown>) => action(),
    runtimeSnapshot: async () => snapshot(++snapshotCount === 1 ? 'before' : 'write_counter'),
    dataBreakpointInfo: async () => ({ dataId: 'watch-counter', description: 'counter', accessTypes: ['write'], canPersist: false }),
    dataBreakpointConfiguration: () => previous.map((item) => ({ ...item })),
    setDataBreakpoints: async (breakpoints: DebugProtocol.DataBreakpoint[]) => {
      calls.push(breakpoints.map((item) => ({ ...item })));
      return breakpoints.map((_item, index) => ({ verified: true, id: index + 1 }));
    },
    connection,
    continueExecution: async () => {
      emitWatchpointStop(connection);
      return {};
    },
    pause: async () => ({}),
    snapshot: () => ({
      configured: true,
      adapterId: 'lldb-dap',
      capabilities: { supportsDataBreakpoints: true },
    }),
  } as unknown as GuardedDapSession;

  const output = await findWriter(session, { name: 'counter', accessType: 'write', timeoutMs: 1000 });
  assert.equal(output.strategy, 'dap-data-breakpoint');
  assert.equal(output.hitConfirmed, true);
  assert.equal(output.writerFrame?.name, 'write_counter');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], [previous[0], { dataId: 'watch-counter', accessType: 'write' }]);
  assert.deepEqual(calls[1], previous);
  assert.equal(connection.listenerCount('event'), 0);
});

test('findWriter uses a bounded GDB watch command and deletes only its own temporary watchpoint', async () => {
  const evaluateCalls: Array<{ expression: string; frameId?: number; context?: string }> = [];
  let snapshotCount = 0;
  const connection = stoppedConnection();
  const session = {
    isPostmortem: () => false,
    runExclusiveLifecycle: async (_name: string, action: () => Promise<unknown>) => action(),
    runtimeSnapshot: async () => snapshot(++snapshotCount === 1 ? 'before' : 'mutate_value'),
    dataBreakpointConfiguration: () => [],
    evaluate: async (expression: string, frameId?: number, context?: string) => {
      evaluateCalls.push({ expression, frameId, context });
      if (expression === 'watch watched_value') {
        return { result: 'Hardware watchpoint 3: watched_value', variablesReference: 0 };
      }
      if (expression === 'delete 3') {
        return { result: '', variablesReference: 0 };
      }
      throw new Error(`Unexpected GDB evaluate expression: ${expression}`);
    },
    connection,
    continueExecution: async () => {
      emitWatchpointStop(connection);
      return {};
    },
    pause: async () => ({}),
    snapshot: () => ({ configured: true, adapterId: 'gdb', capabilities: {} }),
  } as unknown as GuardedDapSession;

  const output = await findWriter(session, {
    name: 'watched_value',
    accessType: 'write',
    timeoutMs: 1000,
    replaceExistingDataBreakpoints: true,
  });

  assert.equal(output.strategy, 'gdb-watch');
  assert.equal(output.hitConfirmed, true);
  assert.equal(output.writerFrame?.name, 'mutate_value');
  assert.deepEqual(evaluateCalls, [
    { expression: 'watch watched_value', frameId: 101, context: 'repl' },
    { expression: 'delete 3', frameId: 101, context: 'repl' },
  ]);
  assert.equal(connection.listenerCount('event'), 0);
});

test('findWriter rejects control characters before issuing a bounded GDB watch command', async () => {
  let evaluateCalled = false;
  const session = {
    isPostmortem: () => false,
    runExclusiveLifecycle: async (_name: string, action: () => Promise<unknown>) => action(),
    runtimeSnapshot: async () => snapshot('before'),
    dataBreakpointConfiguration: () => [],
    evaluate: async () => {
      evaluateCalled = true;
      return { result: '', variablesReference: 0 };
    },
    connection: stoppedConnection(),
    continueExecution: async () => ({}),
    pause: async () => ({}),
    snapshot: () => ({ configured: true, adapterId: 'gdb', capabilities: {} }),
  } as unknown as GuardedDapSession;

  await assert.rejects(
    () => findWriter(session, { name: 'watched_value\ndelete 1', accessType: 'write', timeoutMs: 1000 }),
    /control characters or line breaks/i,
  );
  assert.equal(evaluateCalled, false);
});
