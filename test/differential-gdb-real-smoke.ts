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
    [{ source, lines: [12] }],
  );
  const stopped = await stoppedPromise;
  const body = stopped.body as { threadId?: number; reason?: string } | undefined;
  assert.equal(body?.reason, 'breakpoint', `${mode} session did not stop at the source breakpoint`);
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

  const critical = output.diff.locals.find((item: any) => item.name === 'critical_ptr');
  assert.ok(critical, `critical_ptr was not present in the semantic diff: ${JSON.stringify(output.diff.locals)}`);
  assert.equal(critical.status, 'changed');
  assert.match(String(critical.reason), /Nullability changed/);
  assert.match(String(critical.baseline), /0x[0-9a-f]+/i);
  assert.match(String(critical.candidate), /^(?:0x)?0+$/i);
  assert.equal(output.diff.firstMeaningfulDifference?.category, 'local');
  assert.equal(output.diff.firstMeaningfulDifference?.key, critical.key);
  assert.ok(output.diff.summary.meaningfulDifferences >= 1);

  console.log(JSON.stringify({
    ok: true,
    firstMeaningfulDifference: output.diff.firstMeaningfulDifference,
    criticalPointerDiff: critical,
    summary: output.diff.summary,
  }, null, 2));
} finally {
  await registry.closeAll(true);
}
