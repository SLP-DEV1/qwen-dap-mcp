import assert from 'node:assert/strict';
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

test('findWriter preserves prior watchpoints and reports the immediate writer stop', async () => {
  const calls: DebugProtocol.DataBreakpoint[][] = [];
  const previous: DebugProtocol.DataBreakpoint[] = [{ dataId: 'existing', accessType: 'write' }];
  let snapshotCount = 0;
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
    connection: {
      waitForEvent: async (event: string) => {
        if (event === 'stopped') return { body: { reason: 'data breakpoint', threadId: 7, description: 'watchpoint trigger' } };
        return new Promise(() => undefined);
      },
    },
    continueExecution: async () => ({}),
    pause: async () => ({}),
    snapshot: () => ({ configured: true }),
  } as unknown as GuardedDapSession;

  const output = await findWriter(session, { name: 'counter', accessType: 'write', timeoutMs: 1000 });
  assert.equal(output.hitConfirmed, true);
  assert.equal(output.writerFrame?.name, 'write_counter');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], [previous[0], { dataId: 'watch-counter', accessType: 'write' }]);
  assert.deepEqual(calls[1], previous);
});
