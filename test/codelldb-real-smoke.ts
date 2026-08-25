import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import {
  buildCodeLldbLaunchConfiguration,
  discoverCodeLldb,
} from '../src/adapters/codelldb.js';
import { DapSession } from '../src/dap/session.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const adapterPath = arg('--adapter');
const programArg = arg('--program');
const sourceArg = arg('--source');

if (!programArg || !sourceArg) {
  throw new Error('Usage: tsx test/codelldb-real-smoke.ts --program <exe> --source <cpp> [--adapter <codelldb>]');
}

const program = resolve(programArg);
const source = resolve(sourceArg);
const adapter = discoverCodeLldb({ ...(adapterPath ? { explicitPath: adapterPath } : {}) });
const session = new DapSession();

try {
  const capabilities = await session.start({
    command: adapter.command,
    adapterId: 'lldb',
    requestTimeoutMs: 30_000,
  });

  const stoppedPromise = session.connection.waitForEvent('stopped', 30_000);
  const launchResult = await session.launch(
    buildCodeLldbLaunchConfiguration({ program, stopOnEntry: false }),
    [{ source, lines: [8] }],
  );
  const stopped = await stoppedPromise;
  const stoppedBody = stopped.body as { threadId?: number; reason?: string } | undefined;

  const threads = await session.threads();
  const threadId = stoppedBody?.threadId ?? threads[0]?.id;
  assert.ok(threadId, 'CodeLLDB did not expose a stopped thread');

  const stack = await session.stackTrace(threadId, 0, 20);
  assert.ok(stack.length > 0, 'CodeLLDB returned an empty stack trace');
  const mainFrame = stack.find((frame) => /main/i.test(frame.name)) ?? stack[0];
  assert.ok(mainFrame, 'No stack frame was available');
  assert.ok(mainFrame.instructionPointerReference, 'CodeLLDB did not expose an instruction pointer reference');

  const scopes = await session.scopes(mainFrame.id);
  const locals = scopes.find((scope) => /local/i.test(scope.name)) ?? scopes.find((scope) => scope.variablesReference > 0);
  assert.ok(locals, 'CodeLLDB returned no variable scope');

  const variables = await session.variables(locals.variablesReference);
  const counter = variables.find((variable) => variable.name === 'counter');
  assert.ok(counter, `Expected local variable 'counter'. Saw: ${variables.map((variable) => variable.name).join(', ')}`);

  const evaluated = await session.evaluate('counter', mainFrame.id, 'watch');
  assert.match(evaluated.result, /35/, `Expected counter to be 35 before breakpoint line executes, got '${evaluated.result}'`);

  const advancedSource = await session.setSourceBreakpoints(source, [
    { line: 8, condition: 'counter == 35', hitCondition: '>= 1' },
  ]);
  assert.ok(advancedSource[0]?.verified, 'CodeLLDB did not verify the conditional source breakpoint');

  const functionBreakpoints = await session.setFunctionBreakpoints([{ name: 'main' }]);
  assert.ok(functionBreakpoints[0]?.verified, 'CodeLLDB did not verify the main function breakpoint');
  await session.setFunctionBreakpoints([]);

  const instructionBreakpoints = await session.setInstructionBreakpoints([
    { instructionReference: mainFrame.instructionPointerReference },
  ]);
  assert.ok(instructionBreakpoints[0]?.verified, 'CodeLLDB did not verify the instruction breakpoint');
  await session.setInstructionBreakpoints([]);

  await session.setExceptionBreakpoints(['cpp_throw']);

  const dataInfo = await session.dataBreakpointInfo('counter', locals.variablesReference, mainFrame.id);
  assert.ok(dataInfo.dataId, `CodeLLDB did not return a dataId for counter: ${JSON.stringify(dataInfo)}`);
  assert.ok(dataInfo.accessTypes?.includes('write') ?? true, 'CodeLLDB data breakpoint does not support write access');

  const dataBreakpoints = await session.setDataBreakpoints([
    { dataId: dataInfo.dataId, accessType: 'write' },
  ]);
  assert.ok(dataBreakpoints[0]?.verified, 'CodeLLDB did not verify the counter data breakpoint');

  const modules = await session.modules(0, 100);
  assert.ok(modules.length > 0, 'CodeLLDB returned no loaded modules');
  assert.ok(
    modules.some((module) => /native-smoke/i.test(module.name) || /native-smoke/i.test(module.path ?? '')),
    'The native smoke executable was not present in the module list',
  );

  const disassembly = await session.disassemble(mainFrame.instructionPointerReference, 11, -5);
  assert.ok(disassembly.length > 0, 'CodeLLDB returned no disassembly');
  assert.ok(disassembly.some((instruction) => instruction.instruction.length > 0), 'Disassembly instructions were empty');

  const memory = await session.readMemory(mainFrame.instructionPointerReference, 16);
  assert.ok(memory.data, 'CodeLLDB returned no readable memory bytes at the instruction pointer');
  assert.ok(Buffer.from(memory.data, 'base64').length > 0, 'Decoded memory payload was empty');

  const initialSnapshot = await session.runtimeSnapshot({
    threadId,
    includeModules: true,
    moduleCount: 100,
    disassembleBefore: 5,
    disassembleAfter: 5,
  });
  assert.match(initialSnapshot.frame.name, /main/i, 'Runtime snapshot did not select the main frame');
  assert.ok(initialSnapshot.locals.some((variable) => variable.name === 'counter'), 'Runtime snapshot missed local variable counter');
  assert.ok(initialSnapshot.registers.length > 0, 'Runtime snapshot did not capture CodeLLDB registers');
  assert.ok(initialSnapshot.disassembly && initialSnapshot.disassembly.length > 0, 'Runtime snapshot did not capture disassembly');
  assert.ok(initialSnapshot.modules && initialSnapshot.modules.length > 0, 'Runtime snapshot did not capture modules');

  await session.setSourceBreakpoints(source, []);
  const watchStop = await session.continueExecution(threadId, true, 10_000) as {
    stopped: { reason?: string; description?: string };
  };
  assert.match(
    `${watchStop.stopped.reason ?? ''} ${watchStop.stopped.description ?? ''}`,
    /data|watch|breakpoint/i,
    `Expected a data/watchpoint stop, got ${JSON.stringify(watchStop.stopped)}`,
  );

  const watchSnapshot = await session.runtimeSnapshot({ threadId, includeModules: false });
  const watchedCounter = watchSnapshot.locals.find((variable) => variable.name === 'counter');
  assert.ok(watchedCounter, 'Watchpoint snapshot lost local counter');
  await session.setDataBreakpoints([]);

  // The fixture sleeps after printing, giving a running target for a real DAP pause request.
  await session.continueExecution(threadId, false);
  const pauseResult = await session.pause(threadId, true, 5_000) as {
    requestedAction: string;
    stopped: { reason?: string; description?: string };
  };
  assert.equal(pauseResult.requestedAction, 'pause');
  const rawPauseText = `${pauseResult.stopped.reason ?? ''} ${pauseResult.stopped.description ?? ''}`;
  // On Windows CodeLLDB/LLDB implements pause via DebugBreak, surfaced as exception 0x80000003.
  assert.match(rawPauseText, /pause|0x80000003|debugbreak/i, `Unexpected pause stop: ${JSON.stringify(pauseResult.stopped)}`);

  const pausedSnapshot = await session.runtimeSnapshot({ threadId, includeDisassembly: true, includeExceptionInfo: true });
  assert.ok(pausedSnapshot.stack.length > 0, 'Paused snapshot returned no stack');
  if (pauseResult.stopped.reason === 'exception') {
    assert.ok(pausedSnapshot.exception, 'DebugBreak-style pause did not include exception info in the snapshot');
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        adapter,
        capabilities: {
          supportsConfigurationDoneRequest: capabilities.supportsConfigurationDoneRequest,
          supportsEvaluateForHovers: capabilities.supportsEvaluateForHovers,
          supportsDisassembleRequest: capabilities.supportsDisassembleRequest,
          supportsReadMemoryRequest: capabilities.supportsReadMemoryRequest,
          supportsModulesRequest: capabilities.supportsModulesRequest,
          supportsExceptionInfoRequest: capabilities.supportsExceptionInfoRequest,
          supportsConditionalBreakpoints: capabilities.supportsConditionalBreakpoints,
          supportsFunctionBreakpoints: capabilities.supportsFunctionBreakpoints,
          supportsInstructionBreakpoints: capabilities.supportsInstructionBreakpoints,
          supportsDataBreakpoints: capabilities.supportsDataBreakpoints,
        },
        stopped: stoppedBody,
        topFrame: mainFrame,
        localNames: variables.map((variable) => variable.name),
        evaluatedCounter: evaluated.result,
        moduleCount: modules.length,
        disassemblyCount: disassembly.length,
        memoryBytes: Buffer.from(memory.data ?? '', 'base64').length,
        advancedBreakpoints: {
          conditionalSourceVerified: advancedSource[0]?.verified ?? false,
          functionVerified: functionBreakpoints[0]?.verified ?? false,
          instructionVerified: instructionBreakpoints[0]?.verified ?? false,
        },
        dataBreakpoint: {
          info: dataInfo,
          stopped: watchStop.stopped,
          counterAfterWrite: watchedCounter.value,
        },
        pause: {
          requestedAction: pauseResult.requestedAction,
          rawStopped: pauseResult.stopped,
          exception: pausedSnapshot.exception,
          topFrame: pausedSnapshot.frame,
        },
        snapshot: {
          thread: initialSnapshot.thread,
          frame: initialSnapshot.frame,
          localNames: initialSnapshot.locals.map((variable) => variable.name),
          registerCount: initialSnapshot.registers.length,
          disassemblyCount: initialSnapshot.disassembly?.length ?? 0,
          moduleCount: initialSnapshot.modules?.length ?? 0,
        },
        launchResult,
      },
      null,
      2,
    ),
  );
} finally {
  await session.disconnect(true);
}
