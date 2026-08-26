import type { McpServer } from '@modelcontextprotocol/server';
import type { DebugProtocol } from '@vscode/debugprotocol';
import * as z from 'zod/v4';

import { correlateSourceDisassembly } from '../diagnostics/analyze-snapshot.js';
import { DapError } from '../dap/errors.js';
import { GuardedDapSession } from '../dap/guarded-session.js';
import type { RuntimeSnapshotOptions } from '../dap/session.js';
import { DEBUG_SESSION_CONTROL_ANNOTATIONS } from './tool-annotations.js';

export type FindWriterOptions = {
  name: string;
  variablesReference?: number;
  frameId?: number;
  accessType?: 'read' | 'write' | 'readWrite';
  condition?: string;
  hitCondition?: string;
  threadId?: number;
  timeoutMs?: number;
  replaceExistingDataBreakpoints?: boolean;
  snapshot?: RuntimeSnapshotOptions;
};

type ResumeOutcome = {
  event: 'stopped' | 'exited' | 'terminated';
  body?: unknown;
};

function isDataBreakpointStop(body: unknown): boolean {
  const stopped = body as { reason?: unknown; description?: unknown; text?: unknown } | undefined;
  const text = [stopped?.reason, stopped?.description, stopped?.text]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return /data\s*breakpoint|watchpoint/.test(text);
}

async function continueToOutcome(session: GuardedDapSession, threadId: number, timeoutMs: number): Promise<ResumeOutcome> {
  const outcome = Promise.any([
    session.connection.waitForEvent('stopped', timeoutMs).then((event) => ({ event: 'stopped' as const, body: event.body })),
    session.connection.waitForEvent('exited', timeoutMs).then((event) => ({ event: 'exited' as const, body: event.body })),
    session.connection.waitForEvent('terminated', timeoutMs).then((event) => ({ event: 'terminated' as const, body: event.body })),
  ]);
  await session.continueExecution(threadId, false, timeoutMs);
  return outcome;
}

async function restoreDataBreakpoints(
  session: GuardedDapSession,
  previous: DebugProtocol.DataBreakpoint[],
): Promise<string | undefined> {
  try {
    await session.setDataBreakpoints(previous);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function findWriter(session: GuardedDapSession, options: FindWriterOptions) {
  return session.runExclusiveLifecycle('find writer', async () => {
    if (session.isPostmortem()) {
      throw new DapError('debug_find_writer requires a live stopped target; a crash dump is frozen and cannot trigger a data breakpoint.');
    }

    const timeoutMs = options.timeoutMs ?? 30_000;
    const snapshotOptions: RuntimeSnapshotOptions = {
      ...(options.snapshot ?? {}),
      ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
      includeDisassembly: options.snapshot?.includeDisassembly ?? true,
      includeModules: options.snapshot?.includeModules ?? false,
      includeExceptionInfo: options.snapshot?.includeExceptionInfo ?? true,
    };
    const before = await session.runtimeSnapshot(snapshotOptions);
    const selectedThreadId = options.threadId ?? before.thread.id;
    const frameId = options.frameId ?? before.frame.id;

    const resolution = await session.dataBreakpointInfo(
      options.name,
      options.variablesReference,
      options.variablesReference === undefined ? frameId : undefined,
    );
    if (!resolution.dataId) {
      throw new DapError(`The active debugger cannot create a data breakpoint for '${options.name}': ${resolution.description}`);
    }

    const requestedAccess = options.accessType ?? 'write';
    if (resolution.accessTypes?.length && !resolution.accessTypes.includes(requestedAccess)) {
      throw new DapError(
        `The active debugger does not support accessType='${requestedAccess}' for '${options.name}'. Supported: ${resolution.accessTypes.join(', ')}`,
      );
    }

    const previous = session.dataBreakpointConfiguration();
    const writerBreakpoint: DebugProtocol.DataBreakpoint = {
      dataId: resolution.dataId,
      accessType: requestedAccess,
      ...(options.condition ? { condition: options.condition } : {}),
      ...(options.hitCondition ? { hitCondition: options.hitCondition } : {}),
    };
    const requestedBreakpoints = options.replaceExistingDataBreakpoints
      ? [writerBreakpoint]
      : [...previous, writerBreakpoint];
    const installed = await session.setDataBreakpoints(requestedBreakpoints);

    let outcome: ResumeOutcome;
    try {
      outcome = await continueToOutcome(session, selectedThreadId, timeoutMs);
    } catch (error) {
      try {
        await session.pause(selectedThreadId, true, Math.min(timeoutMs, 5_000));
      } catch {
        // The target may already have exited or the adapter may no longer be resumable.
      }
      const restoreWarning = await restoreDataBreakpoints(session, previous);
      if (restoreWarning) {
        throw new DapError(`${error instanceof Error ? error.message : String(error)}; additionally failed to restore prior data breakpoints: ${restoreWarning}`);
      }
      throw error;
    }

    let after;
    if (outcome.event === 'stopped') {
      after = await session.runtimeSnapshot({ ...snapshotOptions, threadId: selectedThreadId });
    }
    const restoreWarning = await restoreDataBreakpoints(session, previous);
    const hitConfirmed = outcome.event === 'stopped' && isDataBreakpointStop(outcome.body);

    return {
      query: {
        name: options.name,
        accessType: requestedAccess,
        ...(options.variablesReference === undefined ? {} : { variablesReference: options.variablesReference }),
        frameId,
      },
      resolution,
      priorDataBreakpointCount: previous.length,
      replaceExistingDataBreakpoints: options.replaceExistingDataBreakpoints ?? false,
      installed,
      outcome,
      hitConfirmed,
      before: {
        thread: before.thread,
        frame: before.frame,
      },
      ...(after
        ? {
            writerFrame: hitConfirmed ? after.frame : undefined,
            writerCorrelation: hitConfirmed ? correlateSourceDisassembly(after) : undefined,
            snapshot: after,
          }
        : {}),
      ...(restoreWarning ? { restoreWarning } : {}),
      guidance: hitConfirmed
        ? 'The debugger reported a data-breakpoint/watchpoint stop. The top frame is the immediate writer candidate; inspect its source and callers before making a causal claim.'
        : outcome.event === 'stopped'
          ? 'Execution stopped for another reason before the watched write. Inspect this stop; call debug_find_writer again only if it is safe to continue the reproduction.'
          : 'The target exited or terminated before the watched write was observed.',
      status: session.snapshot(),
    };
  });
}

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
  return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
}

export function registerFindWriterTool(server: McpServer, session: GuardedDapSession): void {
  server.registerTool(
    'debug_find_writer',
    {
      title: 'Find Runtime Writer',
      description: 'Set a temporary DAP data breakpoint/watchpoint on a variable or expression, resume an authorized live target, and capture the first resulting stop to identify the immediate writer candidate. Use this after a stopped-state diagnosis suggests a value was corrupted and you need runtime provenance; do not use it for crash dumps or when resuming the program is unsafe. The tool preserves data breakpoints previously configured through this MCP session, restores them afterward, and never automatically continues through an unrelated breakpoint, exception, or signal stop.',
      annotations: DEBUG_SESSION_CONTROL_ANNOTATIONS,
      inputSchema: z.object({
        name: z.string().min(1).describe('Variable child name or debugger expression to watch. Without variablesReference, the expression is resolved in frameId/current frame when supported.'),
        variablesReference: z.number().int().positive().optional().describe('Optional DAP variable-container reference when watching a named child; obtain it from the current stopped state.'),
        frameId: z.number().int().positive().optional().describe('Optional stopped frame used to resolve an expression; omit to use the current snapshot frame. Ignored when variablesReference is supplied.'),
        accessType: z.enum(['read', 'write', 'readWrite']).default('write').describe('Requested watchpoint access mode. write is the normal choice when finding who corrupts a value.'),
        condition: z.string().min(1).optional().describe('Optional adapter-supported condition applied to the temporary data breakpoint.'),
        hitCondition: z.string().min(1).optional().describe('Optional adapter-supported hit-count condition for the temporary data breakpoint.'),
        threadId: z.number().int().positive().optional().describe('Stopped thread to resume and inspect; omit to use the debugger-selected stopped thread.'),
        timeoutMs: z.number().int().min(1000).max(120000).default(30000).describe('Maximum time in milliseconds to wait for a stop, exit, or termination after resuming.'),
        replaceExistingDataBreakpoints: z.boolean().default(false).describe('When false, preserve existing MCP-configured data breakpoints alongside the temporary writer watch; when true, temporarily replace them for a cleaner reproduction.'),
        snapshot: z.object({
          stackLevels: z.number().int().positive().max(100).default(12).describe('Maximum stack frames captured at the writer stop.'),
          maxVariablesPerScope: z.number().int().positive().max(500).default(100).describe('Maximum variables captured per scope at the writer stop.'),
          includeDisassembly: z.boolean().default(true).describe('Include nearby instructions at the writer stop when supported.'),
          disassembleBefore: z.number().int().nonnegative().max(100).default(8).describe('Instructions requested before the writer instruction.'),
          disassembleAfter: z.number().int().nonnegative().max(100).default(12).describe('Instructions requested after the writer instruction.'),
          includeModules: z.boolean().default(false).describe('Include a bounded module list at the writer stop.'),
          moduleCount: z.number().int().positive().max(500).default(50).describe('Maximum modules returned when module collection is enabled.'),
          includeExceptionInfo: z.boolean().default(true).describe('Collect exception information if the resulting stop is an exception rather than the expected watchpoint.'),
        }).optional().describe('Bounds for the evidence snapshot captured after execution stops.'),
      }),
    },
    async (options) => {
      try {
        return result(await findWriter(session, options as FindWriterOptions));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
