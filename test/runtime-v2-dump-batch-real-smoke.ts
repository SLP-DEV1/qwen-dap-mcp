import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { GuardedDapSession } from '../src/dap/guarded-session.js';
import { registerRuntimeV2Tools } from '../src/tools/runtime-v2.js';

type ToolResult = {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: any;
};
type ToolHandler = (args: Record<string, any>) => Promise<ToolResult>;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const adapterPath = arg('--adapter');
const programArg = arg('--program');
const directoryArg = arg('--directory');
if (!adapterPath || !programArg || !directoryArg) {
  throw new Error('Usage: tsx test/runtime-v2-dump-batch-real-smoke.ts --adapter <codelldb> --program <exe> --directory <dir>');
}

const session = new GuardedDapSession();
let handler: ToolHandler | undefined;
const server = {
  registerTool(name: string, _definition: unknown, fn: ToolHandler) {
    if (name === 'debug_dump_batch') handler = fn;
    return { disable() {}, enable() {}, update() {}, remove() {} };
  },
};
registerRuntimeV2Tools(server as never, session);
assert.ok(handler, 'debug_dump_batch handler was not registered');

try {
  const result = await handler({
    directory: resolve(directoryArg),
    program: resolve(programArg),
    adapter: 'codelldb',
    adapterPath: resolve(adapterPath),
    maxDumps: 2,
  });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(result.structuredContent?.analyzed, 2, JSON.stringify(result.structuredContent));
  assert.equal(result.structuredContent?.failed, 0, JSON.stringify(result.structuredContent));
  assert.equal(result.structuredContent?.reports?.length, 2);
  assert.equal(result.structuredContent?.families?.totalReports, 2);
  assert.ok(result.structuredContent?.reports?.every((report: any) => report.fingerprintsV2?.family));

  console.log(JSON.stringify({
    ok: true,
    analyzed: result.structuredContent.analyzed,
    families: result.structuredContent.families,
  }, null, 2));
} finally {
  await session.reset();
}
