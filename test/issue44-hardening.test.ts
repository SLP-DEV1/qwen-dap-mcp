import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { DapConnection } from '../src/dap/connection.js';
import { DapSession } from '../src/dap/session.js';
import { filterToolRegistrar, resolveToolsetMode } from '../src/toolset.js';

type TestableConnection = DapConnection & { onStdout(chunk: Buffer): void };

function fakeChild(exited = false) {
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: boolean;
    kill(signal?: NodeJS.Signals): boolean;
    stdin: { write(chunk: Buffer): boolean };
  };
  child.exitCode = exited ? 0 : null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  child.stdin = { write: () => true };
  return child;
}

test('explicit connection stop rejects in-flight event waiters without relying on a child exit callback', async () => {
  const connection = new DapConnection();
  (connection as unknown as { child: unknown }).child = fakeChild(true);
  const waiter = connection.waitForEvent('stopped', 10_000);
  await connection.stop();
  await assert.rejects(waiter, /adapter exited while waiting for event 'stopped'/i);
});

test('malformed DAP framing is fatal and rejects event waiters immediately', async () => {
  const connection = new DapConnection() as TestableConnection;
  const waiter = connection.waitForEvent('stopped', 10_000);
  connection.onStdout(Buffer.from('X-Test: missing-length\r\n\r\n{}', 'ascii'));
  await assert.rejects(waiter, /invalid DAP header/i);
  assert.equal(connection.recentEvents.length, 0);
});

test('invalid toolset values fall back to agent and hidden tools return a stable no-op handle', () => {
  assert.equal(resolveToolsetMode('definitely-not-a-toolset'), 'agent');
  const registered: string[] = [];
  const registrar = { registerTool(name: string) { registered.push(name); return { name }; } };
  const agent = filterToolRegistrar(registrar, 'agent');
  const handle = agent.registerTool('debug_evaluate');
  assert.deepEqual(registered, []);
  assert.equal(typeof handle.disable, 'function');
  assert.equal(typeof handle.enable, 'function');
  assert.equal(typeof handle.update, 'function');
  assert.equal(typeof handle.remove, 'function');
  assert.doesNotThrow(() => { handle.disable(); handle.enable(); handle.update({ enabled: false }); handle.remove(); });
});

test('raw memory and disassembly inputs are bounded before reaching the adapter', async () => {
  const session = new DapSession();
  (session.connection as unknown as { child: unknown }).child = fakeChild(false);
  const internals = session as unknown as { initialized: boolean; configured: boolean; capabilities: Record<string, boolean> };
  internals.initialized = true;
  internals.configured = true;
  internals.capabilities = { supportsReadMemoryRequest: true, supportsDisassembleRequest: true };
  let requests = 0;
  session.connection.sendRequest = (async () => { requests += 1; throw new Error('validation should prevent adapter request'); }) as typeof session.connection.sendRequest;

  await assert.rejects(session.readMemory('0x1000', 0), /count must be a safe integer between 1 and 1048576/i);
  await assert.rejects(session.readMemory('0x1000', 1048577), /count must be a safe integer/i);
  await assert.rejects(session.readMemory('0x1000', 4, Number.NaN), /offset must be a safe integer/i);
  await assert.rejects(session.disassemble('0x1000', 0), /instructionCount must be a safe integer between 1 and 10000/i);
  await assert.rejects(session.disassemble('0x1000', 10001), /instructionCount must be a safe integer/i);
  await assert.rejects(session.disassemble('0x1000', 4, 2147483648), /instructionOffset must be a safe integer/i);
  assert.equal(requests, 0);
  (session.connection as unknown as { child: unknown }).child = undefined;
});
