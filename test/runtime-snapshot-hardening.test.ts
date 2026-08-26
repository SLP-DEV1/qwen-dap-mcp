import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { DebugProtocol } from '@vscode/debugprotocol';

import { DapSession } from '../src/dap/session.js';

const fixture = fileURLToPath(new URL('./fixtures/mock-dap-adapter.mjs', import.meta.url));

function mockStartOptions() {
  return {
    command: process.execPath,
    args: [fixture],
    adapterId: 'mock',
    requestTimeoutMs: 2_000,
  };
}

test('runtimeSnapshot collects separate Locals and Arguments scopes and records optional enrichment failures', async (t) => {
  const session = new DapSession();
  t.after(async () => session.reset());
  await session.start(mockStartOptions());
  await session.launch({ program: '/tmp/fake-app' });

  session.scopes = (async () => [
    { name: 'Locals', variablesReference: 200, expensive: false },
    { name: 'Registers', variablesReference: 300, expensive: false },
    { name: 'Arguments', variablesReference: 201, expensive: false },
  ]) as typeof session.scopes;

  session.variables = (async (variablesReference: number) => {
    if (variablesReference === 200) {
      return [{ name: 'localValue', value: '42', type: 'int', variablesReference: 0 }];
    }
    if (variablesReference === 201) {
      return [{ name: 'inputPtr', value: '0x1234', type: 'Widget *', variablesReference: 0 }];
    }
    if (variablesReference === 300) {
      return [{ name: 'rip', value: '0x1000', variablesReference: 0 }];
    }
    return [];
  }) as typeof session.variables;

  session.disassemble = (async () => {
    throw new Error('synthetic disassembly failure');
  }) as typeof session.disassemble;
  session.modules = (async () => {
    throw new Error('synthetic modules failure');
  }) as typeof session.modules;

  const snapshot = await session.runtimeSnapshot({ includeModules: true });

  assert.deepEqual(snapshot.locals.map((item) => item.name), ['localValue', 'inputPtr']);
  assert.equal(snapshot.registers[0]?.name, 'rip');
  assert.equal(snapshot.disassembly, undefined);
  assert.equal(snapshot.modules, undefined);
  assert.ok(snapshot.collectionErrors?.some((item) => item.operation === 'disassembly'));
  assert.ok(snapshot.collectionErrors?.some((item) => item.operation === 'modules'));
});

test('variables rejects the DAP zero sentinel instead of sending an invalid expand request', async (t) => {
  const session = new DapSession();
  t.after(async () => session.reset());
  await session.start(mockStartOptions());
  await session.launch({ program: '/tmp/fake-app' });

  await assert.rejects(session.variables(0), /variablesReference must be a positive safe integer/i);
});
