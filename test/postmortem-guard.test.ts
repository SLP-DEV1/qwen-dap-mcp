import assert from 'node:assert/strict';
import test from 'node:test';

import { GuardedDapSession } from '../src/dap/guarded-session.js';

test('postmortem sessions reject live execution controls', async () => {
  const session = new GuardedDapSession();
  session.markPostmortem();

  assert.equal(session.isPostmortem(), true);
  assert.equal(session.snapshot().postmortem, true);

  await assert.rejects(() => session.pause(1), /postmortem crash-dump session/);
  await assert.rejects(() => session.continueExecution(1), /postmortem crash-dump session/);
  await assert.rejects(() => session.step('next', 1), /postmortem crash-dump session/);
  await assert.rejects(() => session.dataBreakpointInfo('counter', 1, 1), /postmortem crash-dump session/);
  await assert.rejects(() => session.setDataBreakpoints([]), /postmortem crash-dump session/);
});
