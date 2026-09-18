import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildGdbDapLaunchConfiguration, discoverGdbDap } from '../src/adapters/gdb-dap.js';
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

const programArg = arg('--program');
const sourceArg = arg('--source');
if (!programArg || !sourceArg) {
  throw new Error('Usage: tsx test/runtime-v2-gdb-real-smoke.ts --program <exe> --source <cpp>');
}

const program = resolve(programArg);
const source = resolve(sourceArg);
const sourceLines = readFileSync(source, 'utf8').split(/\r?\n/);
const markerIndex = sourceLines.findIndex((line) => line.includes('RUNTIME_V2_BREAK'));
if (markerIndex < 0) throw new Error('RUNTIME_V2_BREAK marker missing');
const breakpointLine = markerIndex + 2;

const session = new GuardedDapSession();
const handlers = new Map<string, ToolHandler>();
const server = {
  registerTool(name: string, _definition: unknown, handler: ToolHandler) {
    handlers.set(name, handler);
    return { disable() {}, enable() {}, update() {}, remove() {} };
  },
};
registerRuntimeV2Tools(server as never, session);

try {
  const adapter = discoverGdbDap();
  const capabilities = await session.start({
    command: adapter.command,
    args: adapter.args,
    adapterId: 'gdb',
    requestTimeoutMs: 30_000,
  });
  const stoppedPromise = session.connection.waitForEvent('stopped', 30_000);
  void stoppedPromise.catch(() => undefined);
  await session.launch(
    buildGdbDapLaunchConfiguration({ program, stopOnEntry: false }),
    [{ source, lines: [breakpointLine] }],
  );
  await stoppedPromise;

  const cpp = await handlers.get('debug_cpp_object')!({ name: 'ptr', bytes: 32 });
  assert.equal(cpp.isError, undefined, JSON.stringify(cpp));
  assert.match(cpp.structuredContent?.pointer ?? '', /^0x/i);
  assert.match(cpp.structuredContent?.probableVtable ?? '', /^0x/i);
  assert.ok(cpp.structuredContent?.bytesRead >= 8);

  const adaptive = await handlers.get('debug_adaptive_evidence')!({ forceFull: true, maxVariables: 60 });
  assert.equal(adaptive.isError, undefined, JSON.stringify(adaptive));
  assert.equal(adaptive.structuredContent?.selectedPhase, 'full');
  assert.ok(adaptive.structuredContent?.report?.fingerprintsV2?.semantic);

  const lifetime = await handlers.get('debug_trace_lifetime')!({
    name: 'ptr',
    direction: 'forward',
    maxStops: 1,
    reverseSteps: 1,
    timeoutMs: 30_000,
  });
  assert.equal(lifetime.isError, undefined, JSON.stringify(lifetime));
  assert.ok(lifetime.structuredContent?.forwardTimeline?.events?.length >= 1);
  assert.equal(lifetime.structuredContent?.forwardTimeline?.events?.[0]?.hitConfirmed, true);

  const timeline = await handlers.get('debug_thread_timeline')!({
    samples: 2,
    intervalMs: 50,
    maxThreads: 8,
    stackLevels: 6,
    maxVariables: 16,
  });
  assert.equal(timeline.isError, undefined, JSON.stringify(timeline));
  assert.ok(timeline.structuredContent?.observations?.length >= 2);
  assert.ok(timeline.structuredContent?.progression?.length >= 1);

  console.log(JSON.stringify({
    ok: true,
    capabilities: {
      supportsReadMemoryRequest: capabilities.supportsReadMemoryRequest,
      supportsModulesRequest: capabilities.supportsModulesRequest,
      supportsDataBreakpoints: capabilities.supportsDataBreakpoints,
    },
    cpp: {
      pointer: cpp.structuredContent.pointer,
      probableVtable: cpp.structuredContent.probableVtable,
      module: cpp.structuredContent.vtableModule?.name,
    },
    adaptivePhase: adaptive.structuredContent.selectedPhase,
    lifetimeEvents: lifetime.structuredContent.forwardTimeline.events.length,
    timelineObservations: timeline.structuredContent.observations.length,
  }, null, 2));
} finally {
  await session.disconnect(true);
}
