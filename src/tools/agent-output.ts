import * as z from 'zod/v4';

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

export const debugThisHangOutputSchema = z.object({
  mode: z.enum(['current', 'live', 'codelldb', 'lldb-dap', 'gdb']),
  observation: z.object({
    suspectedHang: z.boolean(),
    trigger: z.string(),
  }).catchall(z.unknown()),
  evidence: z.array(z.unknown()).optional(),
  diagnosis: z.object({
    summary: z.string(),
    classification: z.enum(['deadlock-candidate', 'lock-contention', 'global-wait', 'io-wait', 'mixed-wait', 'no-deadlock-signal', 'unknown']),
    confidence: z.enum(['low', 'medium', 'high']),
    allThreadTriage: z.array(z.unknown()),
    deadlock: z.unknown(),
    pointerProvenance: z.object({
      version: z.literal(2),
      groups: z.array(z.unknown()),
      nullLike: z.array(z.unknown()),
      limitations: z.array(z.string()),
    }).catchall(z.unknown()),
    nextActions: z.array(z.string()),
    limitations: z.array(z.string()),
  }).catchall(z.unknown()).optional(),
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

export const debugSessionsOutputSchema = z.object({
  action: z.enum(['list', 'create', 'close']),
  defaultSessionId: z.string(),
  maxSessions: z.number().int().positive(),
  sessionId: z.string().optional(),
  removed: z.boolean().optional(),
  sessions: z.array(z.object({
    sessionId: z.string(),
    isDefault: z.boolean(),
    activeRequests: z.number().int().nonnegative(),
    snapshot: z.object({}).catchall(z.unknown()),
  })),
}).catchall(z.unknown());

const runtimeComparisonSideSchema = z.object({
  sessionId: z.string(),
  snapshot: runtimeSnapshotOutputSchema,
  status: sessionStatusOutputSchema,
}).catchall(z.unknown());

export const debugCompareRunsOutputSchema = z.object({
  baselineSessionId: z.string(),
  candidateSessionId: z.string(),
  baseline: runtimeComparisonSideSchema,
  candidate: runtimeComparisonSideSchema,
  diff: z.object({
    summary: z.object({
      meaningfulDifferences: z.number().int().nonnegative(),
      changedLocals: z.number().int().nonnegative(),
      changedRegisters: z.number().int().nonnegative(),
      unstableValues: z.number().int().nonnegative(),
      stackChanges: z.number().int().nonnegative(),
      addedModules: z.number().int().nonnegative(),
      removedModules: z.number().int().nonnegative(),
    }),
    stack: z.unknown(),
    locals: z.array(z.unknown()),
    registers: z.array(z.unknown()),
    exception: z.unknown(),
    symbolHealth: z.unknown(),
    modules: z.unknown(),
    firstMeaningfulDifference: z.unknown().optional(),
    limitations: z.array(z.string()),
  }).catchall(z.unknown()),
  guidance: z.array(z.string()),
}).catchall(z.unknown());

export const AGENT_OUTPUT_SCHEMAS = {
  debug_this_crash: debugThisCrashOutputSchema,
  debug_this_hang: debugThisHangOutputSchema,
  debug_compare_runs: debugCompareRunsOutputSchema,
  debug_diagnose_stop: debugDiagnoseStopOutputSchema,
  debug_source_disassembly: debugSourceDisassemblyOutputSchema,
  debug_find_writer: debugFindWriterOutputSchema,
  debug_run_to_stop: debugRunToStopOutputSchema,
  debug_open_dump: debugOpenDumpOutputSchema,
  debug_snapshot: debugSnapshotOutputSchema,
  debug_status: debugStatusOutputSchema,
  debug_continue: debugContinueOutputSchema,
  debug_disconnect: debugDisconnectOutputSchema,
  debug_sessions: debugSessionsOutputSchema,
} as const;
