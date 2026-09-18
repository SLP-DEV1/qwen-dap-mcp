import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildGdbDapLaunchConfiguration, discoverGdbDap } from '../src/adapters/gdb-dap.js';
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
const sourceArg = arg('--source');
if (!programArg || !sourceArg) {
  throw new Error('Usage: tsx test/runtime-v2-gdb-real-smoke.ts --program <exe> --source <cpp>');
}

const program = resolve(programArg);
const source = resolve(sourceArg);
const sourceText = readFileSync(source, 'utf8');
const breakpointLine = sourceText.split(/\r?\n/).findIndex((line) => line.includes('RUNTIME_V2_BREAKPOINT')) + 1;
assert.ok(breakpointLine > 0, 'runtime v2 breakpoint marker not found');

const handlers = new Map<string, ToolHandler>();
const server = {
  registerTool(name: string, _definition: unknown, handler: ToolHandler) {
    handlers.set(name, handler);
  },
};

const session = new GuardedDapSession();
registerRuntimeV2Tools(server as never, session);

const adapter = discoverGdbDap();

try {
  await session.start({
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
  const stopped = await stoppedPromise;
  assert.equal((stopped.body as { reason?: string })?.reason, 'breakpoint');

  const cppObject = handlers.get('debug_cpp_object');
  const symbolDoctor = handlers.get('debug_symbol_doctor');
  const adaptive = handlers.get('debug_adaptive_evidence');
  const timeline = handlers.get('debug_thread_timeline');
  const lifetime = handlers.get('debug_trace_lifetime');
  assert.ok(cppObject && symbolDoctor && adaptive && timeline && lifetime, 'runtime v2 handlers not registered');

  const objectResult = payload(await cppObject({
    name: 'object',
    bytes: 32,
  }));
  assert.equal(objectResult.pointerSize, 8);
  assert.ok(objectResult.bytesRead >= 8, 'C++ object inspection read too few bytes');
  assert.match(objectResult.probableVtable ?? '', /^0x[0-9a-f]+$/i);

  const symbolResult = payload(await symbolDoctor({
    program,
    searchPaths: [],
    maxEntries: 100,
    maxDepth: 1,
  }));
  assert.equal(symbolResult.binaryIdentity?.format, 'elf');
  assert.match(symbolResult.binaryIdentity?.buildId ?? '', /^[0-9a-f]+$/i);

  const adaptiveResult = payload(await adaptive({
    forceFull: true,
    maxVariables: 80,
  }));
  assert.equal(adaptiveResult.selectedPhase, 'full');
  assert.ok(adaptiveResult.report?.fingerprintsV2?.semantic, 'adaptive full evidence omitted v2 fingerprints');

  const timelineResult = payload(await timeline({
    samples: 2,
    intervalMs: 75,
    maxThreads: 8,
    stackLevels: 8,
    maxVariables: 24,
  }));
  assert.ok(timelineResult.observations.length >= 2, 'thread timeline produced too little evidence');
  assert.ok(
    timelineResult.progression.some((entry: any) => entry.samples >= 2),
    'thread timeline did not retain repeated per-thread samples',
  );

  const lifetimeResult = payload(await lifetime({
    name: 'object',
    direction: 'forward',
    maxStops: 2,
    reverseSteps: 1,
    timeoutMs: 8_000,
  }));
  assert.equal(lifetimeResult.query, 'object');
  assert.ok(lifetimeResult.forwardTimeline, 'lifetime tracing returned no forward timeline');
  assert.ok(
    Array.isArray(lifetimeResult.forwardTimeline.events)
      && lifetimeResult.forwardTimeline.events.some((event: any) => event.hitConfirmed),
    'lifetime tracing did not observe the real object pointer write',
  );

  console.log(JSON.stringify({
    ok: true,
    breakpointLine,
    cppObject: {
      pointer: objectResult.pointer,
      probableVtable: objectResult.probableVtable,
      module: objectResult.vtableModule?.name,
    },
    symbolDoctor: {
      format: symbolResult.binaryIdentity?.format,
      buildId: symbolResult.binaryIdentity?.buildId,
    },
    timeline: {
      observations: timelineResult.observations.length,
      progression: timelineResult.progression,
    },
    lifetime: {
      stopReason: lifetimeResult.forwardTimeline.stopReason,
      events: lifetimeResult.forwardTimeline.events?.length,
    },
  }, null, 2));
} finally {
  await session.reset();
}
