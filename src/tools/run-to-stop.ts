import type { DebugProtocol } from '@vscode/debugprotocol';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { DapError, DapTimeoutError } from '../dap/errors.js';
import type {
  RuntimeSnapshot,
  RuntimeSnapshotOptions,
  SourceBreakpointGroup,
} from '../dap/session.js';

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

  const cleanup = (handler: (event: DebugProtocol.Event) => void, timer: NodeJS.Timeout) => {
    if (!active) return;
    active = false;
    clearTimeout(timer);
    session.connection.off('event', handler);
  };

  let handler!: (event: DebugProtocol.Event) => void;
  let timer!: NodeJS.Timeout;

  const promise = new Promise<DebugProtocol.Event | undefined>((resolve, reject) => {
    resolvePromise = resolve;
    handler = (event: DebugProtocol.Event) => {
      if (!OUTCOME_EVENTS.has(event.event)) return;
      cleanup(handler, timer);
      resolve(event);
    };
    timer = setTimeout(() => {
      cleanup(handler, timer);
      reject(new DapTimeoutError('DAP stopped/exited/terminated event', timeoutMs));
    }, timeoutMs);
    session.connection.on('event', handler);
  });

  return {
    promise,
    cancel: () => {
      if (!active) return;
      cleanup(handler, timer);
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
    // possible early timeout immediately so Node never reports it as an
    // unhandled rejection; the original promise is still awaited below and
    // retains its normal timeout behavior on the success path.
    void outcomeWait.promise.catch(() => undefined);

    let requestResult: unknown;
    try {
      requestResult = request === 'attach'
        ? await session.attach(options.configuration, breakpoints)
        : await session.launch(options.configuration, breakpoints);
    } catch (error) {
      outcomeWait.cancel();
      // The outcome timer may already have rejected while launch/attach was
      // still failing. That stale wait must never mask the actionable DAP
      // request error that brought us here.
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

const jsonRecord = z.record(z.string(), z.unknown());
const breakpointGroupSchema = z.object({
  source: z.string().min(1).describe('Absolute or adapter-resolvable source file path'),
  lines: z.array(z.number().int().positive()).min(1),
});
const snapshotSchema = z.object({
  threadId: z.number().int().positive().optional(),
  stackLevels: z.number().int().positive().max(100).optional(),
  maxVariablesPerScope: z.number().int().positive().max(500).optional(),
  includeDisassembly: z.boolean().optional(),
  disassembleBefore: z.number().int().nonnegative().max(100).optional(),
  disassembleAfter: z.number().int().nonnegative().max(100).optional(),
  includeModules: z.boolean().optional(),
  moduleCount: z.number().int().positive().max(500).optional(),
  includeExceptionInfo: z.boolean().optional(),
});

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
      description: 'Launch or attach through an initialized live DAP session, configure optional source breakpoints, wait race-safely for stopped/exited/terminated, and return a bounded runtime snapshot when execution stops.',
      inputSchema: z.object({
        request: z.enum(['launch', 'attach']).default('launch'),
        configuration: jsonRecord,
        breakpoints: z.array(breakpointGroupSchema).optional(),
        timeoutMs: z.number().int().min(1000).max(120000).default(30000),
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
