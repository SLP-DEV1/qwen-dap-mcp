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

const jsonRecord = z.record(z.string(), z.unknown())
  .describe('Adapter-specific launch or attach configuration used only for mode=live.');
const analysisSchema = z.object({
  projectRoots: z.array(z.string().min(1)).max(20).optional()
    .describe('Optional local source roots used to recognize project-controlled frames across all captured threads.'),
  projectModules: z.array(z.string().min(1)).max(50).optional()
    .describe('Optional executable/library names treated as project-controlled modules during all-thread triage.'),
}).describe('Project-code hints used when ranking runnable versus blocked threads.');

export type HangCaptureOptions = {
  maxThreads?: number;
  stackLevels?: number;
  maxVariablesPerFrame?: number;
  framesWithVariables?: number;
  captureTimeoutMs?: number;
};

type ObservationOutcome =
  | { kind: 'timeout' }
  | { kind: 'event'; event: DebugProtocol.Event };

type ExecutionState = 'stopped' | 'running' | 'exited' | 'terminated' | 'unknown';
type GuardedSnapshot = SessionSnapshot & { postmortem?: boolean };

const CAPTURE_DEADLINE_PREFIX = 'Hang evidence capture deadline exceeded';
const PAUSE_DEADLINE_PREFIX = 'Hang pause budget exceeded';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorResult(error: unknown) {
  return { content: [{ type: 'text' as const, text: errorMessage(error) }], isError: true };
}

function deadlineError(prefix: string, operation: string): DapError {
  return new DapError(`${prefix} before ${operation}.`);
}

function captureDeadlineError(operation: string): DapError {
  return deadlineError(CAPTURE_DEADLINE_PREFIX, operation);
}

function pauseDeadlineError(operation: string): DapError {
  return deadlineError(PAUSE_DEADLINE_PREFIX, operation);
}

function isCaptureDeadlineError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(CAPTURE_DEADLINE_PREFIX);
}

function isPauseDeadlineError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(PAUSE_DEADLINE_PREFIX);
}

async function withDeadline<T>(
  deadline: number,
  operation: string,
  makeError: (operation: string) => DapError,
  action: () => Promise<T>,
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw makeError(operation);

  let timer: NodeJS.Timeout | undefined;
  const request = action();
  void request.catch(() => undefined);
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(makeError(operation)), remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withCaptureDeadline<T>(
  deadline: number,
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  return withDeadline(deadline, operation, captureDeadlineError, action);
}

async function withPauseDeadline<T>(
  deadline: number,
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  return withDeadline(deadline, operation, pauseDeadlineError, action);
}

function recentExecutionState(snapshot: GuardedSnapshot): ExecutionState {
  for (const record of [...snapshot.recentEvents].reverse()) {
    const event = (record as { event?: unknown }).event;
    if (event === 'stopped') return 'stopped';
    if (event === 'continued') return 'running';
    if (event === 'exited') return 'exited';
    if (event === 'terminated') return 'terminated';
  }
  return 'unknown';
}

function latestStoppedBody(snapshot: GuardedSnapshot): DebugProtocol.StoppedEvent['body'] | undefined {
  for (const record of [...snapshot.recentEvents].reverse()) {
    const candidate = record as { event?: unknown; body?: unknown };
    if (candidate.event === 'stopped') {
      return candidate.body as DebugProtocol.StoppedEvent['body'] | undefined;
    }
    if (candidate.event === 'continued' || candidate.event === 'exited' || candidate.event === 'terminated') {
      return undefined;
    }
  }
  return undefined;
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

async function pauseThreadsBestEffort(
  session: GuardedDapSession,
  threads: DebugProtocol.Thread[],
  excludedThreadId: number | undefined,
  pauseTimeoutMs: number,
  deadline: number,
) {
  const pauseErrors: string[] = [];
  let allThreadsStopped = false;
  let budgetExpired = false;
  const requestedThreadIds: number[] = [];

  for (const thread of threads) {
    if (thread.id === excludedThreadId) continue;
    if (Date.now() >= deadline) {
      budgetExpired = true;
      pauseErrors.push(`${PAUSE_DEADLINE_PREFIX} before thread ${thread.id}.`);
      break;
    }
    try {
      requestedThreadIds.push(thread.id);
      const remainingMs = Math.max(1, deadline - Date.now());
      const perThreadTimeout = Math.max(1, Math.min(pauseTimeoutMs, remainingMs));
      const paused = await withPauseDeadline(
        deadline,
        `pause for thread ${thread.id}`,
        () => session.pause(thread.id, true, perThreadTimeout),
      ) as {
        stopped?: DebugProtocol.StoppedEvent['body'];
      };
      if (paused.stopped?.allThreadsStopped === true) {
        allThreadsStopped = true;
        break;
      }
    } catch (error) {
      pauseErrors.push(`thread ${thread.id}: ${errorMessage(error)}`);
      if (isPauseDeadlineError(error)) {
        budgetExpired = true;
        break;
      }
    }
  }

  return { allThreadsStopped, pauseErrors, requestedThreadIds, budgetExpired };
}

async function pauseForHangCapture(
  session: GuardedDapSession,
  pauseTimeoutMs: number,
  pauseBudgetMs = 30_000,
) {
  if (session.isPostmortem()) {
    return {
      requested: false,
      allThreadsStopped: true,
      pauseErrors: [] as string[],
      requestedThreadIds: [] as number[],
      pauseBudgetMs,
      pauseBudgetExpired: false,
      reason: 'postmortem sessions are already frozen',
    };
  }

  const deadline = Date.now() + pauseBudgetMs;
  const before = session.snapshot();
  const state = recentExecutionState(before);
  if (state === 'exited' || state === 'terminated') {
    throw new DapError(`Cannot capture hang evidence because the debuggee has already ${state}.`);
  }

  const threads = await withPauseDeadline(
    deadline,
    'thread enumeration before hang pause',
    () => session.threads(),
  );
  if (threads.length === 0) {
    throw new DapError('The debugger returned no threads to pause for hang capture.');
  }

  if (state === 'stopped') {
    const stopped = latestStoppedBody(before);
    if (stopped?.allThreadsStopped === true) {
      return {
        requested: false,
        allThreadsStopped: true,
        pauseErrors: [] as string[],
        requestedThreadIds: [] as number[],
        pauseBudgetMs,
        pauseBudgetExpired: false,
        reason: 'the latest stopped event explicitly reports allThreadsStopped=true',
      };
    }

    const remaining = await pauseThreadsBestEffort(
      session,
      threads,
      stopped?.threadId,
      pauseTimeoutMs,
      deadline,
    );
    return {
      requested: remaining.requestedThreadIds.length > 0,
      allThreadsStopped: remaining.allThreadsStopped,
      pauseErrors: remaining.pauseErrors,
      requestedThreadIds: remaining.requestedThreadIds,
      pauseBudgetMs,
      pauseBudgetExpired: remaining.budgetExpired,
      ...(stopped?.threadId === undefined ? {} : { alreadyStoppedThreadId: stopped.threadId }),
      reason: remaining.allThreadsStopped
        ? 'an additional pause reported allThreadsStopped=true'
        : remaining.budgetExpired
          ? 'the aggregate hang pause budget expired before the adapter confirmed every thread stopped; evidence collection continues conservatively'
          : 'the session was stopped but not globally stopped; remaining threads received bounded best-effort pause requests',
    };
  }

  const anchor = threads[0];
  if (!anchor) throw new DapError('The debugger returned no anchor thread to pause.');
  let firstPause: { stopped?: DebugProtocol.StoppedEvent['body'] } | undefined;
  const firstPauseErrors: string[] = [];
  try {
    const remainingMs = Math.max(1, deadline - Date.now());
    const perThreadTimeout = Math.max(1, Math.min(pauseTimeoutMs, remainingMs));
    firstPause = await withPauseDeadline(
      deadline,
      `anchor pause for thread ${anchor.id}`,
      () => session.pause(anchor.id, true, perThreadTimeout),
    ) as { stopped?: DebugProtocol.StoppedEvent['body'] };
  } catch (error) {
    firstPauseErrors.push(`thread ${anchor.id}: ${errorMessage(error)}`);
    if (isPauseDeadlineError(error) || Date.now() >= deadline) {
      return {
        requested: true,
        anchorThreadId: anchor.id,
        allThreadsStopped: false,
        pauseErrors: firstPauseErrors,
        requestedThreadIds: [anchor.id],
        pauseBudgetMs,
        pauseBudgetExpired: true,
        reason: 'the aggregate hang pause budget expired during the anchor pause; evidence collection continues conservatively',
      };
    }
  }

  if (firstPause?.stopped?.allThreadsStopped === true) {
    return {
      requested: true,
      anchorThreadId: anchor.id,
      allThreadsStopped: true,
      pauseErrors: firstPauseErrors,
      requestedThreadIds: [anchor.id],
      pauseBudgetMs,
      pauseBudgetExpired: false,
      reason: 'the anchor pause reported allThreadsStopped=true',
    };
  }

  const remaining = await pauseThreadsBestEffort(
    session,
    threads,
    firstPause?.stopped?.threadId ?? anchor.id,
    pauseTimeoutMs,
    deadline,
  );
  return {
    requested: true,
    anchorThreadId: anchor.id,
    allThreadsStopped: remaining.allThreadsStopped,
    pauseErrors: [...firstPauseErrors, ...remaining.pauseErrors],
    requestedThreadIds: [anchor.id, ...remaining.requestedThreadIds],
    pauseBudgetMs,
    pauseBudgetExpired: remaining.budgetExpired,
    reason: remaining.allThreadsStopped
      ? 'a follow-up pause reported allThreadsStopped=true'
      : remaining.budgetExpired
        ? 'the aggregate hang pause budget expired before the adapter confirmed every thread stopped; evidence collection continues conservatively'
        : 'the adapter never confirmed allThreadsStopped=true; all other threads received bounded best-effort pause requests',
  };
}

function dedupeVariables(variables: DebugProtocol.Variable[]): DebugProtocol.Variable[] {
  const seen = new Set<string>();
  const output: DebugProtocol.Variable[] = [];
  for (const variable of variables) {
    const key = [
      variable.name,
      variable.value,
      variable.type ?? '',
      String(variable.variablesReference),
      variable.memoryReference ?? '',
      variable.evaluateName ?? '',
    ].join('\u0000');
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
  deadline: number,
): Promise<HangFrameVariables> {
  const collectionErrors: string[] = [];
  let scopes: DebugProtocol.Scope[] = [];
  try {
    scopes = await withCaptureDeadline(deadline, `scopes for frame ${frame.id}`, () => session.scopes(frame.id));
  } catch (error) {
    collectionErrors.push(`scopes: ${errorMessage(error)}`);
    if (isCaptureDeadlineError(error)) {
      return { frameIndex, frame, variables: [], collectionErrors };
    }
  }

  const variables: DebugProtocol.Variable[] = [];
  for (const scope of scopes
    .filter((item) => /locals?|arguments?|parameters?/i.test(item.name))
    .slice(0, 3)) {
    if (scope.variablesReference <= 0) continue;
    try {
      variables.push(...await withCaptureDeadline(
        deadline,
        `${scope.name} variables for frame ${frame.id}`,
        () => session.variables(scope.variablesReference, 0, maxVariablesPerFrame),
      ));
    } catch (error) {
      collectionErrors.push(`${scope.name}: ${errorMessage(error)}`);
      if (isCaptureDeadlineError(error)) break;
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
  const captureTimeoutMs = captureOptions.captureTimeoutMs ?? 30_000;
  const deadline = Date.now() + captureTimeoutMs;
  const threads = (await withCaptureDeadline(
    deadline,
    'thread enumeration',
    () => session.threads(),
  )).slice(0, maxThreads);
  const output: HangThreadEvidence[] = [];
  let captureDeadlineExpired = false;

  for (const thread of threads) {
    if (captureDeadlineExpired || Date.now() >= deadline) {
      captureDeadlineExpired = true;
      output.push({
        thread,
        stack: [],
        variableFrames: [],
        collectionErrors: [`${CAPTURE_DEADLINE_PREFIX} before thread ${thread.id} collection.`],
      });
      continue;
    }

    const collectionErrors: string[] = [];
    let stack: DebugProtocol.StackFrame[] = [];
    try {
      stack = await withCaptureDeadline(
        deadline,
        `stackTrace for thread ${thread.id}`,
        () => session.stackTrace(thread.id, 0, stackLevels),
      );
    } catch (error) {
      collectionErrors.push(`stackTrace: ${errorMessage(error)}`);
      if (isCaptureDeadlineError(error)) captureDeadlineExpired = true;
    }

    const projectIndex = assessProjectFrames(stack, analysisOptions)
      .find((item) => item.projectControlled)?.index;
    const frameIndexes = [
      0,
      ...(projectIndex === undefined || projectIndex === 0 ? [] : [projectIndex]),
    ]
      .filter((value, index, values) => values.indexOf(value) === index)
      .slice(0, framesWithVariables);

    const variableFrames: HangFrameVariables[] = [];
    if (!captureDeadlineExpired && Date.now() < deadline) {
      for (const frameIndex of frameIndexes) {
        const frame = stack[frameIndex];
        if (!frame) continue;
        try {
          const frameVariables = await collectFrameVariables(
            session,
            frame,
            frameIndex,
            maxVariablesPerFrame,
            deadline,
          );
          variableFrames.push(frameVariables);
          if (frameVariables.collectionErrors?.some((message) => message.includes(CAPTURE_DEADLINE_PREFIX))) {
            captureDeadlineExpired = true;
          }
        } catch (error) {
          collectionErrors.push(`frame ${frameIndex} variables: ${errorMessage(error)}`);
          if (isCaptureDeadlineError(error)) captureDeadlineExpired = true;
        }
        if (captureDeadlineExpired || Date.now() >= deadline) {
          captureDeadlineExpired = true;
          break;
        }
      }
    } else if (stack.length > 0) {
      captureDeadlineExpired = true;
      collectionErrors.push(`${CAPTURE_DEADLINE_PREFIX} before variable collection for thread ${thread.id}.`);
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

async function resetOwnedSessionAfterFailure(
  session: GuardedDapSession,
  error: unknown,
): Promise<never> {
  try {
    await session.reset();
  } catch (cleanupError) {
    logger.warn('Failed to reset owned debugger session after hang workflow failure', {
      cleanupError: cleanupError instanceof Error
        ? cleanupError
        : new Error(String(cleanupError)),
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
  pauseBudgetMs: number,
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
    const pause = await pauseForHangCapture(session, pauseTimeoutMs, pauseBudgetMs);
    const captured = await captureAndAnalyze(session, captureOptions, analysisOptions);
    return {
      requestResult,
      observation: {
        observeMs,
        suspectedHang: false,
        trigger: 'debugger-stop-before-timeout',
        event: outcome.event.body ?? {},
        pause,
        note: 'The debugger stopped before the observation window expired, so this capture is useful for all-thread triage but does not by itself establish a hang.',
      },
      ...captured,
      status: session.snapshot(),
    };
  }

  const pause = await pauseForHangCapture(session, pauseTimeoutMs, pauseBudgetMs);
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

function validateOwnedRequest(
  mode: 'codelldb' | 'lldb-dap' | 'gdb',
  request: 'launch' | 'attach',
  program: string | undefined,
  pid: number | undefined,
): void {
  if (request === 'launch' && !program) {
    throw new DapError(`debug_this_hang mode='${mode}' request='launch' requires program.`);
  }
  if (request === 'attach' && pid === undefined) {
    throw new DapError(`debug_this_hang mode='${mode}' request='attach' requires pid.`);
  }
}

export function registerHangDiagnosticTool(
  server: McpServer,
  session: GuardedDapSession,
): void {
  server.registerTool(
    'debug_this_hang',
    {
      title: 'Debug This Hang',
      description:
        'High-level native hang workflow for all-thread triage. Use it when a live process appears stuck, deadlocked, waiting forever, or spinning and you need bounded stacks from every thread, wait-state/deadlock heuristics, and cross-thread Pointer-Provenance v2. In current mode it inspects an existing configured session and pauses a running live target when necessary; codelldb, lldb-dap, gdb, and live modes can launch or attach to an authorized local target, observe it for a bounded interval, then pause it for evidence. Do not use executable/attach modes when target execution or debugger control is not authorized, and do not treat a deadlock-candidate as a proven lock cycle because generic DAP does not expose portable lock ownership.',
      annotations: LOCAL_TARGET_EXECUTION_ANNOTATIONS,
      outputSchema: debugThisHangOutputSchema,
      inputSchema: z.object({
        mode: z.enum(['current', 'live', 'codelldb', 'lldb-dap', 'gdb']).default('current')
          .describe('current triages the configured session; live uses an already initialized generic DAP adapter; codelldb/lldb-dap/gdb discover and start that adapter before launch/attach.'),
        request: z.enum(['launch', 'attach']).default('launch')
          .describe('For live or adapter-owned modes, launch starts a program and attach connects to an existing authorized process.'),
        configuration: jsonRecord.optional()
          .describe('Required only for mode=live: adapter-specific DAP launch/attach configuration.'),
        program: z.string().min(1).optional()
          .describe('Required for codelldb/lldb-dap/gdb launch; optional executable image hint for adapter-specific attach.'),
        pid: z.number().int().positive().optional()
          .describe('Required for codelldb/lldb-dap/gdb attach modes; ignored for launch and generic live configuration.'),
        args: z.array(z.string()).optional()
          .describe('Command-line arguments for codelldb/lldb-dap/gdb launch modes.'),
        cwd: z.string().optional()
          .describe('Working directory for adapter-owned launches and a project-root hint for hang triage.'),
        env: z.record(z.string(), z.string()).optional()
          .describe('Environment variables supplied to adapter-owned launched programs.'),
        adapterPath: z.string().min(1).optional()
          .describe('Optional explicit CodeLLDB, lldb-dap, or GDB executable path; omit to use adapter discovery.'),
        requestTimeoutMs: z.number().int().min(1000).max(120000).default(30000)
          .describe('Per-request timeout for starting and configuring an adapter-owned DAP session.'),
        observeMs: z.number().int().min(250).max(120000).default(5000)
          .describe('Bounded interval after launch/attach during which a normal stop or process exit prevents automatic hang-timeout classification.'),
        pauseTimeoutMs: z.number().int().min(1000).max(60000).default(10000)
          .describe('Maximum time to wait for any single pause request used to freeze a suspected live hang.'),
        pauseBudgetMs: z.number().int().min(250).max(120000).default(30000)
          .describe('Aggregate wall-clock budget across thread enumeration and all pause requests. This prevents per-thread pause timeouts from multiplying across large thread sets.'),
        captureTimeoutMs: z.number().int().min(250).max(120000).default(30000)
          .describe('Global deadline for all-thread stack/scope/variable evidence collection after the pause phase. When it expires, remaining threads are retained as partial/unclassified evidence instead of extending the workflow per thread.'),
        maxThreads: z.number().int().positive().max(128).default(32)
          .describe('Maximum threads to collect for bounded all-thread triage.'),
        stackLevels: z.number().int().positive().max(100).default(24)
          .describe('Maximum stack frames collected per thread.'),
        maxVariablesPerFrame: z.number().int().positive().max(200).default(50)
          .describe('Maximum local/argument variables collected per selected frame scope for Pointer-Provenance v2.'),
        framesWithVariables: z.number().int().positive().max(4).default(2)
          .describe('Maximum frames per thread whose locals/arguments are collected, prioritizing the top frame and first project-controlled frame.'),
        analysis: analysisSchema.optional()
          .describe('Optional project roots/modules used to recognize project-controlled frames across all threads.'),
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
      pauseBudgetMs,
      captureTimeoutMs,
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
            captureTimeoutMs,
          };
          const effectivePauseBudgetMs = pauseBudgetMs ?? 30_000;

          if (mode === 'current') {
            const before = session.snapshot();
            const pause = await pauseForHangCapture(session, pauseTimeoutMs, effectivePauseBudgetMs);
            const captured = await captureAndAnalyze(session, captureOptions, analysisOptions);
            return {
              mode,
              observation: {
                suspectedHang: true,
                trigger: session.isPostmortem()
                  ? 'postmortem-current'
                  : 'current-session-capture',
                priorExecutionState: recentExecutionState(before),
                pause,
                note: session.isPostmortem()
                  ? 'A frozen dump/core can show a state consistent with a hang but cannot prove that the original process lacked forward progress.'
                  : 'current mode treats the caller-provided session as the suspected hang and obtains the strongest bounded all-thread stop the adapter can confirm.',
              },
              ...captured,
              status: session.snapshot(),
            };
          }

          if (mode === 'live') {
            if (!configuration) {
              throw new DapError("debug_this_hang mode='live' requires configuration.");
            }
            return {
              mode,
              ...(await observeLaunchedOrAttachedTarget(
                session,
                request,
                configuration,
                observeMs,
                pauseTimeoutMs,
                effectivePauseBudgetMs,
                captureOptions,
                analysisOptions,
              )),
            };
          }

          validateOwnedRequest(mode, request, program, pid);
          let adapterStarted = false;
          try {
            if (mode === 'gdb') {
              const adapter = discoverGdbDap({
                ...(adapterPath ? { explicitPath: adapterPath } : {}),
              });
              const requestConfiguration = request === 'attach'
                ? buildGdbDapPidAttachConfiguration({
                    pid: pid as number,
                    ...(program ? { program } : {}),
                  })
                : buildGdbDapLaunchConfiguration({
                    program: program as string,
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
                  effectivePauseBudgetMs,
                  captureOptions,
                  analysisOptions,
                )),
              };
            }

            if (mode === 'lldb-dap') {
              const adapter = discoverLldbDap({
                ...(adapterPath ? { explicitPath: adapterPath } : {}),
              });
              const requestConfiguration = request === 'attach'
                ? buildLldbDapAttachConfiguration({
                    pid: pid as number,
                    ...(program ? { program } : {}),
                    stopOnEntry: false,
                  })
                : buildLldbDapLaunchConfiguration({
                    program: program as string,
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
                  effectivePauseBudgetMs,
                  captureOptions,
                  analysisOptions,
                )),
              };
            }

            const adapter = discoverCodeLldb({
              ...(adapterPath ? { explicitPath: adapterPath } : {}),
            });
            const requestConfiguration = request === 'attach'
              ? buildCodeLldbAttachConfiguration({
                  pid: pid as number,
                  ...(program ? { program } : {}),
                  stopOnEntry: false,
                })
              : buildCodeLldbLaunchConfiguration({
                  program: program as string,
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
                effectivePauseBudgetMs,
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
