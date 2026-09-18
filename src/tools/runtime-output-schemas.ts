import * as z from 'zod/v4';

const jsonObject = z.object({}).catchall(z.unknown());
const frame = z.object({
  id: z.number().int().optional(),
  name: z.string(),
  line: z.number().int().optional(),
  column: z.number().int().optional(),
  source: z.unknown().optional(),
  instructionPointerReference: z.string().optional(),
}).catchall(z.unknown());

const status = z.object({
  adapterRunning: z.boolean(),
  initialized: z.boolean(),
  configured: z.boolean(),
  recentEvents: z.array(z.unknown()),
  recentAdapterStderr: z.array(z.string()),
}).catchall(z.unknown());

const fingerprintsV2 = z.object({
  version: z.literal(2),
  exact: z.string(),
  semantic: z.string(),
  family: z.string(),
  materials: jsonObject,
}).catchall(z.unknown());

const hypothesis = z.object({
  id: z.string(),
  title: z.string(),
  evidenceScore: z.number().min(0).max(100),
  supporting: z.array(z.object({
    kind: z.string(),
    weight: z.number(),
    summary: z.string(),
    source: z.string(),
  }).catchall(z.unknown())),
  contradicting: z.array(z.object({
    kind: z.string(),
    weight: z.number(),
    summary: z.string(),
    source: z.string(),
  }).catchall(z.unknown())),
  nextEvidence: z.array(z.string()),
}).catchall(z.unknown());

export const debugCausalTraceOutputSchema = z.object({
  query: z.object({
    name: z.string(),
    maxDepth: z.number().int().positive(),
  }).catchall(z.unknown()),
  consumer: z.object({
    frame,
    observedValue: z.unknown().optional(),
    disassembly: z.unknown().optional(),
  }).catchall(z.unknown()),
  producerChain: z.array(z.object({
    depth: z.number().int().positive(),
    writerFrame: z.unknown().optional(),
    beforeValue: z.unknown().optional(),
    afterValue: z.unknown().optional(),
    valueChanged: z.boolean().optional(),
    evidence: z.unknown().optional(),
  }).catchall(z.unknown())),
  trace: z.unknown(),
  conclusion: z.string(),
  limitations: z.array(z.string()),
}).catchall(z.unknown());

export const debugProgressProbeOutputSchema = z.object({
  classification: z.enum([
    'no-observed-progress',
    'probable-busy-loop',
    'same-frame-progress',
    'forward-progress-observed',
  ]),
  samples: z.number().int().min(2),
  intervalMs: z.number().int().positive(),
  captures: z.array(z.object({
    index: z.number().int().positive(),
    signature: jsonObject,
    topFrames: z.array(jsonObject),
  }).catchall(z.unknown())),
  evidence: z.object({
    uniqueSampleSignatures: z.number().int().nonnegative(),
    sameSourceFrameAcrossSamples: z.boolean(),
    uniqueInstructionPointers: z.number().int().nonnegative(),
  }).catchall(z.unknown()),
  limitations: z.array(z.string()),
  status,
}).catchall(z.unknown());

export const debugReverseExecutionOutputSchema = z.object({
  action: z.enum(['reverseContinue', 'stepBack']),
  result: z.unknown(),
  status,
}).catchall(z.unknown());

export const debugRuntimeReportOutputSchema = z.object({
  fingerprint: z.string(),
  frameKey: z.string(),
  exceptionKey: z.string(),
  symbolStatus: z.string(),
  sanitizer: z.array(jsonObject),
  memoryHazards: z.array(jsonObject),
  abi: jsonObject,
  symbolDoctor: jsonObject,
  fingerprintsV2,
  apiAnalysis: jsonObject,
  stackIntegrity: z.object({
    severity: z.enum(['high', 'medium', 'low', 'none']),
    findings: z.array(jsonObject),
    limitations: z.array(z.string()),
  }).catchall(z.unknown()),
  hypotheses: z.array(hypothesis),
  breakpointPlan: jsonObject,
  outputTail: z.array(z.string()),
  snapshot: z.unknown(),
  limitations: z.array(z.string()),
}).catchall(z.unknown());

export const debugClusterCrashesOutputSchema = z.object({
  totalReports: z.number().int().nonnegative(),
  clusters: z.array(z.object({
    fingerprint: z.string(),
    count: z.number().int().positive(),
    representative: z.unknown(),
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
  requests: z.array(z.object({
    receivedAt: z.string(),
    command: z.string(),
    arguments: z.unknown().optional(),
  }).catchall(z.unknown())),
  autoAccepted: z.boolean(),
  policy: z.string(),
  guidance: z.array(z.string()),
}).catchall(z.unknown());

export const debugTimeTravelOutputSchema = z.object({
  action: z.enum(['doctor', 'record', 'replay-plan', 'replay-start', 'replay-status', 'replay-stop', 'reverse']),
}).catchall(z.unknown());

export const debugTraceLifetimeOutputSchema = z.object({
  query: z.string(),
  initial: z.object({
    frame,
    observed: z.unknown().optional(),
  }).catchall(z.unknown()),
  sanitizer: z.array(jsonObject),
  memoryHazards: z.array(jsonObject),
  allocationDeallocationHints: z.array(z.string()),
  reverseTimeline: z.array(jsonObject).optional(),
  forwardTimeline: z.unknown().optional(),
  guidance: z.array(z.string()),
}).catchall(z.unknown());

export const debugThreadTimelineOutputSchema = z.object({
  observations: z.array(z.object({
    sample: z.number().int().positive(),
    threadId: z.number().int().positive(),
    threadName: z.string(),
    waitKind: z.enum(['lock', 'join', 'condition', 'io', 'sleep', 'runnable-or-unknown']),
    resources: z.array(jsonObject),
  }).catchall(z.unknown())),
  progression: z.array(z.object({
    threadId: z.number().int().positive(),
    samples: z.number().int().positive(),
    uniqueLocations: z.number().int().nonnegative(),
    waitKinds: z.array(z.string()),
  }).catchall(z.unknown())),
  lockGraph: z.object({
    edges: z.array(jsonObject),
    cycleProven: z.boolean(),
    cycle: z.array(jsonObject),
    evidenceKind: z.string(),
    limitations: z.array(z.string()),
  }).catchall(z.unknown()),
  status,
}).catchall(z.unknown());

export const debugSymbolDoctorOutputSchema = z.object({
  symbolHealth: z.unknown(),
  binaryIdentity: z.unknown().optional(),
  pdbIdentity: z.unknown().optional(),
  mismatch: z.object({
    status: z.string(),
    issues: z.array(jsonObject),
    limitations: z.array(z.string()),
  }).catchall(z.unknown()),
  localSearch: z.unknown().optional(),
  resolver: z.object({
    configured: z.boolean(),
    servers: z.array(z.string()),
    candidates: z.array(jsonObject),
    networkFetchPerformed: z.boolean(),
    note: z.string(),
  }).catchall(z.unknown()),
}).catchall(z.unknown());

export const debugDumpBatchOutputSchema = z.object({
  directory: z.string(),
  selected: z.array(z.string()),
  analyzed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  reports: z.array(jsonObject),
  errors: z.array(jsonObject),
  families: z.unknown(),
}).catchall(z.unknown());

export const debugAdaptiveEvidenceOutputSchema = z.object({
  selectedPhase: z.enum(['cheap', 'medium', 'full']),
  expansionReasons: z.array(z.string()),
  evidenceBudget: jsonObject,
  snapshot: z.unknown().optional(),
  report: z.unknown().optional(),
}).catchall(z.unknown());

export const debugCrashFamiliesOutputSchema = z.object({
  totalReports: z.number().int().nonnegative(),
  families: z.array(z.object({
    family: z.string(),
    count: z.number().int().positive(),
    semanticVariants: z.number().int().positive(),
    exactVariants: z.number().int().positive(),
    members: z.array(z.string()),
    representative: z.unknown(),
  }).catchall(z.unknown())),
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
  abi: jsonObject,
  hazards: z.array(jsonObject),
  guidance: z.string(),
}).catchall(z.unknown());

export const debugEvidenceBundleOutputSchema = z.object({
  action: z.enum(['export', 'import']),
}).catchall(z.unknown());

export const debugAdapterDoctorOutputSchema = z.object({
  security: jsonObject,
  current: z.object({
    status,
    capabilityMatrix: z.object({
      modules: z.boolean(),
      disassembly: z.boolean(),
      memoryRead: z.boolean(),
      exceptionInfo: z.boolean(),
      dataBreakpoints: z.boolean(),
      reverseExecution: z.boolean(),
      functionBreakpoints: z.boolean(),
      instructionBreakpoints: z.boolean(),
    }).catchall(z.unknown()),
  }).catchall(z.unknown()).optional(),
  installed: z.array(z.object({
    name: z.string(),
    available: z.boolean(),
    details: z.unknown().optional(),
    error: z.string().optional(),
  }).catchall(z.unknown())).optional(),
}).catchall(z.unknown());

export const RUNTIME_FORENSIC_OUTPUT_SCHEMAS = {
  debug_causal_trace: debugCausalTraceOutputSchema,
  debug_progress_probe: debugProgressProbeOutputSchema,
  debug_reverse_execution: debugReverseExecutionOutputSchema,
  debug_runtime_report: debugRuntimeReportOutputSchema,
  debug_cluster_crashes: debugClusterCrashesOutputSchema,
  debug_regression_oracle: debugRegressionOracleOutputSchema,
  debug_child_requests: debugChildRequestsOutputSchema,
  debug_time_travel: debugTimeTravelOutputSchema,
  debug_trace_lifetime: debugTraceLifetimeOutputSchema,
  debug_thread_timeline: debugThreadTimelineOutputSchema,
  debug_symbol_doctor: debugSymbolDoctorOutputSchema,
  debug_dump_batch: debugDumpBatchOutputSchema,
  debug_adaptive_evidence: debugAdaptiveEvidenceOutputSchema,
  debug_crash_families: debugCrashFamiliesOutputSchema,
  debug_cpp_object: debugCppObjectOutputSchema,
  debug_evidence_bundle: debugEvidenceBundleOutputSchema,
  debug_adapter_doctor: debugAdapterDoctorOutputSchema,
} as const;
