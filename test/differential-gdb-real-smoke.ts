import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { buildGdbDapLaunchConfiguration, discoverGdbDap } from '../src/adapters/gdb-dap.js';
import { DapSessionRegistry } from '../src/dap/session-registry.js';
import type { RuntimeSnapshotOptions } from '../src/dap/session.js';
import { registerDifferentialTools } from '../src/tools/register-differential-tools.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const programArg = arg('--program');
const sourceArg = arg('--source');
const adapterPath = arg('--adapter');
if (!programArg || !sourceArg) {
  throw new Error('Usage: tsx test/differential-gdb-real-smoke.ts --program <exe> --source <cpp> [--adapter <gdb>]');
}

const program = resolve(programArg);
const source = resolve(sourceArg);
const registry = new DapSessionRegistry({ maxSessions: 4 });
const baseline = registry.create('baseline').session;
const candidate = registry.create('candidate').session;

let compareHandler: ((args: any) => Promise<any>) | undefined;
const registrar = {
  registerTool(name: string, _config: unknown, handler: (args: any) => Promise<any>) {
    if (name === 'debug_compare_runs') compareHandler = handler;
    return { disable() {}, enable() {}, update() {}, remove() {} };
  },
};
registerDifferentialTools(registrar as never, registry);
assert.ok(compareHandler, 'debug_compare_runs was not registered');

async function prepareStoppedSession(
  session: typeof baseline,
  mode: 'good' | 'bad',
): Promise<void> {
  const adapter = discoverGdbDap({ ...(adapterPath ? { explicitPath: adapterPath } : {}) });
  await session.start({
    command: adapter.command,
    args: adapter.args,
    adapterId: 'gdb',
    requestTimeoutMs: 30_000,
  });

  const stoppedPromise = session.connection.waitForEvent('stopped', 30_000);
  void stoppedPromise.catch(() => undefined);
  await session.launch(
    buildGdbDapLaunchConfiguration({ program, args: [mode], stopOnEntry: false }),
    [{ source, lines: [7] }],
  );
  const stopped = await stoppedPromise;
  const body = stopped.body as { threadId?: number; reason?: string } | undefined;
  assert.equal(body?.reason, 'breakpoint', `${mode} session did not stop at the source breakpoint`);

  const snapshot = await session.runtimeSnapshot({
    ...(body?.threadId ? { threadId: body.threadId } : {}),
    stackLevels: 4,
    maxVariablesPerScope: 50,
    includeDisassembly: false,
    includeModules: false,
    includeExceptionInfo: false,
  });
  assert.match(snapshot.frame.name, /inspect_case/i, `${mode} session stopped in unexpected frame '${snapshot.frame.name}'`);
  assert.match(
    snapshot.stack[1]?.name ?? '',
    mode === 'good' ? /good_path/i : /bad_path/i,
    `${mode} session did not preserve the expected caller path: ${JSON.stringify(snapshot.stack)}`,
  );
}

const snapshot: RuntimeSnapshotOptions = {
  stackLevels: 12,
  maxVariablesPerScope: 100,
  includeDisassembly: false,
  includeModules: true,
  moduleCount: 100,
  includeExceptionInfo: false,
};

try {
  await Promise.all([
    prepareStoppedSession(baseline, 'good'),
    prepareStoppedSession(candidate, 'bad'),
  ]);

  const result = await compareHandler!({
    baselineSessionId: 'baseline',
    candidateSessionId: 'candidate',
    timeoutMs: 30_000,
    snapshot,
  });

  assert.equal(result?.isError, undefined, `debug_compare_runs failed: ${JSON.stringify(result)}`);
  const output = result.structuredContent as any;
  assert.equal(output.baselineSessionId, 'baseline');
  assert.equal(output.candidateSessionId, 'candidate');

  const callerDifference = output.diff.stack.frames.find((item: any) =>
    item.index === 1
    && item.status === 'changed'
    && /good_path/i.test(String(item.baseline?.function ?? ''))
    && /bad_path/i.test(String(item.candidate?.function ?? '')),
  );
  assert.ok(callerDifference, `expected stable caller-stack divergence: ${JSON.stringify(output.diff.stack.frames)}`);
  assert.ok(output.diff.summary.meaningfulDifferences >= 1);
  assert.equal(output.evidenceBudget.stackLevels, 12);
  assert.equal(output.evidenceBudget.maxVariablesPerScope, 100);

  const critical = output.diff.locals.find((item: any) => item.name === 'critical_ptr');
  if (critical) {
    assert.notEqual(critical.status, 'unstable', `nullability evidence must not be reduced to address noise: ${JSON.stringify(critical)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    firstMeaningfulDifference: output.diff.firstMeaningfulDifference,
    callerDifference,
    criticalPointerDiff: critical ?? null,
    summary: output.diff.summary,
    evidenceBudget: output.evidenceBudget,
  }, null, 2));
} finally {
  await registry.closeAll(true);
}
