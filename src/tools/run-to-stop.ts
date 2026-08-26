import type { DebugProtocol } from '@vscode/debugprotocol';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { DapError, DapTimeoutError } from '../dap/errors.js';
import type {
  RuntimeSnapshot,
  RuntimeSnapshotOptions,
  SourceBreakpointGroup,
} from '../dap/session.js';
import { LOCAL_TARGET_EXECUTION_ANNOTATIONS } from './tool-annotations.js';

export type RunToStopRequest = 'launch' | 'attach';

export type RunToStopSession = {
  connection: {
    on(eventName: string | symbol, listener: (...args: any[]) => void): unknown;
    off(eventName: string | symbol, listener: (...args: any[]) => void): unknown;
  };
  runExclusiveLifecycle<T>(operation: string, action: () => Promise<T>): Promise<T>;
  isPostmortem(): boolean;
  launch(configuration: Record<string, unknown>, breakpoints?: SourceBreakpointGroup[]): Promise<unknown>;
  attach(configuration: Record<string, unknown>, breakpoints?: SourceBreakpointGroup[]): Promise<unknown>;
  runtimeSnapshot(options?: RuntimeSnapshotOptions): Promise<RuntimeSnapshot>;
  snapshot(): unknown;
};

export type RunToStopOptions = {
  request?: RunToStopRequest;
  configuration: Record<string, unknown>;
  breakpoints?: SourceBreakpointGroup[];
  timeoutMs?: number;
  snapshot?: RuntimeSnapshotOptions;
};

export type RunToStopResult = {
  request: RunToStopRequest;
  requestResult: unknown;
  outcome: {
    event: 'stopped' | 'exited' | 'terminated';
    body?: unknown;
  };
  snapshot?: RuntimeSnapshot;
  status: unknown;
};

const OUTCOME_EVENTS = new Set(['stopped', 'exited', 'terminated']);

function createOutcomeWait(session: RunToStopSession, timeoutMs: number) {
  let active = true;
  let resolvePromise!: (event: DebugProtocol.Event | undefined) => void;
  let handler!: (event: DebugProtocol.Event) => void;
  let onAdapterExit!: (detail: unknown) => void;
  let onAdapterError!: (error: unknown) => void;
  let timer!: NodeJS.Timeout;

  const cleanup = () => {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    session.connection.off('event', handler);
    session.connection.off('adapterExit', onAdapterExit);
    session.connection.off('adapterError', onAdapterError);
  };

  const promise = new Promise<DebugProtocol.Event | undefined>((resolve, reject) => {
    resolvePromise = resolve;
    handler = (event: DebugProtocol.Event) => {
      if (!OUTCOME_EVENTS.has(event.event)) return;
      cleanup();
      resolve(event);
    };
    onAdapterExit = (detail: unknown) => {
      cleanup();
      reject(new DapError(`DAP adapter exited before stopped/exited/terminated was observed: ${JSON.stringify(detail ?? {})}`));
    };
    onAdapterError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new DapError('DAP adapter failed while waiting for stopped/exited/terminated.'));
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new DapTimeoutError('DAP stopped/exited/terminated event', timeoutMs));
    }, timeoutMs);
    session.connection.on('event', handler);
    session.connection.on('adapterExit', onAdapterExit);
    session.connection.on('adapterError', onAdapterError);
  });

  return {
    promise,
    cancel: () => {
      if (!active) return;
      cleanup();
      resolvePromise(undefined);
    },
  };
}

export async function runToStop(
  session: RunToStopSession,
  options: RunToStopOptions,
): Promise<RunToStopResult> {
  const request = options.request ?? 'launch';
  const breakpoints = options.breakpoints ?? [];
  const timeoutMs = options.timeoutMs ?? 30_000;

  return session.runExclusiveLifecycle('run to stop', async () => {
    if (session.isPostmortem()) {
      throw new DapError('Cannot run to stop in a postmortem crash-dump session. Start a live debug session first.');
    }

    // Arm the event listener before launch/attach so an immediate stop or fast
    // process exit cannot race past the composite tool between DAP requests.
    const outcomeWait = createOutcomeWait(session, timeoutMs);
    // launch/attach may itself take longer than the outcome timer. Observe a
    // possible early rejection immediately so Node never reports it as an
    // unhandled rejection; the original promise is still awaited below.
    void outcomeWait.promise.catch(() => undefined);

    let requestResult: unknown;
    try {
      requestResult = request === 'attach'
        ? await session.attach(options.configuration, breakpoints)
        : await session.launch(options.configuration, breakpoints);
    } catch (error) {
      outcomeWait.cancel();
      // A stale outcome timeout/adapter-exit error must never mask the more
      // specific launch/attach error that brought us here.
      await outcomeWait.promise.catch(() => undefined);
      throw error;
    }

    const event = await outcomeWait.promise;
    if (!event) {
      throw new DapError('The run-to-stop event wait was cancelled unexpectedly.');
    }

    const outcome = {
      event: event.event as 'stopped' | 'exited' | 'terminated',
      ...(event.body === undefined ? {} : { body: event.body }),
    };

    if (event.event !== 'stopped') {
      return {
        request,
        requestResult,
        outcome,
        status: session.snapshot(),
      };
    }

    const stopped = event.body as DebugProtocol.StoppedEvent['body'] | undefined;
    const snapshotOptions: RuntimeSnapshotOptions = {
      ...(options.snapshot ?? {}),
      ...(options.snapshot?.threadId === undefined && stopped?.threadId !== undefined
        ? { threadId: stopped.threadId }
        : {}),
    };
    const snapshot = await session.runtimeSnapshot(snapshotOptions);

    return {
      request,
      requestResult,
      outcome,
      snapshot,
      status: session.snapshot(),
    };
  });
}

const jsonRecord = z.record(z.string(), z.unknown()).describe('Adapter-specific DAP launch or attach configuration.');
const breakpointGroupSchema = z.object({
  source: z.string().min(1).describe('Absolute or adapter-resolvable source file path.'),
  lines: z.array(z.number().int().positive()).min(1).describe('One or more 1-based source line numbers to replace as breakpoints for this source file.'),
}).describe('Source file and line breakpoints applied before configuration completes.');
const snapshotSchema = z.object({
  threadId: z.number().int().positive().optional().describe('Stopped thread to snapshot; omit to use the thread from the stopped event.'),
  stackLevels: z.number().int().positive().max(100).optional().describe('Maximum stack frames to collect after a stop.'),
  maxVariablesPerScope: z.number().int().positive().max(500).optional().describe('Maximum variables to return per inspected scope.'),
  includeDisassembly: z.boolean().optional().describe('Whether to include best-effort disassembly near the selected frame.'),
  disassembleBefore: z.number().int().nonnegative().max(100).optional().describe('Instructions before the selected instruction to request.'),
  disassembleAfter: z.number().int().nonnegative().max(100).optional().describe('Instructions after the selected instruction to request.'),
  includeModules: z.boolean().optional().describe('Whether to include a bounded loaded-module list.'),
  moduleCount: z.number().int().positive().max(500).optional().describe('Maximum loaded modules to include.'),
  includeExceptionInfo: z.boolean().optional().describe('Whether to request structured exception information after a stop.'),
}).describe('Optional bounds and evidence categories for the snapshot captured only when execution stops.');

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

export function registerRunToStopTool(server: McpServer, session: RunToStopSession): void {
  server.registerTool(
    'debug_run_to_stop',
    {
      title: 'Run Until Debug Stop or Exit',
      description: 'Run one live launch or attach through an already initialized DAP adapter until the first stopped, exited, or terminated event. Use this when you need deterministic runtime evidence from a reproduction; do not use it for a postmortem dump or when executing/attaching to the local target is not authorized. Launch mode executes application code and attach mode changes debugger control of an existing process, so normal target side effects may occur before the stop. Returns the request result, terminal/stopped outcome, session status, and a bounded snapshot only when a stopped event is captured.',
      annotations: LOCAL_TARGET_EXECUTION_ANNOTATIONS,
      inputSchema: z.object({
        request: z.enum(['launch', 'attach']).default('launch').describe('Choose launch to start a new target from configuration, or attach to connect to an existing authorized local target.'),
        configuration: jsonRecord,
        breakpoints: z.array(breakpointGroupSchema).optional().describe('Optional source breakpoint groups configured before the debugger completes launch/attach setup.'),
        timeoutMs: z.number().int().min(1000).max(120000).default(30000).describe('Maximum milliseconds to wait for the first stopped, exited, or terminated event.'),
        snapshot: snapshotSchema.optional(),
      }),
    },
    async ({ request, configuration, breakpoints, timeoutMs, snapshot }) => {
      try {
        return result(await runToStop(session, {
          request,
          configuration,
          ...(breakpoints ? { breakpoints } : {}),
          timeoutMs,
          ...(snapshot ? { snapshot } : {}),
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
