import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildGdbDapLaunchConfiguration, discoverGdbDap } from '../src/adapters/gdb-dap.js';
import { GuardedDapSession } from '../src/dap/guarded-session.js';
import { findWriter } from '../src/tools/find-writer.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const adapterPath = arg('--adapter');
const programArg = arg('--program');
const sourceArg = arg('--source');

if (!programArg || !sourceArg) {
  throw new Error('Usage: tsx test/gdb-dap-real-smoke.ts --program <exe> --source <cpp> [--adapter <gdb>]');
}

const program = resolve(programArg);
const source = resolve(sourceArg);
const adapter = discoverGdbDap({ ...(adapterPath ? { explicitPath: adapterPath } : {}) });
const session = new GuardedDapSession();
const dapLogPath = '/tmp/qwen-dap-mcp-gdb-dap.log';

// Keep the real smoke self-diagnosing. These are GDB early-init options, not
// debuggee commands, and only enable GDB's own DAP protocol log for CI output.
adapter.args.push(
  '-iex',
  `set debug dap-log-file ${dapLogPath}`,
  '-iex',
  'set debug dap-log-level 2',
);

try {
  const capabilities = await session.start({
    command: adapter.command,
    args: adapter.args,
    adapterId: 'gdb',
    requestTimeoutMs: 30_000,
  });
  const stoppedPromise = session.connection.waitForEvent('stopped', 30_000);
  // Observe the parallel waiter immediately so a launch/configuration failure
  // cannot turn its later timeout into an unhandled rejection in node:test/CI.
  void stoppedPromise.catch(() => undefined);
  const launchResult = await session.launch(
    buildGdbDapLaunchConfiguration({ program, stopOnEntry: false }),
    [{ source, lines: [11] }],
  );
  const stopped = await stoppedPromise;
  const stoppedBody = stopped.body as { threadId?: number; reason?: string } | undefined;

  const initial = await session.runtimeSnapshot({
    ...(stoppedBody?.threadId ? { threadId: stoppedBody.threadId } : {}),
    stackLevels: 20,
    maxVariablesPerScope: 100,
    includeDisassembly: capabilities.supportsDisassembleRequest === true,
    includeModules: capabilities.supportsModulesRequest === true,
    includeExceptionInfo: false,
  });
  assert.match(initial.frame.name, /main/i, `Expected to stop in main, got '${initial.frame.name}'`);

  const before = await session.evaluate('watched_value', initial.frame.id, 'watch');
  assert.match(before.result, /7/, `Expected watched_value=7 before mutate_value(), got '${before.result}'`);

  console.error(JSON.stringify({
    diagnostic: 'before-debug-find-writer',
    adapter,
    stopped: stoppedBody,
    frame: initial.frame,
    watchedValueBefore: before.result,
    capabilities,
    recentEvents: session.snapshot().recentEvents,
  }, null, 2));

  const writer = await findWriter(session, {
    name: 'watched_value',
    frameId: initial.frame.id,
    accessType: 'write',
    timeoutMs: 30_000,
    replaceExistingDataBreakpoints: true,
    snapshot: {
      stackLevels: 20,
      maxVariablesPerScope: 100,
      includeDisassembly: capabilities.supportsDisassembleRequest === true,
      includeModules: capabilities.supportsModulesRequest === true,
      includeExceptionInfo: false,
    },
  });

  assert.equal(writer.strategy, 'gdb-watch', `Expected the bounded GDB watch fallback, got ${writer.strategy}`);
  assert.equal(writer.hitConfirmed, true, `Expected a GDB watchpoint stop, got ${JSON.stringify(writer.outcome)}`);
  assert.ok(writer.writerFrame, 'Writer workflow returned no writer frame');
  assert.match(writer.writerFrame.name, /mutate_value/i, `Expected mutate_value writer, got '${writer.writerFrame.name}'`);

  console.log(JSON.stringify({
    ok: true,
    adapter,
    capabilities: {
      supportsDataBreakpoints: capabilities.supportsDataBreakpoints,
      supportsDisassembleRequest: capabilities.supportsDisassembleRequest,
      supportsModulesRequest: capabilities.supportsModulesRequest,
      supportsExceptionInfoRequest: capabilities.supportsExceptionInfoRequest,
    },
    initialStop: stoppedBody,
    initialFrame: initial.frame,
    watchedValueBefore: before.result,
    writer: {
      strategy: writer.strategy,
      hitConfirmed: writer.hitConfirmed,
      outcome: writer.outcome,
      writerFrame: writer.writerFrame,
      guidance: writer.guidance,
    },
    launchResult,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    diagnostic: 'gdb-real-smoke-failure',
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    state: session.snapshot(),
  }, null, 2));
  if (existsSync(dapLogPath)) {
    console.error('--- GDB DAP LOG BEGIN ---');
    console.error(readFileSync(dapLogPath, 'utf8'));
    console.error('--- GDB DAP LOG END ---');
  }
  throw error;
} finally {
  await session.disconnect(true);
}
