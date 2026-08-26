import type { McpServer } from '@modelcontextprotocol/server';
import type { DebugProtocol } from '@vscode/debugprotocol';
import * as z from 'zod/v4';

import { buildCodeLldbLaunchConfiguration, discoverCodeLldb } from '../adapters/codelldb.js';
import { analyzeRuntimeSnapshot, correlateSourceDisassembly } from '../diagnostics/analyze-snapshot.js';
import {
  advanceAutonomousCycle,
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
import { openDump, type OpenDumpOptions } from './register-dump-tools.js';
import { runToStop } from './run-to-stop.js';

const jsonRecord = z.record(z.string(), z.unknown());
const breakpointGroupSchema = z.object({
  source: z.string().min(1).describe('Absolute or adapter-resolvable source file path'),
  lines: z.array(z.number().int().positive()).min(1),
});
const snapshotSchema = z.object({
  threadId: z.number().int().positive().optional(),
  stackLevels: z.number().int().positive().max(100).default(20),
  maxVariablesPerScope: z.number().int().positive().max(500).default(100),
  includeDisassembly: z.boolean().default(true),
  disassembleBefore: z.number().int().nonnegative().max(100).default(8),
  disassembleAfter: z.number().int().nonnegative().max(100).default(12),
  includeModules: z.boolean().default(true),
  moduleCount: z.number().int().positive().max(500).default(100),
  includeExceptionInfo: z.boolean().default(true),
});
const analysisSchema = z.object({
  projectRoots: z.array(z.string().min(1)).max(20).optional(),
  projectModules: z.array(z.string().min(1)).max(50).optional(),
  callerDepth: z.number().int().nonnegative().max(5).default(2),
});
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
  stage: z.enum(['diagnose', 'verify', 'autonomous']).default('diagnose'),
  baseline: verificationBaselineSchema.optional(),
  agentState: autonomousAgentStateSchema.optional(),
  maxIterations: z.number().int().positive().max(10).default(3),
});

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
  const scopes = await session.scopes(frame.id);
  const maxVariables = options.maxVariablesPerScope ?? 100;
  const localScopes = scopes.filter((scope) => /locals?|arguments?|parameters?/i.test(scope.name));
  const registerScope = scopes.find((scope) => /register/i.test(scope.name));

  const locals: DebugProtocol.Variable[] = [];
  for (const scope of localScopes.slice(0, 3)) {
    if (scope.variablesReference <= 0) continue;
    locals.push(...await session.variables(scope.variablesReference, 0, maxVariables));
  }

  const registers = registerScope && registerScope.variablesReference > 0
    ? await session.variables(registerScope.variablesReference, 0, maxVariables)
    : [];

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
    } catch {
      // Some adapters advertise disassembly but cannot resolve a particular frame/IP.
      // The intelligent diagnosis remains useful from stack/variables alone.
    }
  }

  return {
    index,
    frame,
    locals: dedupeVariables(locals).slice(0, maxVariables),
    registers: dedupeVariables(registers).slice(0, maxVariables),
    ...(disassembly === undefined ? {} : { disassembly }),
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
  const callerDepth = analysisOptions.callerDepth ?? 2;
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

export function registerAgentDiagnosticTools(server: McpServer, session: GuardedDapSession): void {
  server.registerTool(
    'debug_diagnose_stop',
    {
      title: 'Diagnose Current Debug Stop',
      description:
        'Capture the current stopped state and produce an agent-friendly diagnosis with crash classification, automatic project-frame selection, operand/register/variable bindings, call-chain provenance, ranked hypotheses, and a fix/rebuild/reproduce/verify plan.',
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
        'Select the first likely project-controlled frame, correlate its instruction pointer with nearby disassembly, and bind instruction operands back to registers and pointer-like locals when possible.',
      inputSchema: z.object({
        threadId: z.number().int().positive().optional(),
        stackLevels: z.number().int().positive().max(100).default(12),
        disassembleBefore: z.number().int().nonnegative().max(100).default(8),
        disassembleAfter: z.number().int().nonnegative().max(100).default(12),
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

        return result({
          frameSelection: selection,
          faultCorrelation: correlateSourceDisassembly(snapshot),
          projectFrame: selectedFrame,
          operandAnalysis: analyzeInstructionOperands(evidence),
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
        'High-level debugging-agent workflow. Diagnose the current stop, run an initialized DAP session, auto-start CodeLLDB for a local native program, or open a crash dump. workflow.stage="autonomous" adds a bounded serialized agent loop with crash fingerprints, iteration history, next-action decisions, changed-failure re-baselining, and deterministic fixed/blocked/budget-exhausted stop conditions.',
      inputSchema: z.object({
        mode: z.enum(['current', 'live', 'codelldb', 'dump']).default('current'),

        // Generic initialized-session live mode.
        request: z.enum(['launch', 'attach']).default('launch'),
        configuration: jsonRecord.optional(),
        breakpoints: z.array(breakpointGroupSchema).optional(),
        timeoutMs: z.number().int().min(1000).max(120000).default(30000),

        // CodeLLDB one-call launch mode and dump mode.
        program: z.string().min(1).optional(),
        args: z.array(z.string()).optional(),
        cwd: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
        stopOnEntry: z.boolean().default(false),
        adapterPath: z.string().min(1).optional(),
        requestTimeoutMs: z.number().int().min(1000).max(120000).default(30000),

        // Dump mode.
        dumpPath: z.string().min(1).optional(),
        sourceMap: z.record(z.string(), z.string()).optional(),

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

          if (mode === 'codelldb') {
            if (!program) throw new DapError("debug_this_crash mode='codelldb' requires program.");
            const adapter = discoverCodeLldb({
              ...(adapterPath ? { explicitPath: adapterPath } : {}),
            });
            const capabilities = await session.start({
              command: adapter.command,
              adapterId: 'lldb',
              ...(cwd ? { cwd } : {}),
              requestTimeoutMs,
            });
            const launchConfiguration = buildCodeLldbLaunchConfiguration({
              program,
              ...(args ? { args } : {}),
              ...(cwd ? { cwd } : {}),
              ...(env ? { env } : {}),
              stopOnEntry,
            });
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
