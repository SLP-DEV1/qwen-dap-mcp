import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { buildLldbDapLaunchConfiguration, discoverLldbDap } from '../src/adapters/lldb-dap.js';
import { DapSession } from '../src/dap/session.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const adapterPath = arg('--adapter');
const programArg = arg('--program');
const sourceArg = arg('--source');

if (!programArg || !sourceArg) {
  throw new Error('Usage: tsx test/lldb-dap-real-smoke.ts --program <exe> --source <cpp> [--adapter <lldb-dap>]');
}

const program = resolve(programArg);
const source = resolve(sourceArg);
const adapter = discoverLldbDap({ ...(adapterPath ? { explicitPath: adapterPath } : {}) });
const session = new DapSession();

try {
  const capabilities = await session.start({
    command: adapter.command,
    adapterId: 'lldb-dap',
    requestTimeoutMs: 30_000,
  });

  const stoppedPromise = session.connection.waitForEvent('stopped', 30_000);
  const launchResult = await session.launch(
    buildLldbDapLaunchConfiguration({ program, stopOnEntry: false }),
    [{ source, lines: [8] }],
  );
  const stopped = await stoppedPromise;
  const stoppedBody = stopped.body as { threadId?: number; reason?: string } | undefined;

  const threads = await session.threads();
  const threadId = stoppedBody?.threadId ?? threads[0]?.id;
  assert.ok(threadId, 'lldb-dap did not expose a stopped thread');

  const stack = await session.stackTrace(threadId, 0, 20);
  assert.ok(stack.length > 0, 'lldb-dap returned an empty stack trace');
  const mainFrame = stack.find((frame) => /main/i.test(frame.name)) ?? stack[0];
  assert.ok(mainFrame, 'lldb-dap returned no stack frame');

  const scopes = await session.scopes(mainFrame.id);
  const localScope = scopes.find((scope) => /local/i.test(scope.name))
    ?? scopes.find((scope) => scope.variablesReference > 0);
  assert.ok(localScope, 'lldb-dap returned no variable scope');

  const variables = await session.variables(localScope.variablesReference);
  const counter = variables.find((variable) => variable.name === 'counter');
  assert.ok(counter, `Expected local variable 'counter'. Saw: ${variables.map((variable) => variable.name).join(', ')}`);

  const evaluated = await session.evaluate('counter', mainFrame.id, 'watch');
  assert.match(evaluated.result, /35/, `Expected counter to be 35 before line 8 executes, got '${evaluated.result}'`);

  const snapshot = await session.runtimeSnapshot({
    threadId,
    stackLevels: 20,
    maxVariablesPerScope: 100,
    includeDisassembly: capabilities.supportsDisassembleRequest === true,
    includeModules: capabilities.supportsModulesRequest === true,
    includeExceptionInfo: false,
  });
  assert.match(snapshot.frame.name, /main/i, 'Runtime snapshot did not select main');
  assert.ok(snapshot.locals.some((variable) => variable.name === 'counter'), 'Runtime snapshot missed counter');
  assert.ok(snapshot.registers.length > 0, 'Runtime snapshot did not capture registers');

  console.log(JSON.stringify({
    ok: true,
    adapter,
    stopped: stoppedBody,
    topFrame: mainFrame,
    evaluatedCounter: evaluated.result,
    localNames: variables.map((variable) => variable.name),
    capabilities: {
      supportsConfigurationDoneRequest: capabilities.supportsConfigurationDoneRequest,
      supportsDisassembleRequest: capabilities.supportsDisassembleRequest,
      supportsModulesRequest: capabilities.supportsModulesRequest,
      supportsExceptionInfoRequest: capabilities.supportsExceptionInfoRequest,
    },
    snapshot: {
      frame: snapshot.frame,
      localNames: snapshot.locals.map((variable) => variable.name),
      registerCount: snapshot.registers.length,
      disassemblyCount: snapshot.disassembly?.length ?? 0,
      moduleCount: snapshot.modules?.length ?? 0,
    },
    launchResult,
  }, null, 2));
} finally {
  await session.disconnect(true);
}
