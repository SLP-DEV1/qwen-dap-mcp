import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { DapSession } from '../src/dap/session.js';

const fixture = fileURLToPath(new URL('./fixtures/mock-dap-adapter.mjs', import.meta.url));

test('runs a minimal DAP debug workflow end-to-end', async (t) => {
  const session = new DapSession();
  t.after(async () => session.reset());

  const capabilities = await session.start({
    command: process.execPath,
    args: [fixture],
    adapterId: 'mock',
    requestTimeoutMs: 2_000,
  });

  assert.equal(capabilities.supportsConfigurationDoneRequest, true);

  const launch = await session.launch(
    { program: '/tmp/fake-app' },
    [{ source: '/tmp/main.cpp', lines: [42] }],
  );
  assert.equal((launch as { request: string }).request, 'launch');

  const threads = await session.threads();
  assert.deepEqual(threads, [{ id: 1, name: 'main' }]);

  const stack = await session.stackTrace(1);
  assert.equal(stack[0]?.name, 'main');
  assert.equal(stack[0]?.line, 42);

  const scopes = await session.scopes(100);
  assert.equal(scopes[0]?.variablesReference, 200);

  const variables = await session.variables(200);
  assert.equal(variables[0]?.name, 'answer');
  assert.equal(variables[0]?.value, '42');

  const evaluation = await session.evaluate('answer', 100);
  assert.equal(evaluation.result, '42');

  const continued = await session.continueExecution(1, true, 1_000) as {
    stopped: { reason: string };
  };
  assert.equal(continued.stopped.reason, 'breakpoint');

  const stepped = await session.step('next', 1, true, 1_000) as {
    stopped: { reason: string };
  };
  assert.equal(stepped.stopped.reason, 'step');

  await session.disconnect(true);
  assert.equal(session.snapshot().adapterRunning, false);
});
