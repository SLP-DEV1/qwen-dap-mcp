import type { McpServer } from '@modelcontextprotocol/server';
import type { DebugProtocol } from '@vscode/debugprotocol';
import * as z from 'zod/v4';

import {
  buildCodeLldbAttachConfiguration,
  buildCodeLldbLaunchConfiguration,
  discoverCodeLldb,
} from '../adapters/codelldb.js';
import {
  buildGdbDapLaunchConfiguration,
  buildGdbDapPidAttachConfiguration,
  discoverGdbDap,
} from '../adapters/gdb-dap.js';
import {
  buildLldbDapAttachConfiguration,
  buildLldbDapLaunchConfiguration,
  discoverLldbDap,
} from '../adapters/lldb-dap.js';
import { DapError } from '../dap/errors.js';
import { GuardedDapSession } from '../dap/guarded-session.js';
import type { SessionSnapshot } from '../dap/session.js';
import {
  analyzeHang,
  type HangFrameVariables,
  type HangThreadEvidence,
} from '../diagnostics/hang-analysis.js';
import {
  assessProjectFrames,
  type IntelligentDiagnosisOptions,
} from '../diagnostics/intelligent-diagnosis.js';
import { logger } from '../logger.js';
import { debugThisHangOutputSchema, structuredResult } from './agent-output.js';
import { LOCAL_TARGET_EXECUTION_ANNOTATIONS } from './tool-annotations.js';

const jsonRecord = z.record(z.string(), z.unknown()).describe('Adapter-specific launch or attach configuration used only for mode=live.');
const analysisSchema = z.object({
  projectRoots: z.array(z.string().min(1)).max(20).optional().describe('Optional local source roots used to recognize project-controlled frames across all captured threads.'),
  projectModules: z.array(z.string().min(1)).max(50).optional().describe('Optional executable/library names treated as project-controlled modules during all-thread triage.'),
}).describe('Project-code hints used when ranking runnable versus blocked threads.');

export type HangCaptureOptions = {
  maxThreads?: number;
  stackLevels?: number;
  maxVariablesPerFrame?: number;
  framesWithVariables?: number;
};

type ObservationOutcome =
  | { kind: 'timeout' }
  | { kind: 'event'; event: DebugProtocol.Event };

type ExecutionState = 'stopped' | 'running' | 'exited' | 'terminated' | 'unknown';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorResult(error: unknown) {
  return { content: [{ type: 'text' as const, text: errorMessage(error) }], isError: true };
}

function recentExecutionState(snapshot: SessionSnapshot & { postmortem?: boolean }): ExecutionState {
  for (const record of [...snapshot.recentEvents].reverse()) {
    const event = (record as { event?: unknown }).event;
    if (event === 'stopped') return 'stopped';
    if (event === 'continued') return 'running';
    if (event === 'exited') return 'exited';
    if (event === 'terminated') return 'terminated';
  }
  return 'unknown';
}

function createObservationWait(session: GuardedDapSession, observeMs: number) {
  let active = true;
  let timer!: NodeJS.Timeout;
  let handler!: (event: DebugProtocol.Event) => void;
  let onAdapterExit!: (detail: unknown) => void;
  let onAdapterError!: (error: unknown) => void;
  let resolvePromise!: (outcome: ObservationOutcome) => void;

  const cleanup = () => {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    session.connection.off('event', handler);
    session.connection.off('adapterExit', onAdapterExit);
    session.connection.off('adapterError', onAdapterError);
  };

  const promise = new Promise<ObservationOutcome>((resolve, reject) => {
    resolvePromise = resolve;
    handler = (event: DebugProtocol.Event) => {
      if (!['stopped', 'exited', 'terminated'].includes(event.event)) return;
      cleanup();
      resolve({ kind: 'event', event });
    };
    onAdapterExit = (detail: unknown) => {
      cleanup();
      reject(new DapError(`DAP adapter exited while observing the suspected hang: ${JSON.stringify(detail ?? {})}`));
    };
    onAdapterError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new DapError('DAP adapter failed while observing the suspected hang.'));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve({ kind: 'timeout' });
    }, observeMs);
    session.connection.on('event', handler);
    session.connection.on('adapterExit', onAdapterExit);
    session.connection.on('adapterError', onAdapterError);
  });

  return {
    promise,
    cancel: () => {
      if (!active) return;
      cleanup();
      resolvePromise({ kind: 'timeout' });
    },
  };
}

async function pauseForHangCapture(session: GuardedDapSession, pauseTimeoutMs: number) {
  if (session.isPostmortem()) {
    return {
      requested: false,
      allThreadsStopped: true,
      pauseErrors: [] as string[],
      reason: 'postmortem sessions are already frozen',
    };
  }

  const before = session.snapshot();
  const state = recentExecutionState(before);
  if (state === 'exited' || state === 'terminated') {
    throw new DapError(`Cannot capture hang evidence because the debuggee has already ${state}.`);
  }
  if (state === 'stopped') {
    return {
      requested: false,
      allThreadsStopped: true,
      pauseErrors: [] as string[],
      reason: 'the most recent execution event is already stopped',
    };
  }

  const threads = await session.threads();
  const anchor = threads[0];
  if (!anchor) throw new DapError('The debugger returned no threads to pause for hang capture.');

  const firstPause = await session.pause(anchor.id, true, pauseTimeoutMs) as {
    stopped?: DebugProtocol.StoppedEvent['body'];
  };
  const allThreadsStopped = firstPause.stopped?.allThreadsStopped === true;
  const pauseErrors: string[] = [];

  if (!allThreadsStopped) {
    for (const thread of threads.slice(1)) {
      try {
        await session.pause(thread.id, false, pauseTimeoutMs);
      } catch (error) {
        pauseErrors.push(`thread ${thread.id}: ${errorMessage(error)}`);
      }
    }
  }

  return {
    requested: true,
    anchorThreadId: anchor.id,
    allThreadsStopped,
    pauseErrors,
    reason: allThreadsStopped
      ? 'the anchor pause reported allThreadsStopped=true'
      : 'the adapter did not report allThreadsStopped=true; remaining threads received best-effort pause requests',
  };
}

function dedupeVariables(variables: DebugProtocol.Variable[]): DebugProtocol.Variable[] {
  const seen = new Set<string>();
  const output: DebugProtocol.Variable[] = [];
  for (const variable of variables) {
    const key = `${variable.name}\u0000${variable.value}\u0000${variable.type ?? ''}\u0000${variable.memoryReference ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(variable);
  }
  return output;
}

async function collectFrameVariables(
  session: GuardedDapSession,
  frame: DebugProtocol.StackFrame,
  frameIndex: number,
  maxVariablesPerFrame: number,
): Promise<HangFrameVariables> {
  const collectionErrors: string[] = [];
  let scopes: DebugProtocol.Scope[] = [];
  try {
    scopes = await session.scopes(frame.id);
  } catch (error) {
    collectionErrors.push(`scopes: ${errorMessage(error)}`);
  }

  const variables: DebugProtocol.Variable[] = [];
  for (const scope of scopes.filter((item) => /locals?|arguments?|parameters?/i.test(item.name)).slice(0, 3)) {
    if (scope.variablesReference <= 0) continue;
    try {
      variables.push(...await session.variables(scope.variablesReference, 0, maxVariablesPerFrame));
    } catch (error) {
      collectionErrors.push(`${scope.name}: ${errorMessage(error)}`);
    }
  }

  return {
    frameIndex,
    frame,
    variables: dedupeVariables(variables).slice(0, maxVariablesPerFrame * 3),
    ...(collectionErrors.length === 0 ? {} : { collectionErrors }),
  };
}

export async function captureAllThreadHangEvidence(
  session: GuardedDapSession,
  captureOptions: HangCaptureOptions = {},
  analysisOptions: IntelligentDiagnosisOptions = {},
): Promise<HangThreadEvidence[]> {
  const maxThreads = captureOptions.maxThreads ?? 32;
  const stackLevels = captureOptions.stackLevels ?? 24;
  const maxVariablesPerFrame = captureOptions.maxVariablesPerFrame ?? 50;
  const framesWithVariables = captureOptions.framesWithVariables ?? 2;
  const threads = (await session.threads()).slice(0, maxThreads);
  const output: HangThreadEvidence[] = [];

  for (const thread of threads) {
    const collectionErrors: string[] = [];
    let stack: DebugProtocol.StackFrame[] = [];
    try {
      stack = await session.stackTrace(thread.id, 0, stackLevels);
    } catch (error) {
      collectionErrors.push(`stackTrace: ${errorMessage(error)}`);
    }

    const assessments = assessProjectFrames(stack, analysisOptions);
    const projectIndex = assessments.find((item) => item.projectControlled)?.index;
    const frameIndexes = [0, ...(projectIndex === undefined || projectIndex === 0 ? [] : [projectIndex])]
      .filter((value, index, values) => values.indexOf(value) === index)
      .slice(0, framesWithVariables);

    const variableFrames: HangFrameVariables[] = [];
    for (const frameIndex of frameIndexes) {
      const frame = stack[frameIndex];
      if (!frame) continue;
      try {
        variableFrames.push(await collectFrameVariables(session, frame, frameIndex, maxVariablesPerFrame));
      } catch (error) {
        collectionErrors.push(`frame ${frameIndex} variables: ${errorMessage(error)}`);
      }
    }

    output.push({
      thread,
      stack,
      variableFrames,
      ...(collectionErrors.length === 0 ? {} : { collectionErrors }),
    });
  }

  return output;
}

async function captureAndAnalyze(
  session: GuardedDapSession,
  captureOptions: HangCaptureOptions,
  analysisOptions: IntelligentDiagnosisOptions,
) {
  const evidence = await captureAllThreadHangEvidence(session, captureOptions, analysisOptions);
  return {
    evidence,
    diagnosis: analyzeHang(evidence, analysisOptions),
  };
}

async function resetOwnedSessionAfterFailure(session: GuardedDapSession, error: unknown): Promise<never> {
  try {
    await session.reset();
  } catch (cleanupError) {
    logger.warn('Failed to reset owned debugger session after hang workflow failure', {
      cleanupError: cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
    });
  }
  throw error;
}

async function observeLaunchedOrAttachedTarget(
  session: GuardedDapSession,
  request: 'launch' | 'attach',
  configuration: Record<string, unknown>,
  observeMs: number,
  pauseTimeoutMs: number,
  captureOptions: HangCaptureOptions,
  analysisOptions: IntelligentDiagnosisOptions,
) {
  const observation = createObservationWait(session, observeMs);
  void observation.promise.catch(() => undefined);

  let requestResult: unknown;
  try {
    requestResult = request === 'attach'
      ? await session.attach(configuration)
      : await session.launch(configuration);
  } catch (error) {
    observation.cancel();
    await observation.promise.catch(() => undefined);
    throw error;
  }

  const outcome = await observation.promise;
  if (outcome.kind === 'event' && ['exited', 'terminated'].includes(outcome.event.event)) {
    return {
      requestResult,
      observation: {
        observeMs,
        suspectedHang: false,
        trigger: outcome.event.event,
        event: outcome.event.body ?? {},
      },
      status: session.snapshot(),
    };
  }

  if (outcome.kind === 'event' && outcome.event.event === 'stopped') {
    const captured = await captureAndAnalyze(session, captureOptions, analysisOptions);
    return {
      requestResult,
      observation: {
        observeMs,
        suspectedHang: false,
        trigger: 'debugger-stop-before-timeout',
        event: outcome.event.body ?? {},
        note: 'The debugger stopped before the observation window expired, so this capture is useful for thread triage but does not by itself establish a hang.',
      },
      ...captured,
      status: session.snapshot(),
    };
  }

  const pause = await pauseForHangCapture(session, pauseTimeoutMs);
  const captured = await captureAndAnalyze(session, captureOptions, analysisOptions);
  return {
    requestResult,
    observation: {
      observeMs,
      suspectedHang: true,
      trigger: 'observation-timeout',
      pause,
      note: 'No stopped/exited/terminated event was observed during the bounded window. The target was then paused for all-thread triage; lack of an event is not independent proof that forward progress was impossible.',
    },
    ...captured,
    status: session.snapshot(),
  };
}

export function registerHangDiagnosticTool(server: McpServer, session: GuardedDapSession): void {
  server.registerTool(
    'debug_this_hang',
    {
      title: 'Debug This Hang',
      description:
        'High-level native hang workflow for all-thread triage. Use it when a live process appears stuck, deadlocked, waiting forever, or spinning and you need bounded stacks from every thread, wait-state/deadlock heuristics, and cross-thread Pointer-Provenance v2. In current mode it inspects an existing configured session and pauses a running live target when necessary; codelldb, lldb-dap, gdb, and live modes can launch or attach to an authorized local target, observe it for a bounded interval, then pause it for evidence. Do not use executable/attach modes when target execution or debugger control is not authorized, and do not treat a deadlock-candidate as a proven lock cycle because generic DAP does not expose portable lock ownership.',
      annotations: LOCAL_TARGET_EXECUTION_ANNOTATIONS,
      outputSchema: debugThisHangOutputSchema,
      inputSchema: z.object({
        mode: z.enum(['current', 'live', 'codelldb', 'lldb-dap', 'gdb']).default('current').describe('current triages the configured session; live uses an already initialized generic DAP adapter; codelldb/lldb-dap/gdb discover and start that adapter before launch/attach.'),
        request: z.enum(['launch', 'attach']).default('launch').describe('For live or adapter-owned modes, launch starts a program and attach connects to an existing authorized process.'),
        configuration: jsonRecord.optional().describe('Required only for mode=live: adapter-specific DAP launch/attach configuration.'),
        program: z.string().min(1).optional().describe('Required for codelldb/lldb-dap/gdb launch; optional executable image hint for adapter-specific attach.'),
        pid: z.number().int().positive().optional().describe('Required for codelldb/lldb-dap/gdb attach modes; ignored for launch and generic live configuration.'),
        args: z.array(z.string()).optional().describe('Command-line arguments for codelldb/lldb-dap/gdb launch modes.'),
        cwd: z.string().optional().describe('Working directory for adapter-owned launches and a project-root hint for hang triage.'),
        env: z.record(z.string(), z.string()).optional().describe('Environment variables supplied to adapter-owned launched programs.'),
        adapterPath: z.string().min(1).optional().describe('Optional explicit CodeLLDB, lldb-dap, or GDB executable path; omit to use adapter discovery.'),
        requestTimeoutMs: z.number().int().min(1000).max(120000).default(30000).describe('Per-request timeout for starting and configuring an adapter-owned DAP session.'),
        observeMs: z.number().int().min(250).max(120000).default(5000).describe('Bounded interval after launch/attach during which a normal stop or process exit prevents automatic hang-timeout classification.'),
        pauseTimeoutMs: z.number().int().min(1000).max(60000).default(10000).describe('Maximum time to wait for the anchor thread pause used to freeze a suspected live hang.'),
        maxThreads: z.number().int().positive().max(128).default(32).describe('Maximum threads to collect for bounded all-thread triage.'),
        stackLevels: z.number().int().positive().max(100).default(24).describe('Maximum stack frames collected per thread.'),
        maxVariablesPerFrame: z.number().int().positive().max(200).default(50).describe('Maximum local/argument variables collected per selected frame scope for Pointer-Provenance v2.'),
        framesWithVariables: z.number().int().positive().max(4).default(2).describe('Maximum frames per thread whose locals/arguments are collected, prioritizing the top frame and first project-controlled frame.'),
        analysis: analysisSchema.optional().describe('Optional project roots/modules used to recognize project-controlled frames across all threads.'),
      }),
    },
    async ({
      mode,
      request,
      configuration,
      program,
      pid,
      args,
      cwd,
      env,
      adapterPath,
      requestTimeoutMs,
      observeMs,
      pauseTimeoutMs,
      maxThreads,
      stackLevels,
      maxVariablesPerFrame,
      framesWithVariables,
      analysis,
    }) => {
      try {
        return structuredResult(await session.runExclusiveLifecycle('debug this hang', async () => {
          const analysisOptions: IntelligentDiagnosisOptions = {
            ...(analysis as IntelligentDiagnosisOptions | undefined),
            ...(program ? { program } : {}),
            ...(cwd ? { cwd } : {}),
          };
          const captureOptions: HangCaptureOptions = {
            maxThreads,
            stackLevels,
            maxVariablesPerFrame,
            framesWithVariables,
          };

          if (mode === 'current') {
            const before = session.snapshot();
            const pause = await pauseForHangCapture(session, pauseTimeoutMs);
            const captured = await captureAndAnalyze(session, captureOptions, analysisOptions);
            return {
              mode,
              observation: {
                suspectedHang: true,
                trigger: session.isPostmortem() ? 'postmortem-current' : 'current-session-capture',
                priorExecutionState: recentExecutionState(before),
                pause,
                note: session.isPostmortem()
                  ? 'A frozen dump/core can show a state consistent with a hang but cannot prove that the original process lacked forward progress.'
                  : 'current mode treats the caller-provided session as the suspected hang and pauses it only when it was not already stopped.',
              },
              ...captured,
              status: session.snapshot(),
            };
          }

          if (mode === 'live') {
            if (!configuration) throw new DapError("debug_this_hang mode='live' requires configuration.");
            return {
              mode,
              ...(await observeLaunchedOrAttachedTarget(
                session,
                request,
                configuration,
                observeMs,
                pauseTimeoutMs,
                captureOptions,
                analysisOptions,
              )),
            };
          }

          let adapterStarted = false;
          try {
            if (mode === 'gdb') {
              const adapter = discoverGdbDap({ ...(adapterPath ? { explicitPath: adapterPath } : {}) });
              const requestConfiguration = request === 'attach'
                ? buildGdbDapPidAttachConfiguration({
                    pid: pid ?? 0,
                    ...(program ? { program } : {}),
                  })
                : buildGdbDapLaunchConfiguration({
                    program: program ?? '',
                    ...(args ? { args } : {}),
                    ...(cwd ? { cwd } : {}),
                    ...(env ? { env } : {}),
                    stopOnEntry: false,
                  });
              const capabilities = await session.start({
                command: adapter.command,
                args: adapter.args,
                adapterId: 'gdb',
                ...(cwd ? { cwd } : {}),
                requestTimeoutMs,
              });
              adapterStarted = true;
              return {
                mode,
                adapter,
                capabilities,
                ...(await observeLaunchedOrAttachedTarget(
                  session,
                  request,
                  requestConfiguration,
                  observeMs,
                  pauseTimeoutMs,
                  captureOptions,
                  analysisOptions,
                )),
              };
            }

            if (mode === 'lldb-dap') {
              const adapter = discoverLldbDap({ ...(adapterPath ? { explicitPath: adapterPath } : {}) });
              const requestConfiguration = request === 'attach'
                ? buildLldbDapAttachConfiguration({
                    pid: pid ?? 0,
                    ...(program ? { program } : {}),
                    stopOnEntry: false,
                  })
                : buildLldbDapLaunchConfiguration({
                    program: program ?? '',
                    ...(args ? { args } : {}),
                    ...(cwd ? { cwd } : {}),
                    ...(env ? { env } : {}),
                    stopOnEntry: false,
                  });
              const capabilities = await session.start({
                command: adapter.command,
                adapterId: 'lldb-dap',
                ...(cwd ? { cwd } : {}),
                requestTimeoutMs,
              });
              adapterStarted = true;
              return {
                mode,
                adapter,
                capabilities,
                ...(await observeLaunchedOrAttachedTarget(
                  session,
                  request,
                  requestConfiguration,
                  observeMs,
                  pauseTimeoutMs,
                  captureOptions,
                  analysisOptions,
                )),
              };
            }

            const adapter = discoverCodeLldb({ ...(adapterPath ? { explicitPath: adapterPath } : {}) });
            const requestConfiguration = request === 'attach'
              ? buildCodeLldbAttachConfiguration({
                  pid: pid ?? 0,
                  ...(program ? { program } : {}),
                  stopOnEntry: false,
                })
              : buildCodeLldbLaunchConfiguration({
                  program: program ?? '',
                  ...(args ? { args } : {}),
                  ...(cwd ? { cwd } : {}),
                  ...(env ? { env } : {}),
                  stopOnEntry: false,
                });
            const capabilities = await session.start({
              command: adapter.command,
              adapterId: 'lldb',
              ...(cwd ? { cwd } : {}),
              requestTimeoutMs,
            });
            adapterStarted = true;
            return {
              mode,
              adapter,
              capabilities,
              ...(await observeLaunchedOrAttachedTarget(
                session,
                request,
                requestConfiguration,
                observeMs,
                pauseTimeoutMs,
                captureOptions,
                analysisOptions,
              )),
            };
          } catch (error) {
            if (adapterStarted) return await resetOwnedSessionAfterFailure(session, error);
            throw error;
          }
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
