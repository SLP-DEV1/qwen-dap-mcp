import { readFileSync, writeFileSync } from 'node:fs';

function read(path) { return readFileSync(path, 'utf8'); }
function write(path, value) { writeFileSync(path, value, 'utf8'); }
function replaceOnce(text, oldValue, newValue, label) {
  const index = text.indexOf(oldValue);
  if (index < 0) throw new Error(`Missing patch anchor: ${label}`);
  if (text.indexOf(oldValue, index + oldValue.length) >= 0) throw new Error(`Ambiguous patch anchor: ${label}`);
  return text.slice(0, index) + newValue + text.slice(index + oldValue.length);
}
function addImport(path, anchor, addition) {
  let text = read(path);
  if (!text.includes(addition.trim())) text = replaceOnce(text, anchor, anchor + addition, `${path} import`);
  write(path, text);
}
function addOutputSchema(path, toolName, schemaExpression) {
  let text = read(path);
  const toolIndex = text.indexOf(`'${toolName}'`);
  if (toolIndex < 0) throw new Error(`Missing tool ${toolName} in ${path}`);
  const callbackMarker = text.indexOf('\n    },\n', toolIndex);
  if (callbackMarker < 0) throw new Error(`Missing config end for ${toolName}`);
  const inputIndex = text.indexOf('      inputSchema:', toolIndex);
  if (inputIndex < 0 || inputIndex > callbackMarker) throw new Error(`Missing inputSchema for ${toolName}`);
  const existing = text.indexOf('      outputSchema:', toolIndex);
  if (existing >= 0 && existing < inputIndex) return;
  text = text.slice(0, inputIndex) + `      outputSchema: ${schemaExpression},\n` + text.slice(inputIndex);
  write(path, text);
}
function replaceHandlerWrapper(path, toolName, oldWrapper, newWrapper) {
  let text = read(path);
  const toolIndex = text.indexOf(`'${toolName}'`);
  if (toolIndex < 0) throw new Error(`Missing tool ${toolName}`);
  const index = text.indexOf(oldWrapper, toolIndex);
  if (index < 0) throw new Error(`Missing handler wrapper ${oldWrapper} for ${toolName}`);
  text = text.slice(0, index) + newWrapper + text.slice(index + oldWrapper.length);
  write(path, text);
}

write('src/dap/symbol-health.ts', `import type { DebugProtocol } from '@vscode/debugprotocol';

export type SymbolHealthStatus = 'good' | 'partial' | 'poor' | 'unknown';

export type SymbolHealth = {
  status: SymbolHealthStatus;
  summary: string;
  stack: {
    totalFrames: number;
    namedFrames: number;
    sourceMappedFrames: number;
    topFrameNamed: boolean;
    topFrameSourceMapped: boolean;
  };
  modules: {
    collected: boolean;
    totalModules: number;
    withExplicitStatus: number;
    symbolsAvailable: number;
    symbolsMissing: number;
    symbolsUnknown: number;
  };
  limitations: string[];
};

const UNRESOLVED_FRAME_NAME = /^(?:\\?\\?|unknown|<unknown>|<unresolved>|0x[0-9a-f]+)$/i;
const NEGATIVE_SYMBOL_STATUS = /(?:not\\s+(?:loaded|found|available)|missing|no\\s+(?:symbols?|debug)|unavailable|failed|error)/i;
const POSITIVE_SYMBOL_STATUS = /(?:loaded|available|found|present|resolved|success)/i;

function frameHasName(frame: DebugProtocol.StackFrame): boolean {
  const name = frame.name?.trim();
  return Boolean(name && !UNRESOLVED_FRAME_NAME.test(name));
}

function frameHasSource(frame: DebugProtocol.StackFrame): boolean {
  const source = frame.source;
  const hasSourceIdentity = Boolean(source?.path?.trim() || source?.name?.trim());
  return hasSourceIdentity && Number.isFinite(frame.line) && frame.line > 0;
}

function moduleSymbolState(module: DebugProtocol.Module): 'available' | 'missing' | 'unknown' {
  const status = module.symbolStatus?.trim() ?? '';
  if (status && NEGATIVE_SYMBOL_STATUS.test(status)) return 'missing';
  if (module.symbolFilePath?.trim()) return 'available';
  if (status && POSITIVE_SYMBOL_STATUS.test(status)) return 'available';
  return 'unknown';
}

export function assessSymbolHealth(
  stack: readonly DebugProtocol.StackFrame[],
  modules?: readonly DebugProtocol.Module[],
): SymbolHealth {
  const namedFrames = stack.filter(frameHasName).length;
  const sourceMappedFrames = stack.filter(frameHasSource).length;
  const top = stack[0];
  const states = modules?.map(moduleSymbolState) ?? [];
  const symbolsAvailable = states.filter((state) => state === 'available').length;
  const symbolsMissing = states.filter((state) => state === 'missing').length;
  const symbolsUnknown = states.filter((state) => state === 'unknown').length;
  const withExplicitStatus = modules?.filter((module) => Boolean(module.symbolStatus?.trim() || module.symbolFilePath?.trim())).length ?? 0;

  let status: SymbolHealthStatus;
  if (stack.length === 0 && (modules?.length ?? 0) === 0) {
    status = 'unknown';
  } else if (
    stack.length > 0
    && namedFrames === 0
    && sourceMappedFrames === 0
    && symbolsAvailable === 0
  ) {
    status = 'poor';
  } else if (
    sourceMappedFrames === 0
    && symbolsMissing > 0
    && symbolsAvailable === 0
  ) {
    status = 'poor';
  } else if (
    namedFrames > 0
    && sourceMappedFrames > 0
    && symbolsMissing === 0
  ) {
    status = 'good';
  } else if (namedFrames > 0 || sourceMappedFrames > 0 || symbolsAvailable > 0) {
    status = 'partial';
  } else {
    status = 'unknown';
  }

  const limitations: string[] = [];
  if (modules === undefined) {
    limitations.push('Loaded-module symbol status was not collected for this snapshot.');
  } else if (modules.length > 0 && withExplicitStatus === 0) {
    limitations.push('The adapter returned modules without explicit symbolStatus or symbolFilePath evidence.');
  }
  if (stack.length > 0 && namedFrames === 0) {
    limitations.push('No sampled stack frame exposes a resolved function name.');
  }
  if (stack.length > 0 && sourceMappedFrames === 0) {
    limitations.push('No sampled stack frame includes source file and line information.');
  }

  const summary = status === 'good'
    ? 'Resolved function names and source locations are present, with no explicit missing-module symbol evidence.'
    : status === 'partial'
      ? 'Some symbol evidence is resolved, but stack/source/module evidence is incomplete or mixed.'
      : status === 'poor'
        ? 'The sampled stop has little usable symbol/source evidence or explicit missing-symbol evidence.'
        : 'The snapshot does not contain enough symbol evidence for a reliable quality classification.';

  return {
    status,
    summary,
    stack: {
      totalFrames: stack.length,
      namedFrames,
      sourceMappedFrames,
      topFrameNamed: top ? frameHasName(top) : false,
      topFrameSourceMapped: top ? frameHasSource(top) : false,
    },
    modules: {
      collected: modules !== undefined,
      totalModules: modules?.length ?? 0,
      withExplicitStatus,
      symbolsAvailable,
      symbolsMissing,
      symbolsUnknown,
    },
    limitations,
  };
}
`);

write('src/tools/agent-output.ts', `import * as z from 'zod/v4';

export function structuredResult<T>(value: T) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Structured MCP tool output must be JSON-serializable.');
  const structuredContent = JSON.parse(serialized) as T;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

const jsonObjectSchema = z.object({}).catchall(z.unknown());
const dapThreadSchema = z.object({
  id: z.number().int(),
  name: z.string(),
}).catchall(z.unknown());
const dapFrameSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  line: z.number().int(),
  column: z.number().int(),
  source: z.unknown().optional(),
}).catchall(z.unknown());

export const symbolHealthSchema = z.object({
  status: z.enum(['good', 'partial', 'poor', 'unknown']),
  summary: z.string(),
  stack: z.object({
    totalFrames: z.number().int().nonnegative(),
    namedFrames: z.number().int().nonnegative(),
    sourceMappedFrames: z.number().int().nonnegative(),
    topFrameNamed: z.boolean(),
    topFrameSourceMapped: z.boolean(),
  }),
  modules: z.object({
    collected: z.boolean(),
    totalModules: z.number().int().nonnegative(),
    withExplicitStatus: z.number().int().nonnegative(),
    symbolsAvailable: z.number().int().nonnegative(),
    symbolsMissing: z.number().int().nonnegative(),
    symbolsUnknown: z.number().int().nonnegative(),
  }),
  limitations: z.array(z.string()),
});

export const runtimeSnapshotOutputSchema = z.object({
  postmortem: z.boolean().optional(),
  stopped: z.unknown().optional(),
  thread: dapThreadSchema,
  stack: z.array(dapFrameSchema),
  frame: dapFrameSchema,
  scopes: z.array(z.unknown()),
  locals: z.array(z.unknown()),
  registers: z.array(z.unknown()),
  symbolHealth: symbolHealthSchema,
  disassembly: z.array(z.unknown()).optional(),
  modules: z.array(z.unknown()).optional(),
  exception: z.unknown().optional(),
  collectionErrors: z.array(z.object({ operation: z.string(), message: z.string() })).optional(),
}).catchall(z.unknown());

export const sessionStatusOutputSchema = z.object({
  adapterRunning: z.boolean(),
  adapterPid: z.number().int().positive().optional(),
  initialized: z.boolean(),
  configured: z.boolean(),
  activeRequest: z.enum(['launch', 'attach']).optional(),
  adapterId: z.string().optional(),
  capabilities: jsonObjectSchema.optional(),
  recentEvents: z.array(z.unknown()),
  recentAdapterStderr: z.array(z.string()),
}).catchall(z.unknown());

export const debugDiagnoseStopOutputSchema = z.object({
  snapshot: runtimeSnapshotOutputSchema,
  diagnosis: z.unknown(),
}).catchall(z.unknown());

export const debugSourceDisassemblyOutputSchema = z.object({
  frameSelection: z.unknown(),
  faultCorrelation: z.unknown(),
  projectCorrelation: z.unknown(),
  projectFrame: dapFrameSchema,
  operandAnalysis: z.unknown(),
  collectionErrors: z.array(z.string()).optional(),
}).catchall(z.unknown());

export const debugThisCrashOutputSchema = z.object({
  mode: z.enum(['current', 'live', 'codelldb', 'lldb-dap', 'gdb', 'dump']),
  diagnosis: z.unknown().optional(),
  workflow: z.unknown().optional(),
  status: sessionStatusOutputSchema,
}).catchall(z.unknown());

export const debugFindWriterOutputSchema = z.object({
  query: z.object({
    name: z.string(),
    accessType: z.enum(['read', 'write', 'readWrite']),
    variablesReference: z.number().int().positive().optional(),
    frameId: z.number().int().positive(),
  }).catchall(z.unknown()),
  strategy: z.enum(['dap-data-breakpoint', 'gdb-watch']),
  resolution: z.unknown(),
  priorDataBreakpointCount: z.number().int().nonnegative(),
  replaceExistingDataBreakpoints: z.boolean(),
  installed: z.unknown(),
  outcome: z.object({ event: z.enum(['stopped', 'exited', 'terminated']), body: z.unknown().optional() }),
  hitConfirmed: z.boolean(),
  before: z.object({ thread: dapThreadSchema, frame: dapFrameSchema }),
  writerFrame: dapFrameSchema.optional(),
  writerCorrelation: z.unknown().optional(),
  snapshot: runtimeSnapshotOutputSchema.optional(),
  cleanupWarning: z.string().optional(),
  guidance: z.string(),
  status: sessionStatusOutputSchema,
}).catchall(z.unknown());

export const debugRunToStopOutputSchema = z.object({
  request: z.enum(['launch', 'attach']),
  requestResult: z.unknown(),
  outcome: z.object({ event: z.enum(['stopped', 'exited', 'terminated']), body: z.unknown().optional() }),
  snapshot: runtimeSnapshotOutputSchema.optional(),
  status: z.unknown(),
}).catchall(z.unknown());

export const debugOpenDumpOutputSchema = z.object({
  mode: z.literal('postmortem'),
  readOnlyTarget: z.literal(true),
  adapterKind: z.enum(['codelldb', 'lldb-dap', 'gdb']),
  dumpPath: z.string(),
  program: z.string().optional(),
  adapter: z.unknown(),
  capabilities: z.unknown(),
  attach: z.unknown(),
  snapshot: runtimeSnapshotOutputSchema,
  guidance: z.object({
    canInspect: z.array(z.string()),
    blockedOperations: z.array(z.string()),
    cannotResume: z.boolean(),
    note: z.string(),
  }).catchall(z.unknown()),
}).catchall(z.unknown());

export const debugSnapshotOutputSchema = runtimeSnapshotOutputSchema;
export const debugStatusOutputSchema = sessionStatusOutputSchema;
export const debugContinueOutputSchema = z.object({
  response: z.unknown().optional(),
  stopped: z.unknown().optional(),
  allThreadsContinued: z.boolean().optional(),
}).catchall(z.unknown());
export const debugDisconnectOutputSchema = z.object({ disconnected: z.literal(true) });

export const AGENT_OUTPUT_SCHEMAS = {
  debug_this_crash: debugThisCrashOutputSchema,
  debug_diagnose_stop: debugDiagnoseStopOutputSchema,
  debug_source_disassembly: debugSourceDisassemblyOutputSchema,
  debug_find_writer: debugFindWriterOutputSchema,
  debug_run_to_stop: debugRunToStopOutputSchema,
  debug_open_dump: debugOpenDumpOutputSchema,
  debug_snapshot: debugSnapshotOutputSchema,
  debug_status: debugStatusOutputSchema,
  debug_continue: debugContinueOutputSchema,
  debug_disconnect: debugDisconnectOutputSchema,
} as const;
`);

// Attach deterministic symbol health to every runtime snapshot.
{
  const path = 'src/dap/session.ts';
  let text = read(path);
  if (!text.includes("from './symbol-health.js'")) {
    text = replaceOnce(
      text,
      "import { DapError } from './errors.js';\n",
      "import { DapError } from './errors.js';\nimport { assessSymbolHealth, type SymbolHealth } from './symbol-health.js';\n",
      'symbol health import',
    );
  }
  text = replaceOnce(
    text,
    "  registers: DebugProtocol.Variable[];\n  disassembly?: DebugProtocol.DisassembledInstruction[];",
    "  registers: DebugProtocol.Variable[];\n  symbolHealth: SymbolHealth;\n  disassembly?: DebugProtocol.DisassembledInstruction[];",
    'runtime snapshot symbol health type',
  );
  text = replaceOnce(
    text,
    "      registers,\n      ...(disassembly === undefined ? {} : { disassembly }),",
    "      registers,\n      symbolHealth: assessSymbolHealth(stack, loadedModules),\n      ...(disassembly === undefined ? {} : { disassembly }),",
    'runtime snapshot symbol health value',
  );
  write(path, text);
}

// Agent diagnostic tools: all are default-agent tools, so use structured results and output schemas.
{
  const path = 'src/tools/agent-diagnostics.ts';
  let text = read(path);
  if (!text.includes("from './agent-output.js'")) {
    text = replaceOnce(
      text,
      "import { LOCAL_TARGET_EXECUTION_ANNOTATIONS, READ_ONLY_LOCAL_TOOL_ANNOTATIONS } from './tool-annotations.js';\n",
      "import { LOCAL_TARGET_EXECUTION_ANNOTATIONS, READ_ONLY_LOCAL_TOOL_ANNOTATIONS } from './tool-annotations.js';\nimport { debugDiagnoseStopOutputSchema, debugSourceDisassemblyOutputSchema, debugThisCrashOutputSchema, structuredResult } from './agent-output.js';\n",
      'agent diagnostics output import',
    );
  }
  text = replaceOnce(
    text,
    "function result(value: unknown) {\n  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };\n}",
    "function result(value: unknown) {\n  return structuredResult(value);\n}",
    'agent diagnostics structured result',
  );
  write(path, text);
  addOutputSchema(path, 'debug_diagnose_stop', 'debugDiagnoseStopOutputSchema');
  addOutputSchema(path, 'debug_source_disassembly', 'debugSourceDisassemblyOutputSchema');
  addOutputSchema(path, 'debug_this_crash', 'debugThisCrashOutputSchema');
}

// Find-writer structured output.
{
  const path = 'src/tools/find-writer.ts';
  let text = read(path);
  if (!text.includes("from './agent-output.js'")) {
    text = replaceOnce(
      text,
      "import { DEBUG_SESSION_CONTROL_ANNOTATIONS } from './tool-annotations.js';\n",
      "import { DEBUG_SESSION_CONTROL_ANNOTATIONS } from './tool-annotations.js';\nimport { debugFindWriterOutputSchema, structuredResult } from './agent-output.js';\n",
      'find writer output import',
    );
  }
  text = replaceOnce(
    text,
    "function result(value: unknown) {\n  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };\n}",
    "function result(value: unknown) {\n  return structuredResult(value);\n}",
    'find writer structured result',
  );
  write(path, text);
  addOutputSchema(path, 'debug_find_writer', 'debugFindWriterOutputSchema');
}

// Run-to-stop structured output.
{
  const path = 'src/tools/run-to-stop.ts';
  let text = read(path);
  if (!text.includes("from './agent-output.js'")) {
    text = replaceOnce(
      text,
      "import { LOCAL_TARGET_EXECUTION_ANNOTATIONS } from './tool-annotations.js';\n",
      "import { LOCAL_TARGET_EXECUTION_ANNOTATIONS } from './tool-annotations.js';\nimport { debugRunToStopOutputSchema, structuredResult } from './agent-output.js';\n",
      'run to stop output import',
    );
  }
  text = replaceOnce(
    text,
    "function result(value: unknown) {\n  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };\n}",
    "function result(value: unknown) {\n  return structuredResult(value);\n}",
    'run to stop structured result',
  );
  write(path, text);
  addOutputSchema(path, 'debug_run_to_stop', 'debugRunToStopOutputSchema');
}

// Dump structured output.
{
  const path = 'src/tools/register-dump-tools.ts';
  let text = read(path);
  if (!text.includes("from './agent-output.js'")) {
    text = replaceOnce(
      text,
      "import { READ_ONLY_LOCAL_TOOL_ANNOTATIONS } from './tool-annotations.js';\n",
      "import { READ_ONLY_LOCAL_TOOL_ANNOTATIONS } from './tool-annotations.js';\nimport { debugOpenDumpOutputSchema, structuredResult } from './agent-output.js';\n",
      'dump output import',
    );
  }
  text = replaceOnce(
    text,
    "function result(value: unknown) {\n  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };\n}",
    "function result(value: unknown) {\n  return structuredResult(value);\n}",
    'dump structured result',
  );
  write(path, text);
  addOutputSchema(path, 'debug_open_dump', 'debugOpenDumpOutputSchema');
}

// Shared debug tool file: only the four default-agent tools use structured results.
{
  const path = 'src/tools/register-debug-tools.ts';
  let text = read(path);
  if (!text.includes("from './agent-output.js'")) {
    text = replaceOnce(
      text,
      "} from './tool-annotations.js';\n",
      "} from './tool-annotations.js';\nimport { debugContinueOutputSchema, debugDisconnectOutputSchema, debugSnapshotOutputSchema, debugStatusOutputSchema, structuredResult } from './agent-output.js';\n",
      'debug tools output import',
    );
  }
  const wrapAnchor = "function wrap<TArgs extends Record<string, unknown>>(handler: (args: TArgs) => Promise<unknown> | unknown) {\n  return async (args: TArgs) => {\n    try {\n      return result(await handler(args));\n    } catch (error) {\n      return errorResult(error);\n    }\n  };\n}\n";
  if (!text.includes('function wrapStructured<')) {
    text = replaceOnce(
      text,
      wrapAnchor,
      wrapAnchor + "\nfunction wrapStructured<TArgs extends Record<string, unknown>>(handler: (args: TArgs) => Promise<unknown> | unknown) {\n  return async (args: TArgs) => {\n    try {\n      return structuredResult(await handler(args));\n    } catch (error) {\n      return errorResult(error);\n    }\n  };\n}\n",
      'structured wrapper',
    );
  }
  write(path, text);
  addOutputSchema(path, 'debug_continue', 'debugContinueOutputSchema');
  addOutputSchema(path, 'debug_snapshot', 'debugSnapshotOutputSchema');
  addOutputSchema(path, 'debug_disconnect', 'debugDisconnectOutputSchema');
  replaceHandlerWrapper(path, 'debug_continue', 'wrap(async', 'wrapStructured(async');
  replaceHandlerWrapper(path, 'debug_snapshot', 'wrap(async', 'wrapStructured(async');
  replaceHandlerWrapper(path, 'debug_disconnect', 'wrap(async', 'wrapStructured(async');

  text = read(path);
  text = replaceOnce(
    text,
    "  server.registerTool('debug_status', {\n    title: 'Debug Session Status',\n    description: 'Inspect debugger lifecycle state, the selected stop, recent DAP events, and bounded adapter stderr without changing target execution. Use this to determine whether a session is initialized, running, stopped, postmortem, exited, or failed before choosing another debug tool; it is diagnostic only and does not resume, launch, attach, or terminate the debuggee.',\n    annotations: READ_ONLY_LOCAL_TOOL_ANNOTATIONS,\n  }, async () => result(session.snapshot()));",
    "  server.registerTool('debug_status', {\n    title: 'Debug Session Status',\n    description: 'Inspect debugger lifecycle state, the selected stop, recent DAP events, and bounded adapter stderr without changing target execution. Use this to determine whether a session is initialized, running, stopped, postmortem, exited, or failed before choosing another debug tool; it is diagnostic only and does not resume, launch, attach, or terminate the debuggee.',\n    annotations: READ_ONLY_LOCAL_TOOL_ANNOTATIONS,\n    outputSchema: debugStatusOutputSchema,\n  }, async () => structuredResult(session.snapshot()));",
    'debug status structured output',
  );
  write(path, text);
}

write('test/symbol-health.test.ts', `import assert from 'node:assert/strict';
import test from 'node:test';
import type { DebugProtocol } from '@vscode/debugprotocol';

import { assessSymbolHealth } from '../src/dap/symbol-health.js';

function frame(name: string, source?: string, line = 0): DebugProtocol.StackFrame {
  return {
    id: 1,
    name,
    line,
    column: 1,
    ...(source ? { source: { name: source, path: source } } : {}),
  };
}

test('symbol health reports good from named/source-mapped frames without missing module evidence', () => {
  const health = assessSymbolHealth(
    [frame('crash_here', '/work/main.cpp', 42), frame('main', '/work/main.cpp', 60)],
    [{ id: 1, name: 'app', symbolStatus: 'Symbols loaded.', symbolFilePath: '/work/app.debug' }],
  );
  assert.equal(health.status, 'good');
  assert.equal(health.stack.namedFrames, 2);
  assert.equal(health.stack.sourceMappedFrames, 2);
  assert.equal(health.modules.symbolsAvailable, 1);
});

test('symbol health reports partial when function names exist but source mapping is absent', () => {
  const health = assessSymbolHealth([frame('worker')]);
  assert.equal(health.status, 'partial');
  assert.ok(health.limitations.some((item) => /source file and line/i.test(item)));
  assert.ok(health.limitations.some((item) => /module symbol status/i.test(item)));
});

test('symbol health reports poor when stack and module evidence are unresolved', () => {
  const health = assessSymbolHealth(
    [frame('??')],
    [{ id: 1, name: 'app', symbolStatus: 'Symbols not found.' }],
  );
  assert.equal(health.status, 'poor');
  assert.equal(health.modules.symbolsMissing, 1);
});

test('symbol health remains unknown when no evidence exists', () => {
  const health = assessSymbolHealth([], undefined);
  assert.equal(health.status, 'unknown');
  assert.equal(health.stack.totalFrames, 0);
});
`);

write('test/agent-structured-output.test.ts', `import assert from 'node:assert/strict';
import test from 'node:test';

import { registerAgentDiagnosticTools } from '../src/tools/agent-diagnostics.js';
import { AGENT_OUTPUT_SCHEMAS, structuredResult } from '../src/tools/agent-output.js';
import { registerFindWriterTool } from '../src/tools/find-writer.js';
import { registerDebugTools } from '../src/tools/register-debug-tools.js';
import { registerDumpTools } from '../src/tools/register-dump-tools.js';
import { registerRunToStopTool } from '../src/tools/run-to-stop.js';
import { AGENT_TOOL_NAMES } from '../src/toolset.js';

function captureRegistrations() {
  const registrations = new Map<string, { config: Record<string, unknown>; handler: (...args: any[]) => unknown }>();
  const server = {
    registerTool(name: string, config: Record<string, unknown>, handler: (...args: any[]) => unknown) {
      registrations.set(name, { config, handler });
      return { disable() {}, enable() {}, update() {}, remove() {} };
    },
  };
  const status = {
    adapterRunning: false,
    initialized: false,
    configured: false,
    recentEvents: [],
    recentAdapterStderr: [],
  };
  const session = { snapshot: () => status };

  registerAgentDiagnosticTools(server as never, session as never);
  registerFindWriterTool(server as never, session as never);
  registerRunToStopTool(server as never, session as never);
  registerDumpTools(server as never, session as never);
  registerDebugTools(server as never, session as never);
  return { registrations, status };
}

test('every default agent tool declares an MCP v2 output schema', () => {
  assert.deepEqual(new Set(Object.keys(AGENT_OUTPUT_SCHEMAS)), new Set(AGENT_TOOL_NAMES));
  const { registrations } = captureRegistrations();
  for (const name of AGENT_TOOL_NAMES) {
    const registration = registrations.get(name);
    assert.ok(registration, `missing registration for ${name}`);
    assert.ok(registration.config.outputSchema, `${name} is missing outputSchema`);
  }
});

test('structuredResult keeps legacy text content and emits equivalent structuredContent', () => {
  const value = { disconnected: true, nested: { omitted: undefined, value: 7 } };
  const result = structuredResult(value);
  assert.deepEqual(result.structuredContent, { disconnected: true, nested: { value: 7 } });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test('debug_status returns validated structured content as well as the legacy JSON text block', async () => {
  const { registrations, status } = captureRegistrations();
  const registration = registrations.get('debug_status');
  assert.ok(registration);
  const result = await registration.handler({}) as { content: Array<{ text: string }>; structuredContent: unknown };
  assert.deepEqual(result.structuredContent, status);
  assert.deepEqual(JSON.parse(result.content[0].text), status);
  const schema = registration.config.outputSchema as { safeParse(value: unknown): { success: boolean } };
  assert.equal(schema.safeParse(result.structuredContent).success, true);
});
`);

// Document the machine-readable result contract and symbol health in the README.
{
  const path = 'README.md';
  let text = read(path);
  const anchor = "Near-term design rule: keep the default agent surface compact and add high-level evidence workflows before adding raw debugger primitives.\n";
  if (!text.includes('### Structured agent results')) {
    text = replaceOnce(
      text,
      anchor,
      anchor + "\n### Structured agent results\n\nThe ten default agent tools expose MCP v2 `outputSchema` contracts and return the same JSON evidence in both `structuredContent` and the legacy text content block. This keeps older clients readable while allowing MCP v2 hosts to validate and consume results without reparsing prose. Runtime snapshots also include `symbolHealth`, a deterministic `good | partial | poor | unknown` classification derived from resolved stack-frame names, source/line mappings, and explicit module symbol evidence when the adapter provides it. No synthetic numeric symbol score is used.\n",
      'README structured results',
    );
  }
  write(path, text);
}
