import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { DapSession } from '../src/dap/session.js';

const fixture = fileURLToPath(new URL('./fixtures/mock-dap-adapter.mjs', import.meta.url));

test('runs a rich DAP debug workflow end-to-end', async (t) => {
  const session = new DapSession();
  t.after(async () => session.reset());

  const capabilities = await session.start({
    command: process.execPath,
    args: [fixture],
    adapterId: 'mock',
    requestTimeoutMs: 2_000,
  });

  assert.equal(capabilities.supportsConfigurationDoneRequest, true);
  assert.equal(capabilities.supportsModulesRequest, true);
  assert.equal(capabilities.supportsDisassembleRequest, true);
  assert.equal(capabilities.supportsReadMemoryRequest, true);
  assert.equal(capabilities.supportsExceptionInfoRequest, true);
  assert.equal(capabilities.supportsConditionalBreakpoints, true);
  assert.equal(capabilities.supportsFunctionBreakpoints, true);
  assert.equal(capabilities.supportsInstructionBreakpoints, true);
  assert.equal(capabilities.supportsDataBreakpoints, true);

  const exceptionBreakpoints = await session.setExceptionBreakpoints(
    ['mock_throw'],
    [{ filterId: 'mock_throw', condition: 'answer == 42' }],
  );
  assert.equal(exceptionBreakpoints[0]?.verified, true);

  const launch = await session.launch(
    { program: '/tmp/fake-app' },
    [{ source: '/tmp/main.cpp', lines: [42] }],
  );
  assert.equal((launch as { request: string }).request, 'launch');
  assert.equal(session.snapshot().configured, true);
  assert.equal(session.snapshot().activeRequest, 'launch');

  const advancedSource = await session.setSourceBreakpoints('/tmp/main.cpp', [
    { line: 42, condition: 'answer == 42', hitCondition: '>= 2', logMessage: 'answer={answer}' },
  ]);
  assert.equal(advancedSource[0]?.verified, true);
  assert.equal(advancedSource[0]?.line, 42);

  const functions = await session.setFunctionBreakpoints([{ name: 'main', condition: 'answer == 42' }]);
  assert.equal(functions[0]?.verified, true);

  const instructions = await session.setInstructionBreakpoints([
    { instructionReference: '0x1000', condition: 'answer == 42' },
  ]);
  assert.equal(instructions[0]?.verified, true);
  assert.equal(instructions[0]?.instructionReference, '0x1000');

  const threads = await session.threads();
  assert.deepEqual(threads, [{ id: 1, name: 'main' }]);

  const stack = await session.stackTrace(1);
  assert.equal(stack[0]?.name, 'main');
  assert.equal(stack[0]?.line, 42);
  assert.equal(stack[0]?.instructionPointerReference, '0x1000');

  const scopes = await session.scopes(100);
  assert.equal(scopes[0]?.variablesReference, 200);
  assert.equal(scopes[1]?.name, 'Registers');

  const variables = await session.variables(200);
  assert.equal(variables[0]?.name, 'answer');
  assert.equal(variables[0]?.value, '42');

  const dataInfo = await session.dataBreakpointInfo('answer', 200, 100);
  assert.equal(dataInfo.dataId, 'mock:answer');
  assert.deepEqual(dataInfo.accessTypes, ['read', 'write', 'readWrite']);

  const dataBreakpoints = await session.setDataBreakpoints([
    { dataId: dataInfo.dataId ?? 'mock:answer', accessType: 'write', condition: 'answer >= 0' },
  ]);
  assert.equal(dataBreakpoints[0]?.verified, true);

  const registers = await session.variables(300);
  assert.equal(registers[0]?.name, 'rip');
  assert.equal(registers[0]?.value, '0x1000');

  const evaluation = await session.evaluate('answer', 100);
  assert.equal(evaluation.result, '42');

  const modules = await session.modules();
  assert.equal(modules[0]?.name, 'fake-app');

  const disassembly = await session.disassemble('0x1000', 3, -1);
  assert.equal(disassembly.length, 3);
  assert.equal(disassembly[0]?.instruction, 'nop');

  const memory = await session.readMemory('0x1000', 4);
  assert.deepEqual([...Buffer.from(memory.data ?? '', 'base64')], [0x90, 0x90, 0xcc, 0xc3]);

  const exception = await session.exceptionInfo(1);
  assert.equal(exception.exceptionId, 'MOCK_ACCESS_VIOLATION');

  const snapshot = await session.runtimeSnapshot({ includeModules: true });
  assert.equal(snapshot.thread.id, 1);
  assert.equal(snapshot.frame.name, 'main');
  assert.equal(snapshot.locals[0]?.name, 'answer');
  assert.equal(snapshot.registers[0]?.name, 'rip');
  assert.equal(snapshot.disassembly?.length, 21);
  assert.equal(snapshot.modules?.[0]?.name, 'fake-app');

  const paused = await session.pause(1, true, 1_000) as { stopped: { reason: string } };
  assert.equal(paused.stopped.reason, 'pause');

  const continued = await session.continueExecution(1, true, 1_000) as { stopped: { reason: string } };
  assert.equal(continued.stopped.reason, 'breakpoint');

  const stepped = await session.step('next', 1, true, 1_000) as { stopped: { reason: string } };
  assert.equal(stepped.stopped.reason, 'step');

  await session.disconnect(true);
  assert.equal(session.snapshot().adapterRunning, false);
});

test('failed launch aligns initialized timeout, observes the parallel request, and clears stale session state', async (t) => {
  const session = new DapSession();
  t.after(async () => session.reset());

  await session.start({
    command: process.execPath,
    args: [fixture],
    adapterId: 'mock',
    requestTimeoutMs: 2_000,
  });

  let initializedTimeoutMs: number | undefined;
  let launchTimeoutMs: number | undefined;
  let launchRejectionObserved = false;

  const pendingLaunch = new Promise<never>(() => {});
  const originalCatch = pendingLaunch.catch.bind(pendingLaunch);
  pendingLaunch.catch = ((onRejected) => {
    launchRejectionObserved = true;
    return originalCatch(onRejected);
  }) as typeof pendingLaunch.catch;

  session.connection.waitForEvent = ((eventName: string, timeoutMs?: number) => {
    assert.equal(eventName, 'initialized');
    initializedTimeoutMs = timeoutMs;
    return Promise.reject(new Error('initialized event failed'));
  }) as typeof session.connection.waitForEvent;

  session.connection.sendRequest = ((command: string, _args?: unknown, timeoutMs?: number) => {
    assert.equal(command, 'launch');
    launchTimeoutMs = timeoutMs;
    return pendingLaunch;
  }) as typeof session.connection.sendRequest;

  await assert.rejects(
    session.launch({ program: '/tmp/slow-app' }),
    /initialized event failed/,
  );

  assert.equal(initializedTimeoutMs, 60_000);
  assert.equal(launchTimeoutMs, 60_000);
  assert.equal(launchRejectionObserved, true);
  assert.equal(session.snapshot().configured, false);
  assert.equal(session.snapshot().activeRequest, undefined);
});
