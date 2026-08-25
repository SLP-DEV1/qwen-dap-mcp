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
const adapter = discoverCodeLldb({
  ...(adapterPath ? { explicitPath: adapterPath } : {}),
});

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
    [{ source, lines: [6] }],
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

  const scopes = await session.scopes(mainFrame.id);
  const locals = scopes.find((scope) => /local/i.test(scope.name)) ?? scopes.find((scope) => scope.variablesReference > 0);
  assert.ok(locals, 'CodeLLDB returned no variable scope');

  const variables = await session.variables(locals.variablesReference);
  const counter = variables.find((variable) => variable.name === 'counter');
  assert.ok(counter, `Expected local variable 'counter'. Saw: ${variables.map((variable) => variable.name).join(', ')}`);

  const evaluated = await session.evaluate('counter', mainFrame.id, 'watch');
  assert.match(evaluated.result, /35/, `Expected counter to be 35 before breakpoint line executes, got '${evaluated.result}'`);

  await session.continueExecution(threadId, false);

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
        },
        stopped: stoppedBody,
        topFrame: mainFrame,
        localNames: variables.map((variable) => variable.name),
        evaluatedCounter: evaluated.result,
        launchResult,
      },
      null,
      2,
    ),
  );
} finally {
  await session.disconnect(false);
}
