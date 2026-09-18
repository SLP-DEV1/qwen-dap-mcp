import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { GuardedDapSession } from '../src/dap/guarded-session.js';
import { registerRuntimeV2Tools } from '../src/tools/runtime-v2.js';

type ToolResult = {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function payload(result: ToolResult): any {
  assert.equal(result.isError, undefined, result.content?.[0]?.text ?? 'tool returned MCP error');
  const text = result.content?.find((item) => item.type === 'text')?.text;
  assert.ok(text, 'tool returned no JSON text payload');
  return JSON.parse(text);
}

const programArg = arg('--program');
const outputDirArg = arg('--output-dir');
if (!programArg || !outputDirArg) {
  throw new Error('Usage: tsx test/runtime-v2-dump-batch-real-smoke.ts --program <exe> --output-dir <dir>');
}

const program = resolve(programArg);
const outputDir = resolve(outputDirArg);
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

for (const name of ['sample-one.core', 'sample-two.core']) {
  const core = join(outputDir, name);
  const gdb = spawnSync('gdb', [
    '-q',
    '-batch',
    '-ex', 'set confirm off',
    '-ex', 'start',
    '-ex', 'generate-core-file ' + core,
    '-ex', 'kill',
    program,
  ], {
    cwd: dirname(program),
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(
    gdb.status,
    0,
    'gdb failed to generate core ' + name + ': ' + (gdb.stderr || gdb.stdout),
  );
}

const handlers = new Map<string, ToolHandler>();
const server = {
  registerTool(name: string, _definition: unknown, handler: ToolHandler) {
    handlers.set(name, handler);
  },
};
const session = new GuardedDapSession();
registerRuntimeV2Tools(server as never, session);

const dumpBatch = handlers.get('debug_dump_batch');
assert.ok(dumpBatch, 'debug_dump_batch handler was not registered');

try {
  const result = payload(await dumpBatch({
    directory: outputDir,
    program,
    adapter: 'gdb',
    maxDumps: 2,
  }));
  assert.equal(result.analyzed, 2, JSON.stringify(result.errors));
  assert.equal(result.failed, 0, JSON.stringify(result.errors));
  assert.equal(result.reports.length, 2);
  assert.equal(result.families.totalReports, 2);
  assert.ok(result.reports.every((report: any) => report.fingerprintsV2?.family));

  console.log(JSON.stringify({
    ok: true,
    analyzed: result.analyzed,
    families: result.families,
  }, null, 2));
} finally {
  await session.reset();
}
