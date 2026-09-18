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

const differentialEvidenceBudgetSchema = z.object({
  timeoutMs: z.number().int().positive(),
  sessions: z.literal(2),
  stackLevels: z.number().int().positive(),
  maxVariablesPerScope: z.number().int().positive(),
  includeDisassembly: z.boolean(),
  disassemblyInstructionsPerSession: z.number().int().nonnegative(),
  includeModules: z.boolean(),
  moduleCountPerSession: z.number().int().nonnegative(),
  includeExceptionInfo: z.boolean(),
});

export const debugCompareRunsOutputSchema = z.object({
  baselineSessionId: z.string(),
  candidateSessionId: z.string(),
  evidenceBudget: differentialEvidenceBudgetSchema,
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

export const debugTraceValueOutputSchema = z.object({
  query: z.object({
    name: z.string(),
    accessType: z.enum(['write', 'readWrite']),
    maxStops: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
    perStopTimeoutMs: z.number().int().positive(),
  }).catchall(z.unknown()),
  events: z.array(z.object({
    index: z.number().int().positive(),
    strategy: z.enum(['dap-data-breakpoint', 'gdb-watch']),
    hitConfirmed: z.boolean(),
    outcome: z.object({ event: z.enum(['stopped', 'exited', 'terminated']), body: z.unknown().optional() }),
    writerFrame: dapFrameSchema.optional(),
    writerCorrelation: z.unknown().optional(),
    beforeValue: z.unknown().optional(),
    afterValue: z.unknown().optional(),
    valueChanged: z.boolean().optional(),
  }).catchall(z.unknown())),
  stopReason: z.enum(['max-stops', 'target-exited', 'target-terminated', 'unrelated-stop', 'no-writer-snapshot', 'error']),
  terminalError: z.string().optional(),
  finalSnapshot: runtimeSnapshotOutputSchema,
  guidance: z.array(z.string()),
  status: sessionStatusOutputSchema,
}).catchall(z.unknown());

export const debugAdvancedOutputSchema = z.object({}).catchall(z.unknown());

export const debugCausalTraceOutputSchema = z.object({
  query: z.object({ name: z.string(), maxDepth: z.number().int().positive() }).catchall(z.unknown()),
  consumer: z.object({ frame: dapFrameSchema, observedValue: z.unknown().optional(), disassembly: z.unknown().optional() }).catchall(z.unknown()),
  producerChain: z.array(z.object({ depth: z.number().int().positive() }).catchall(z.unknown())),
  trace: debugTraceValueOutputSchema,
  conclusion: z.string(),
  limitations: z.array(z.string()),
}).catchall(z.unknown());

export const debugProgressProbeOutputSchema = z.object({
  classification: z.enum(['no-observed-progress', 'probable-busy-loop', 'same-frame-progress', 'forward-progress-observed']),
  samples: z.number().int().positive(),
  intervalMs: z.number().int().positive(),
  captures: z.array(z.object({
    index: z.number().int().positive(),
    signature: z.object({ threadId: z.number().int(), frame: z.string(), source: z.string().optional(), line: z.number().int(), instruction: z.string().optional() }).catchall(z.unknown()),
    topFrames: z.array(z.object({ name: z.string(), source: z.string().optional(), line: z.number().int() }).catchall(z.unknown())),
  }).catchall(z.unknown())),
  evidence: z.object({
    uniqueSampleSignatures: z.number().int().nonnegative(),
    sameSourceFrameAcrossSamples: z.boolean(),
    uniqueInstructionPointers: z.number().int().nonnegative(),
  }),
  limitations: z.array(z.string()),
  status: sessionStatusOutputSchema,
}).catchall(z.unknown());

const fingerprintV2Schema = z.object({
  version: z.literal(2),
  exact: z.string(),
  semantic: z.string(),
  family: z.string(),
  materials: z.unknown(),
  note: z.string(),
}).catchall(z.unknown());

export const debugRuntimeReportOutputSchema = z.object({
  fingerprint: z.string(),
  frameKey: z.string(),
  exceptionKey: z.string(),
  symbolStatus: z.string(),
  sanitizer: z.array(z.unknown()),
  memoryHazards: z.array(z.unknown()),
  abi: z.unknown(),
  symbolDoctor: z.unknown(),
  fingerprintsV2: fingerprintV2Schema,
  apiAnalysis: z.unknown(),
  stackIntegrity: z.unknown(),
  hypotheses: z.array(z.unknown()),
  breakpointPlan: z.unknown(),
  outputTail: z.array(z.string()),
  snapshot: runtimeSnapshotOutputSchema,
  limitations: z.array(z.string()),
}).catchall(z.unknown());

export const debugClusterCrashesOutputSchema = z.object({
  totalReports: z.number().int().nonnegative(),
  clusters: z.array(z.object({
    fingerprint: z.string(),
    count: z.number().int().positive(),
    representative: z.unknown().optional(),
  }).catchall(z.unknown())),
  note: z.string(),
}).catchall(z.unknown());

export const debugRegressionOracleOutputSchema = z.object({
  verdict: z.enum(['original-crash', 'changed-crash', 'inconclusive']),
  baselineFingerprint: z.string(),
  currentFingerprint: z.string(),
  terminal: z.boolean(),
  suitableForBisect: z.boolean(),
  note: z.string(),
}).catchall(z.unknown());

export const debugChildRequestsOutputSchema = z.object({
  requests: z.array(z.unknown()),
  autoAccepted: z.literal(false),
  policy: z.literal('fail-closed'),
  guidance: z.array(z.string()),
}).catchall(z.unknown());

export const debugReverseExecutionOutputSchema = z.object({
  action: z.enum(['reverseContinue', 'stepBack']),
  result: z.unknown(),
  status: sessionStatusOutputSchema,
}).catchall(z.unknown());

export const debugLifetimeTraceOutputSchema = z.object({
  query: z.string(),
  initial: z.object({ frame: dapFrameSchema, observed: z.unknown().optional() }).catchall(z.unknown()),
  sanitizer: z.array(z.unknown()),
  memoryHazards: z.array(z.unknown()),
  allocationDeallocationHints: z.array(z.string()),
  reverseTimeline: z.array(z.unknown()).optional(),
  forwardTimeline: debugTraceValueOutputSchema.optional(),
  guidance: z.array(z.string()),
}).catchall(z.unknown());

export const debugThreadTimelineOutputSchema = z.object({
  observations: z.array(z.unknown()),
  progression: z.array(z.object({
    threadId: z.number().int(),
    samples: z.number().int().nonnegative(),
    uniqueLocations: z.number().int().nonnegative(),
    waitKinds: z.array(z.string()),
  }).catchall(z.unknown())),
  lockGraph: z.object({
    edges: z.array(z.unknown()),
    cycleProven: z.boolean(),
    cycle: z.array(z.unknown()),
    evidenceKind: z.string(),
    limitations: z.array(z.string()),
  }).catchall(z.unknown()),
  stopReason: z.enum(['sample-budget', 'target-exited', 'target-terminated', 'no-threads']),
  completeSampleBudget: z.boolean(),
  status: sessionStatusOutputSchema,
}).catchall(z.unknown());

export const debugSymbolDoctorOutputSchema = z.object({
  symbolHealth: symbolHealthSchema,
  binaryIdentity: z.unknown().optional(),
  pdbIdentity: z.unknown().optional(),
  mismatch: z.unknown(),
  localSearch: z.unknown().optional(),
  resolver: z.object({
    configured: z.boolean(),
    servers: z.array(z.string()),
    candidates: z.array(z.unknown()),
    networkFetchPerformed: z.literal(false),
    note: z.string(),
  }).catchall(z.unknown()),
}).catchall(z.unknown());

export const debugDumpBatchOutputSchema = z.object({
  directory: z.string(),
  selected: z.array(z.string()),
  analyzed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  reports: z.array(z.unknown()),
  errors: z.array(z.unknown()),
  families: z.unknown(),
}).catchall(z.unknown());

export const debugAdaptiveEvidenceOutputSchema = z.object({
  selectedPhase: z.enum(['cheap', 'medium', 'full']),
  expansionReasons: z.array(z.string()),
  evidenceBudget: z.unknown(),
  snapshot: runtimeSnapshotOutputSchema.optional(),
  report: debugRuntimeReportOutputSchema.optional(),
}).catchall(z.unknown());

export const debugCrashFamiliesOutputSchema = z.object({
  totalReports: z.number().int().nonnegative(),
  families: z.array(z.unknown()),
  sharedFamilyCount: z.number().int().nonnegative(),
  note: z.string(),
}).catchall(z.unknown());

export const debugCppObjectOutputSchema = z.object({
  pointer: z.string(),
  observed: z.unknown().optional(),
  pointerSize: z.union([z.literal(4), z.literal(8)]),
  bytesRead: z.number().int().nonnegative(),
  hex: z.string(),
  probableVtable: z.string().optional(),
  vtableModule: z.unknown().optional(),
  abi: z.unknown(),
  hazards: z.array(z.unknown()),
  guidance: z.string(),
}).catchall(z.unknown());

export const debugEvidenceBundleOutputSchema = z.object({
  action: z.enum(['export', 'import']),
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  format: z.enum(['json', 'markdown', 'sarif']).optional(),
  overwritten: z.boolean().optional(),
  evidence: z.unknown().optional(),
  offline: z.boolean().optional(),
  note: z.string().optional(),
}).catchall(z.unknown());

export const debugAdapterDoctorOutputSchema = z.object({
  security: z.unknown(),
  current: z.unknown().optional(),
  installed: z.array(z.unknown()).optional(),
}).catchall(z.unknown());

export const debugTimeTravelOutputSchema = z.object({
  action: z.enum(['doctor', 'record', 'replay-plan', 'replay-start', 'replay-status', 'replay-stop', 'reverse']).optional(),
}).catchall(z.unknown());

export const AGENT_OUTPUT_SCHEMAS = {
  debug_this_crash: debugThisCrashOutputSchema,
  debug_this_hang: debugThisHangOutputSchema,
  debug_compare_runs: debugCompareRunsOutputSchema,
  debug_trace_value: debugTraceValueOutputSchema,
  debug_causal_trace: debugCausalTraceOutputSchema,
  debug_progress_probe: debugProgressProbeOutputSchema,
  debug_runtime_report: debugRuntimeReportOutputSchema,
  debug_trace_lifetime: debugLifetimeTraceOutputSchema,
  debug_adaptive_evidence: debugAdaptiveEvidenceOutputSchema,
  debug_diagnose_stop: debugDiagnoseStopOutputSchema,
  debug_source_disassembly: debugSourceDisassemblyOutputSchema,
  debug_find_writer: debugFindWriterOutputSchema,
  debug_run_to_stop: debugRunToStopOutputSchema,
  debug_open_dump: debugOpenDumpOutputSchema,
  debug_snapshot: debugSnapshotOutputSchema,
  debug_status: debugStatusOutputSchema,
  debug_disconnect: debugDisconnectOutputSchema,
  debug_sessions: debugSessionsOutputSchema,
} as const;
