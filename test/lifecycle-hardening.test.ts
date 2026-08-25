import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { DapConnection } from '../src/dap/connection.js';
import { GuardedDapSession } from '../src/dap/guarded-session.js';

const fixture = fileURLToPath(new URL('./fixtures/mock-dap-adapter.mjs', import.meta.url));

test('rejects overlapping launch or attach requests on the shared guarded session', async (t) => {
  const session = new GuardedDapSession();
  t.after(async () => session.reset());

  await session.start({
    command: process.execPath,
    args: [fixture],
    adapterId: 'mock',
    requestTimeoutMs: 2_000,
  });

  const launch = session.launch({ program: '/tmp/fake-app' });

  await assert.rejects(
    session.attach({ processId: 1234 }),
    /another launch or attach request is already in progress/i,
  );

  await launch;
});

test('stop escalates to SIGKILL when a signalled adapter has not exited', async () => {
  const connection = new DapConnection();
  const signals: Array<NodeJS.Signals | undefined> = [];

  const fakeChild = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    killed: boolean;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  fakeChild.exitCode = null;
  fakeChild.killed = true;
  fakeChild.kill = (signal?: NodeJS.Signals) => {
    signals.push(signal);
    return true;
  };

  (connection as unknown as { child: unknown }).child = fakeChild;

  await connection.stop();

  assert.deepEqual(signals, ['SIGKILL']);
});
