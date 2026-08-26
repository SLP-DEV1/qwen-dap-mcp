import type { McpServer } from '@modelcontextprotocol/server';
import type { DebugProtocol } from '@vscode/debugprotocol';
import * as z from 'zod/v4';

import { buildCodeLldbLaunchConfiguration, discoverCodeLldb } from '../adapters/codelldb.js';
import { buildLldbDapLaunchConfiguration, discoverLldbDap } from '../adapters/lldb-dap.js';
import { analyzeRuntimeSnapshot, correlateSourceDisassembly } from '../diagnostics/analyze-snapshot.js';
import {
  advanceAutonomousCycle,
  refreshAutonomousEvidence,
  startAutonomousCycle,
  type AutonomousAgentState,
} from '../diagnostics/autonomous-cycle.js';
import {
  analyzeInstructionOperands,
  buildIntelligentDiagnosis,
  compareVerificationBaseline,
  selectProjectFrame,
  type FrameEvidence,
  type IntelligentCrashDiagnosis,
  type IntelligentDiagnosisOptions,
  type VerificationBaseline,
} from '../diagnostics/intelligent-diagnosis.js';
import { DapError } from '../dap/errors.js';
import type { RuntimeSnapshot, RuntimeSnapshotOptions, SourceBreakpointGroup } from '../dap/session.js';
import { GuardedDapSession } from '../dap/guarded-session.js';
import { logger } from '../logger.js';
import { openDump, type OpenDumpOptions } from './register-dump-tools.js';
import { runToStop } from './run-to-stop.js';
import { LOCAL_TARGET_EXECUTION_ANNOTATIONS, READ_ONLY_LOCAL_TOOL_ANNOTATIONS } from './tool-annotations.js';

const jsonRecord = z.record(z.string(), z.unknown()).describe('Adapter-specific DAP launch or attach configuration object.');
const breakpointGroupSchema = z.object({
  source: z.string().min(1).describe('Absolute or adapter-resolvable source file path.'),
  lines: z.array(z.number().int().positive()).min(1).describe('One or more 1-based source line numbers to replace as breakpoints for this source file.'),
}).describe('Source file and line breakpoints configured before a live reproduction runs.');
const snapshotSchema = z.object({
  threadId: z.number().int().positive().optional().describe('Stopped DAP thread to inspect; omit to use the session-selected stopped thread.'),
  stackLevels: z.number().int().positive().max(100).default(20).describe('Maximum number of stack frames to inspect when collecting crash evidence.'),
  maxVariablesPerScope: z.number().int().positive().max(500).default(100).describe('Maximum variables returned per inspected scope, bounding evidence size.'),
  includeDisassembly: z.boolean().default(true).describe('Include best-effort disassembly around the selected instruction pointer when supported.'),
  disassembleBefore: z.number().int().nonnegative().max(100).default(8).describe('Number of instructions before the selected instruction to request.'),
  disassembleAfter: z.number().int().nonnegative().max(100).default(12).describe('Number of instructions after the selected instruction to request.'),
  includeModules: z.boolean().default(true).describe('Include a bounded list of loaded executable images and libraries.'),
  moduleCount: z.number().int().positive().max(500).default(100).describe('Maximum loaded modules to include when module collection is enabled.'),
  includeExceptionInfo: z.boolean().default(true).describe('Request structured exception information for the stopped thread when supported.'),
}).describe('Bounds and optional evidence categories for a runtime crash snapshot.');
const analysisSchema = z.object({
  projectRoots: z.array(z.string().min(1)).max(20).optional().describe('Optional local source-root paths used to recognize project-controlled stack frames.'),
  projectModules: z.array(z.string().min(1)).max(50).optional().describe('Optional executable or library names treated as project-controlled modules during frame selection.'),
  callerDepth: z.number().int().nonnegative().max(8).default(3).describe('How many project-controlled caller frames beyond the selected frame to inspect for provenance and root cause.'),
}).describe('Hints used to distinguish project code from runtime, system, or third-party frames.');
const diagnosisCategorySchema = z.enum([
  'access-violation',
  'segmentation-fault',
  'stack-overflow',
  'divide-by-zero',
  'illegal-instruction',
  'abort-or-assert',
  'heap-corruption',
  'exception',
  'signal',
  'breakpoint',
  'entry',
  'manual-stop',
  'step',
  'unknown',
]);
const diagnosisConfidenceSchema = z.enum(['low', 'medium', 'high']);
const verificationVerdictSchema = z.enum(['fixed', 'not-fixed', 'changed-failure', 'inconclusive']);
const verificationBaselineSchema = z.object({
  classification: diagnosisCategorySchema,
  crashLikely: z.boolean(),
  faultFunction: z.string(),
  projectFunction: z.string(),
  projectSourcePath: z.string().optional(),
  projectLine: z.number().int().nonnegative(),
  hypothesisKinds: z.array(z.string()).max(8),
  suspiciousNames: z.array(z.string()).max(12),
});
const autonomousAgentStatusSchema = z.enum([
  'needs-evidence',
  'needs-fix',
  'retry-fix',
  'needs-reproduction',
  'changed-failure',
  'fixed',
  'budget-exhausted',
  'blocked',
]);
const autonomousHistorySchema = z.object({
  iteration: z.number().int().nonnegative(),
  phase: z.enum(['diagnosis', 'verification']),
  fingerprint: z.string().min(8).max(64),
  verdict: verificationVerdictSchema.optional(),
  confidence: diagnosisConfidenceSchema.optional(),
  projectFunction: z.string().optional(),
  projectSourcePath: z.string().optional(),
  projectLine: z.number().int().nonnegative().optional(),
  summary: z.string(),
});
const autonomousAgentStateSchema = z.object({
  schemaVersion: z.literal(1),
  iteration: z.number().int().positive().max(10),
  maxIterations: z.number().int().positive().max(10),
  status: autonomousAgentStatusSchema,
  rootBaseline: verificationBaselineSchema,
  activeBaseline: verificationBaselineSchema,
  rootFingerprint: z.string().min(8).max(64),
  activeFingerprint: z.string().min(8).max(64),
  history: z.array(autonomousHistorySchema).max(24),
});
const workflowSchema = z.object({
  stage: z.enum(['diagnose', 'verify', 'autonomous']).default('diagnose').describe('diagnose creates initial evidence; verify compares against a prior verification baseline; autonomous advances the bounded agent state machine.'),
  baseline: verificationBaselineSchema.optional().describe('Verification baseline returned by an earlier diagnosis; required when stage=verify.'),
  agentState: autonomousAgentStateSchema.optional().describe('Opaque autonomous state returned by the previous autonomous call; pass it back unchanged to continue the bounded cycle.'),
  maxIterations: z.number().int().positive().max(10).default(3).describe('Maximum autonomous fix/reproduce iterations allowed when starting stage=autonomous.'),
}).describe('Controls one-shot diagnosis, explicit verification, or the bounded autonomous crash workflow.');

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function terminalOutcomeDiagnosis(outcome: { event: 'exited' | 'terminated'; body?: unknown }) {
  const body = outcome.body as { exitCode?: number } | undefined;
  const exitCode = typeof body?.exitCode === 'number' ? body.exitCode : undefined;
  const abnormalExit = exitCode !== undefined && exitCode !== 0;

  return {
    summary: outcome.event === 'exited'
      ? `The debuggee exited before a stopped-state snapshot was available${exitCode === undefined ? '.' : ` with exit code ${exitCode}.`}`
      : 'The debuggee terminated before a stopped-state snapshot was available.',
    classification: {
      category: outcome.event === 'exited' ? 'process-exit' : 'terminated',
      crashLikely: abnormalExit,
      confidence: exitCode === undefined ? 'low' : 'medium',
    },
    ...(exitCode === undefined ? {} : { exitCode }),
    hypotheses: [],
    nextActions: abnormalExit
      ? [
          'Re-run with exception/signal breakpoints enabled so the debugger stops before process termination.',
          'Inspect recent adapter events/stderr for the first fatal signal or exception.',
          'Collect a crash dump if the runtime exits too quickly to preserve a live stop.',
        ]
      : [
          'No fatal stopped event was captured; confirm whether this exit was expected.',
          'Add a breakpoint or exception filter if a stop was expected before process exit.',
        ],
  };
}

function dedupeVariables(variables: DebugProtocol.Variable[]): DebugProtocol.Variable[] {
  const seen = new Set<string>();
  const output: DebugProtocol.Variable[] = [];
  for (const variable of variables) {
    const key = `${variable.name}\u0000${variable.value}\u0000${variable.type ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(variable);
  }
  return output;
}

async function captureFrameEvidence(
  session: GuardedDapSession,
  frame: DebugProtocol.StackFrame,
  index: number,
  options: RuntimeSnapshotOptions,
  includeDisassembly: boolean,
): Promise<FrameEvidence> {
  const maxVariables = options.maxVariablesPerScope ?? 100;
  const collectionErrors: string[] = [];
  let scopes: DebugProtocol.Scope[] = [];
  try {
    scopes = await session.scopes(frame.id);
  } catch (error) {
    collectionErrors.push(`scopes: ${error instanceof Error ? error.message : String(error)}`);
  }

  const localScopes = scopes.filter((scope) => /locals?|arguments?|parameters?/i.test(scope.name));
  const registerScope = scopes.find((scope) => /register/i.test(scope.name));

  const locals: DebugProtocol.Variable[] = [];
  for (const scope of localScopes.slice(0, 3)) {
    if (scope.variablesReference <= 0) continue;
    try {
      locals.push(...await session.variables(scope.variablesReference, 0, maxVariables));
    } catch (error) {
      collectionErrors.push(`${scope.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let registers: DebugProtocol.Variable[] = [];
  if (registerScope && registerScope.variablesReference > 0) {
    try {
      registers = await session.variables(registerScope.variablesReference, 0, maxVariables);
    } catch (error) {
      collectionErrors.push(`registers: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let disassembly: DebugProtocol.DisassembledInstruction[] | undefined;
  if (includeDisassembly && frame.instructionPointerReference) {
    try {
      const before = options.disassembleBefore ?? 8;
      const after = options.disassembleAfter ?? 12;
      disassembly = await session.disassemble(
        frame.instructionPointerReference,
        before + after + 1,
        -before,
        0,
        true,
      );
    } catch (error) {
      collectionErrors.push(`disassembly: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    index,
    frame,
    locals: dedupeVariables(locals).slice(0, maxVariables * Math.max(1, Math.min(3, localScopes.length))),
    registers: dedupeVariables(registers).slice(0, maxVariables),
    ...(disassembly === undefined ? {} : { disassembly }),
    ...(collectionErrors.length === 0 ? {} : { collectionErrors }),
  };
}

function mergedAnalysisOptions(
  analysis: IntelligentDiagnosisOptions | undefined,
  program?: string,
  cwd?: string,
): IntelligentDiagnosisOptions {
  return {
    ...(analysis ?? {}),
    ...(program ? { program } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

async function diagnoseSnapshot(
  session: GuardedDapSession,
  snapshot: RuntimeSnapshot,
  snapshotOptions: RuntimeSnapshotOptions,
  analysisOptions: IntelligentDiagnosisOptions,
): Promise<IntelligentCrashDiagnosis> {
  const base = analyzeRuntimeSnapshot(snapshot);
  const selection = selectProjectFrame(snapshot.stack, analysisOptions);
  const callerDepth = analysisOptions.callerDepth ?? 3;
  const evidenceIndexes = [
    selection.selected.index,
    ...selection.assessments
      .filter((item) => item.index > selection.selected.index && item.projectControlled)
      .slice(0, callerDepth)
      .map((item) => item.index),
  ];

  const evidence: FrameEvidence[] = [];
  for (const index of [...new Set(evidenceIndexes)]) {
    const frame = snapshot.stack[index];
    if (!frame) continue;
    if (index === 0) {
      evidence.push({
        index,
        frame,
        locals: snapshot.locals,
        registers: snapshot.registers,
        ...(snapshot.disassembly === undefined ? {} : { disassembly: snapshot.disassembly }),
        ...(snapshot.collectionErrors?.length
          ? { collectionErrors: snapshot.collectionErrors.map((item) => `${item.operation}: ${item.message}`) }
          : {}),
      });
      continue;
    }
    evidence.push(await captureFrameEvidence(
      session,
      frame,
      index,
      snapshotOptions,
      index === selection.selected.index,
    ));
  }

  return buildIntelligentDiagnosis(snapshot, base, selection, evidence);
}

async function captureDiagnosticSnapshot(
  session: GuardedDapSession,
  options: RuntimeSnapshotOptions = {},
  analysisOptions: IntelligentDiagnosisOptions = {},
) {
  const snapshot = await session.runtimeSnapshot({
    ...options,
    includeDisassembly: options.includeDisassembly ?? true,
    includeModules: options.includeModules ?? true,
    includeExceptionInfo: options.includeExceptionInfo ?? true,
  });
  return {
    snapshot,
    diagnosis: await diagnoseSnapshot(session, snapshot, options, analysisOptions),
  };
}

function terminalForVerification(outcome: { event: 'exited' | 'terminated'; body?: unknown }) {
  const body = outcome.body as { exitCode?: number } | undefined;
  return {
    event: outcome.event,
    ...(typeof body?.exitCode === 'number' ? { exitCode: body.exitCode } : {}),
  };
}

function workflowMetadata(
  stage: 'diagnose' | 'verify' | 'autonomous',
  baseline: VerificationBaseline | undefined,
  diagnosis?: IntelligentCrashDiagnosis,
  terminal?: { event: 'exited' | 'terminated'; exitCode?: number },
  agentState?: AutonomousAgentState,
  maxIterations?: number,
) {
  if (stage === 'verify' && !baseline) {
    throw new DapError('debug_this_crash workflow.stage="verify" requires the verificationBaseline returned by the original diagnosis.');
  }

  if (stage === 'autonomous') {
    if (!agentState) {
      if (!diagnosis) {
        return {
          stage,
          autonomousAgent: {
            protocolVersion: 2,
            shouldContinue: false,
            status: 'blocked',
            stopReason: terminal?.event === 'exited' && terminal.exitCode === 0
              ? 'The initial autonomous reproduction exited cleanly; no crash stop was observed to diagnose.'
              : 'The initial autonomous reproduction did not produce a stopped-state crash diagnosis.',
            nextActions: [],
          },
        };
      }
      return {
        stage,
        verificationBaseline: diagnosis.verificationBaseline,
        fixWorkflow: diagnosis.fixWorkflow,
        autonomousAgent: startAutonomousCycle(diagnosis, maxIterations),
      };
    }

    // Evidence collection is not a fix attempt. Refresh the baseline/selection
    // without incrementing the iteration or consuming the autonomous budget.
    if (agentState.status === 'needs-evidence') {
      if (!diagnosis) {
        return {
          stage,
          verification: compareVerificationBaseline(agentState.activeBaseline, undefined, terminal),
          autonomousAgent: {
            protocolVersion: 2,
            state: agentState,
            shouldContinue: true,
            nextActions: [],
            stopReason: 'Evidence refresh did not produce a stopped-state diagnosis; repeat the evidence collection with a complete crash stop.',
          },
        };
      }
      return {
        stage,
        verificationBaseline: diagnosis.verificationBaseline,
        fixWorkflow: diagnosis.fixWorkflow,
        autonomousAgent: refreshAutonomousEvidence(agentState, diagnosis),
      };
    }

    const verification = compareVerificationBaseline(agentState.activeBaseline, diagnosis, terminal);
    return {
      stage,
      ...(diagnosis
        ? {
            verificationBaseline: diagnosis.verificationBaseline,
            fixWorkflow: diagnosis.fixWorkflow,
          }
        : {}),
      verification,
      autonomousAgent: advanceAutonomousCycle(agentState, verification, diagnosis),
    };
  }

  return {
    stage,
    ...(diagnosis
      ? {
          verificationBaseline: diagnosis.verificationBaseline,
          fixWorkflow: diagnosis.fixWorkflow,
        }
      : {}),
    ...(stage === 'verify' && baseline
      ? { verification: compareVerificationBaseline(baseline, diagnosis, terminal) }
      : {}),
  };
}

async function resetOwnedSessionAfterFailure(session: GuardedDapSession, error: unknown): Promise<never> {
  try {
    await session.reset();
  } catch (cleanupError) {
    logger.warn('Failed to reset owned debugger session after high-level workflow failure', {
      cleanupError: cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
    });
  }
  throw error;
}

export function registerAgentDiagnosticTools(server: McpServer, session: GuardedDapSession): void {
  server.registerTool(
    'debug_diagnose_stop',
    {
      title: 'Diagnose Current Debug Stop',
      description:
        'Diagnose an already stopped live or postmortem debug session without changing execution state. Use this when a debugger has captured the failure and you want project-frame selection, crash classification, operand/register/variable bindings, call-chain provenance, ranked hypotheses, and a fix/rebuild/reproduce/verify plan; use debug_snapshot instead when only raw evidence is needed. The tool is read-only and returns both the bounded snapshot and the derived diagnosis, including collection limitations when optional debugger evidence is unavailable.',
      annotations: READ_ONLY_LOCAL_TOOL_ANNOTATIONS,
      inputSchema: snapshotSchema.extend({ analysis: analysisSchema.optional() }),
    },
    async ({ analysis, ...options }) => {
      try {
        return result(await captureDiagnosticSnapshot(
          session,
          options as RuntimeSnapshotOptions,
          analysis as IntelligentDiagnosisOptions | undefined,
        ));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'debug_source_disassembly',
    {
      title: 'Correlate Source and Disassembly',
      description:
        'Correlate source locations, disassembly, registers, and pointer-like locals for the raw fault frame and the first likely project-controlled frame. Use this for low-level root-cause evidence when a crash is already stopped and instruction/operand provenance matters; prefer debug_diagnose_stop for a broader ranked diagnosis. This is read-only, does not resume the target, and returns frame-selection reasoning, both correlations, operand bindings, and any best-effort collection errors.',
      annotations: READ_ONLY_LOCAL_TOOL_ANNOTATIONS,
      inputSchema: z.object({
        threadId: z.number().int().positive().optional().describe('Stopped DAP thread to inspect; omit to use the session-selected stopped thread.'),
        stackLevels: z.number().int().positive().max(100).default(12).describe('Maximum stack frames considered while selecting the project-controlled frame.'),
        disassembleBefore: z.number().int().nonnegative().max(100).default(8).describe('Instructions before the selected instruction included in each disassembly window.'),
        disassembleAfter: z.number().int().nonnegative().max(100).default(12).describe('Instructions after the selected instruction included in each disassembly window.'),
        analysis: analysisSchema.optional(),
      }),
    },
    async ({ threadId, stackLevels, disassembleBefore, disassembleAfter, analysis }) => {
      try {
        const snapshotOptions: RuntimeSnapshotOptions = {
          ...(threadId === undefined ? {} : { threadId }),
          stackLevels,
          maxVariablesPerScope: 40,
          includeDisassembly: true,
          disassembleBefore,
          disassembleAfter,
          includeModules: false,
          includeExceptionInfo: false,
        };
        const snapshot = await session.runtimeSnapshot(snapshotOptions);
        const selection = selectProjectFrame(snapshot.stack, analysis as IntelligentDiagnosisOptions | undefined);
        const selectedFrame = snapshot.stack[selection.selected.index];
        if (!selectedFrame) throw new DapError('Unable to resolve the selected project frame.');
        const evidence = selection.selected.index === 0
          ? {
              index: 0,
              frame: selectedFrame,
              locals: snapshot.locals,
              registers: snapshot.registers,
              ...(snapshot.disassembly === undefined ? {} : { disassembly: snapshot.disassembly }),
            }
          : await captureFrameEvidence(session, selectedFrame, selection.selected.index, snapshotOptions, true);
        const projectSnapshot: RuntimeSnapshot = {
          ...snapshot,
          frame: selectedFrame,
          locals: evidence.locals,
          registers: evidence.registers,
          disassembly: evidence.disassembly ?? [],
        };

        return result({
          frameSelection: selection,
          faultCorrelation: correlateSourceDisassembly(snapshot),
          projectCorrelation: correlateSourceDisassembly(projectSnapshot),
          projectFrame: selectedFrame,
          operandAnalysis: analyzeInstructionOperands(evidence),
          ...(evidence.collectionErrors?.length ? { collectionErrors: evidence.collectionErrors } : {}),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'debug_this_crash',
    {
      title: 'Debug This Crash',
      description:
        'Preferred high-level native crash workflow. Use mode=current for an already stopped session, dump for read-only postmortem analysis, codelldb to discover CodeLLDB and launch a local binary, lldb-dap to discover upstream LLVM lldb-dap and launch a local binary, or live with an already initialized generic DAP adapter. Do not use codelldb/lldb-dap/live when executing or attaching to the target is not authorized: those modes can run application code and cause its normal side effects, while current/dump only inspect stopped evidence. workflow.stage selects initial diagnosis, verification against a prior baseline, or the bounded autonomous cycle. Returns runtime evidence, diagnosis, verification/autonomous metadata, and debugger status with deterministic fixed/blocked/budget-exhausted outcomes where applicable.',
      annotations: LOCAL_TARGET_EXECUTION_ANNOTATIONS,
      inputSchema: z.object({
        mode: z.enum(['current', 'live', 'codelldb', 'lldb-dap', 'dump']).default('current').describe('current inspects an existing stop; live runs launch/attach through an initialized DAP session; codelldb starts CodeLLDB; lldb-dap starts upstream LLVM lldb-dap; dump opens a frozen core/minidump.'),
        request: z.enum(['launch', 'attach']).default('launch').describe('For mode=live, choose whether the initialized DAP adapter launches a target or attaches to an existing authorized target.'),
        configuration: jsonRecord.optional().describe('Required for mode=live: adapter-specific DAP launch/attach configuration.'),
        breakpoints: z.array(breakpointGroupSchema).optional().describe('Optional source breakpoints configured before a live/codelldb reproduction completes setup.'),
        timeoutMs: z.number().int().min(1000).max(120000).default(30000).describe('Maximum milliseconds to wait for the reproduction to stop, exit, or terminate.'),
        program: z.string().min(1).optional().describe('Required for mode=codelldb and mode=lldb-dap; optional for CodeLLDB dumps but required when dumpAdapter=lldb-dap. Local path to the native executable.'),
        args: z.array(z.string()).optional().describe('Command-line arguments passed to the launched program in mode=codelldb or mode=lldb-dap.'),
        cwd: z.string().optional().describe('Working directory for the selected debugger/target launch and a project-root hint for diagnosis.'),
        env: z.record(z.string(), z.string()).optional().describe('Environment variables supplied to the launched program in mode=codelldb or mode=lldb-dap.'),
        stopOnEntry: z.boolean().default(false).describe('When true in mode=codelldb or mode=lldb-dap, request an initial debugger stop at program entry before normal execution.'),
        adapterPath: z.string().min(1).optional().describe('Optional explicit debugger-adapter executable path for codelldb/lldb-dap/dump modes; omit to auto-discover the selected adapter.'),
        dumpAdapter: z.enum(['codelldb', 'lldb-dap']).default('codelldb').describe('For mode=dump, choose CodeLLDB compatibility behavior or upstream LLVM lldb-dap coreFile loading.'),
        requestTimeoutMs: z.number().int().min(1000).max(120000).default(30000).describe('Per-request DAP timeout in milliseconds for CodeLLDB operations.'),
        dumpPath: z.string().min(1).optional().describe('Required for mode=dump: local path to the native core/minidump file.'),
        sourceMap: z.record(z.string(), z.string()).optional().describe('For mode=dump, map source paths stored in debug symbols to local source paths.'),
        snapshot: snapshotSchema.optional(),
        analysis: analysisSchema.optional(),
        workflow: workflowSchema.optional(),
      }),
    },
    async ({
      mode,
      request,
      configuration,
      breakpoints,
      timeoutMs,
      program,
      args,
      cwd,
      env,
      stopOnEntry,
      adapterPath,
      dumpAdapter,
      requestTimeoutMs,
      dumpPath,
      sourceMap,
      snapshot,
      analysis,
      workflow,
    }) => {
      try {
        return result(await session.runExclusiveLifecycle('debug this crash', async () => {
          const snapshotOptions = (snapshot ?? {}) as RuntimeSnapshotOptions;
          const analysisOptions = mergedAnalysisOptions(
            analysis as IntelligentDiagnosisOptions | undefined,
            program,
            cwd,
          );
          const stage = workflow?.stage ?? 'diagnose';
          const baseline = workflow?.baseline as VerificationBaseline | undefined;
          const agentState = workflow?.agentState as AutonomousAgentState | undefined;
          const maxIterations = workflow?.maxIterations ?? 3;

          if (mode === 'current') {
            const captured = await captureDiagnosticSnapshot(session, snapshotOptions, analysisOptions);
            return {
              mode,
              ...captured,
              workflow: workflowMetadata(stage, baseline, captured.diagnosis, undefined, agentState, maxIterations),
              status: session.snapshot(),
            };
          }

          if (mode === 'dump') {
            if (!dumpPath) throw new DapError("debug_this_crash mode='dump' requires dumpPath.");
            const opened = await openDump(session, {
              dumpPath,
              ...(program ? { program } : {}),
              ...(sourceMap ? { sourceMap } : {}),
              adapter: dumpAdapter,
              ...(adapterPath ? { adapterPath } : {}),
              ...(cwd ? { cwd } : {}),
              requestTimeoutMs,
              ...(snapshotOptions.threadId === undefined ? {} : { threadId: snapshotOptions.threadId }),
              stackLevels: snapshotOptions.stackLevels ?? 20,
              maxVariablesPerScope: snapshotOptions.maxVariablesPerScope ?? 100,
              includeDisassembly: true,
              includeModules: true,
              moduleCount: snapshotOptions.moduleCount ?? 100,
            } satisfies OpenDumpOptions);
            const diagnosis = await diagnoseSnapshot(session, opened.snapshot, snapshotOptions, analysisOptions);
            return {
              mode,
              dump: opened,
              diagnosis,
              workflow: workflowMetadata(stage, baseline, diagnosis, undefined, agentState, maxIterations),
              status: session.snapshot(),
            };
          }

          if (mode === 'lldb-dap') {
            if (!program) throw new DapError("debug_this_crash mode='lldb-dap' requires program.");

            const launchConfiguration = buildLldbDapLaunchConfiguration({
              program,
              ...(args ? { args } : {}),
              ...(cwd ? { cwd } : {}),
              ...(env ? { env } : {}),
              stopOnEntry,
            });
            const adapter = discoverLldbDap({
              ...(adapterPath ? { explicitPath: adapterPath } : {}),
            });

            let adapterStarted = false;
            try {
              const capabilities = await session.start({
                command: adapter.command,
                adapterId: 'lldb-dap',
                ...(cwd ? { cwd } : {}),
                requestTimeoutMs,
              });
              adapterStarted = true;
              const run = await runToStop(session, {
                request: 'launch',
                configuration: launchConfiguration,
                ...(breakpoints ? { breakpoints: breakpoints as SourceBreakpointGroup[] } : {}),
                timeoutMs,
                snapshot: {
                  ...snapshotOptions,
                  includeDisassembly: true,
                  includeModules: true,
                  includeExceptionInfo: true,
                },
              });
              const diagnosis = run.snapshot
                ? await diagnoseSnapshot(session, run.snapshot, snapshotOptions, analysisOptions)
                : undefined;
              const terminal = run.snapshot
                ? undefined
                : terminalForVerification(run.outcome as { event: 'exited' | 'terminated'; body?: unknown });
              return {
                mode,
                adapter,
                capabilities,
                run,
                diagnosis: diagnosis
                  ?? terminalOutcomeDiagnosis(run.outcome as { event: 'exited' | 'terminated'; body?: unknown }),
                workflow: workflowMetadata(stage, baseline, diagnosis, terminal, agentState, maxIterations),
                status: session.snapshot(),
              };
            } catch (error) {
              if (adapterStarted) return await resetOwnedSessionAfterFailure(session, error);
              throw error;
            }
          }

          if (mode === 'codelldb') {
            if (!program) throw new DapError("debug_this_crash mode='codelldb' requires program.");

            const launchConfiguration = buildCodeLldbLaunchConfiguration({
              program,
              ...(args ? { args } : {}),
              ...(cwd ? { cwd } : {}),
              ...(env ? { env } : {}),
              stopOnEntry,
            });
            const adapter = discoverCodeLldb({
              ...(adapterPath ? { explicitPath: adapterPath } : {}),
            });

            let adapterStarted = false;
            try {
              const capabilities = await session.start({
                command: adapter.command,
                adapterId: 'lldb',
                ...(cwd ? { cwd } : {}),
                requestTimeoutMs,
              });
              adapterStarted = true;
              const run = await runToStop(session, {
                request: 'launch',
                configuration: launchConfiguration,
                ...(breakpoints ? { breakpoints: breakpoints as SourceBreakpointGroup[] } : {}),
                timeoutMs,
                snapshot: {
                  ...snapshotOptions,
                  includeDisassembly: true,
                  includeModules: true,
                  includeExceptionInfo: true,
                },
              });
              const diagnosis = run.snapshot
                ? await diagnoseSnapshot(session, run.snapshot, snapshotOptions, analysisOptions)
                : undefined;
              const terminal = run.snapshot
                ? undefined
                : terminalForVerification(run.outcome as { event: 'exited' | 'terminated'; body?: unknown });
              return {
                mode,
                adapter,
                capabilities,
                run,
                diagnosis: diagnosis
                  ?? terminalOutcomeDiagnosis(run.outcome as { event: 'exited' | 'terminated'; body?: unknown }),
                workflow: workflowMetadata(stage, baseline, diagnosis, terminal, agentState, maxIterations),
                status: session.snapshot(),
              };
            } catch (error) {
              if (adapterStarted) return await resetOwnedSessionAfterFailure(session, error);
              throw error;
            }
          }

          if (!configuration) throw new DapError("debug_this_crash mode='live' requires configuration for the initialized DAP session.");
          const run = await runToStop(session, {
            request,
            configuration,
            ...(breakpoints ? { breakpoints: breakpoints as SourceBreakpointGroup[] } : {}),
            timeoutMs,
            snapshot: {
              ...snapshotOptions,
              includeDisassembly: true,
              includeModules: true,
              includeExceptionInfo: true,
            },
          });
          const diagnosis = run.snapshot
            ? await diagnoseSnapshot(session, run.snapshot, snapshotOptions, analysisOptions)
            : undefined;
          const terminal = run.snapshot
            ? undefined
            : terminalForVerification(run.outcome as { event: 'exited' | 'terminated'; body?: unknown });
          return {
            mode,
            run,
            diagnosis: diagnosis
              ?? terminalOutcomeDiagnosis(run.outcome as { event: 'exited' | 'terminated'; body?: unknown }),
            workflow: workflowMetadata(stage, baseline, diagnosis, terminal, agentState, maxIterations),
            status: session.snapshot(),
          };
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
