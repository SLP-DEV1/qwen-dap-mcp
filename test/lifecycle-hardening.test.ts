import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { DapConnection } from '../src/dap/connection.js';
import { GuardedDapSession } from '../src/dap/guarded-session.js';

const fixture = fileURLToPath(new URL('./fixtures/mock-dap-adapter.mjs', import.meta.url));

function mockStartOptions() {
  return {
    command: process.execPath,
    args: [fixture],
    adapterId: 'mock',
    requestTimeoutMs: 2_000,
  };
}

test('rejects overlapping launch or attach requests on the shared guarded session', async (t) => {
  const session = new GuardedDapSession();
  t.after(async () => session.reset());

  await session.start(mockStartOptions());

  const launch = session.launch({ program: '/tmp/fake-app' });

  await assert.rejects(
    session.attach({ processId: 1234 }),
    /lifecycle operation 'launch' is already in progress/i,
  );

  await launch;
});

test('serializes compound lifecycle transactions while allowing nested guarded calls', async (t) => {
  const session = new GuardedDapSession();
  t.after(async () => session.reset());

  let releaseGate!: () => void;
  let enteredGate!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const entered = new Promise<void>((resolve) => { enteredGate = resolve; });

  const openDumpLikeTransaction = session.runExclusiveLifecycle('open dump', async () => {
    await session.start(mockStartOptions());
    enteredGate();
    await gate;
    const attach = await session.attach({ coreFile: '/tmp/fake.core' });
    session.markPostmortem();
    return attach;
  });

  await entered;

  try {
    assert.equal(session.snapshot().lifecycleOperation, 'open dump');

    await assert.rejects(session.start(mockStartOptions()), /lifecycle operation 'open dump' is already in progress/i);
    await assert.rejects(session.launch({ program: '/tmp/other-app' }), /lifecycle operation 'open dump' is already in progress/i);
    await assert.rejects(session.attach({ processId: 4321 }), /lifecycle operation 'open dump' is already in progress/i);
    await assert.rejects(session.disconnect(), /lifecycle operation 'open dump' is already in progress/i);
    await assert.rejects(session.reset(), /lifecycle operation 'open dump' is already in progress/i);
  } finally {
    releaseGate();
  }

  await openDumpLikeTransaction;
  assert.equal(session.isPostmortem(), true);
  assert.equal(session.snapshot().lifecycleOperation, undefined);
});

test('isRunning remains true after a signal is sent until the adapter actually exits', () => {
  const connection = new DapConnection();
  const fakeChild = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: boolean;
  };
  fakeChild.exitCode = null;
  fakeChild.signalCode = null;
  fakeChild.killed = true;
  (connection as unknown as { child: unknown }).child = fakeChild;

  assert.equal(connection.isRunning, true);
  fakeChild.exitCode = 143;
  assert.equal(connection.isRunning, false);
});

test('isRunning becomes false when a child has terminated by signal even if exitCode remains null', () => {
  const connection = new DapConnection();
  const fakeChild = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: boolean;
  };
  fakeChild.exitCode = null;
  fakeChild.signalCode = 'SIGTERM';
  fakeChild.killed = true;
  (connection as unknown as { child: unknown }).child = fakeChild;

  assert.equal(connection.isRunning, false);
});

test('stop escalates to SIGKILL and waits for the final process exit', async () => {
  const connection = new DapConnection();
  const signals: Array<NodeJS.Signals | undefined> = [];

  const fakeChild = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: boolean;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  fakeChild.exitCode = null;
  fakeChild.signalCode = null;
  fakeChild.killed = false;
  fakeChild.kill = (signal?: NodeJS.Signals) => {
    signals.push(signal);
    fakeChild.killed = true;
    if (signal === 'SIGKILL') {
      setTimeout(() => {
        fakeChild.signalCode = 'SIGKILL';
        fakeChild.emit('exit', null, 'SIGKILL');
      }, 5);
    }
    return true;
  };

  (connection as unknown as { child: unknown }).child = fakeChild;

  await connection.stop();

  assert.deepEqual(signals, [undefined, 'SIGKILL']);
  assert.equal(fakeChild.signalCode, 'SIGKILL');
  assert.equal(connection.pid, undefined);
});

test('rejects an oversized DAP payload before buffering attacker-controlled body bytes', async () => {
  const connection = new DapConnection();
  const protocolError = new Promise<Error>((resolve) => connection.once('protocolError', resolve));

  (connection as unknown as { onStdout(chunk: Buffer): void }).onStdout(
    Buffer.from('Content-Length: 99999999\r\n\r\n', 'ascii'),
  );

  await assert.rejects(
    Promise.resolve().then(async () => { throw await protocolError; }),
    /safety limit/i,
  );
});
