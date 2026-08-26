import type { McpServer } from '@modelcontextprotocol/server';
import type { DebugProtocol } from '@vscode/debugprotocol';
import * as z from 'zod/v4';

import { correlateSourceDisassembly } from '../diagnostics/analyze-snapshot.js';
import { DapError } from '../dap/errors.js';
import { GuardedDapSession } from '../dap/guarded-session.js';
import type { RuntimeSnapshotOptions } from '../dap/session.js';
import { DEBUG_SESSION_CONTROL_ANNOTATIONS } from './tool-annotations.js';
import { debugFindWriterOutputSchema, structuredResult } from './agent-output.js';

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

type WatchInstallation = {
  strategy: 'dap-data-breakpoint' | 'gdb-watch';
  resolution: unknown;
  installed: unknown;
  priorDataBreakpointCount: number;
  cleanup: (frameId?: number) => Promise<string | undefined>;
};

function isDataBreakpointStop(body: unknown): boolean {
  const stopped = body as { reason?: unknown; description?: unknown; text?: unknown } | undefined;
  const text = [stopped?.reason, stopped?.description, stopped?.text]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return /data\s*breakpoint|watchpoint/.test(text);
}

function validateGdbWatchExpression(expression: string): string {
  const trimmed = expression.trim();
  if (!trimmed) throw new DapError('GDB writer expression must not be empty.');
  if (trimmed.length > 512) throw new DapError('GDB writer expression exceeds the 512-character safety bound.');
  if(/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new DapError('GDB writer expressions must not contain control characters or line breaks.');
  }
  return trimmed;
}

function gdbWatchCommand(accessType: 'read' | 'write' | 'readWrite', expression: string): string {
  const command = accessType === 'read' ? 'rwatch' : accessType === 'readWrite' ? 'awatch' : 'watch';
  return `${command} ${validateGdbWatchExpression(expression)}`;
}

function parseGdbWatchpointId(result: string): number | undefined {
  const match = result.match(/\bwatchpoint\s+(\d+)\b/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
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

async function installNativeDataBreakpoint(
  session: GuardedDapSession,
  options: FindWriterOptions,
  frameId: number,
  requestedAccess: 'read' | 'write' | 'readWrite',
): Promise<WatchInstallation> {
  const resolution = await session.dataBreakpointInfo(
    options.name,
    options.variablesReference,
    options.variablesReference === undefined ? frameId : undefined,
  );
  if (!resolution.dataId) {
    throw new DapError(`The active debugger cannot create a data breakpoint for '${options.name}': ${resolution.description}`);
  }
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

  return {
    strategy: 'dap-data-breakpoint',
    resolution,
    installed,
    priorDataBreakpointCount: previous.length,
    cleanup: async () => restoreDataBreakpoints(session, previous),
  };
}

async function installGdbWatchpoint(
  session: GuardedDapSession,
  options: FindWriterOptions,
  frameId: number,
  requestedAccess: 'read' | 'write' | 'readWrite',
): Promise<WatchInstallation> {
  if (options.variablesReference !== undefined) {
    throw new DapError(
      'GDB 14/15 DAP does not advertise native data-breakpoint resolution. For the GDB watch fallback, pass name as a debugger-visible expression and omit variablesReference.',
    );
  }
  if (options.condition || options.hitCondition) {
    throw new DapError(
      'Conditional/hit-count writer watches require native DAP data-breakpoint support. The bounded GDB watch fallback intentionally accepts only a watch expression and access type.',
    );
  }

  const command = gdbWatchCommand(requestedAccess, options.name);
  const response = await session.evaluate(command, frameId, 'repl');
  const watchpointId = parseGdbWatchpointId(response.result);
  if (!watchpointId) {
    throw new DapError(
      `GDB accepted the watch command but qwen-dap-mcp could not identify the temporary watchpoint number for safe cleanup. GDB response: ${response.result}`,
    );
  }

  return {
    strategy: 'gdb-watch',
    resolution: {
      expression: options.name,
      accessType: requestedAccess,
      commandKind: requestedAccess === 'read' ? 'rwatch' : requestedAccess === 'readWrite' ? 'awatch' : 'watch',
      watchpointId,
      adapterNativeDataBreakpointsAdvertised: false,
    },
    installed: {
      watchpointId,
      result: response.result,
    },
    priorDataBreakpointCount: session.dataBreakpointConfiguration().length,
    cleanup: async (currentFrameId) => {
      try {
        await session.evaluate(`delete ${watchpointId}`, currentFrameId, 'repl');
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  };
}

async function installWriterWatch(
  session: GuardedDapSession,
  options: FindWriterOptions,
  frameId: number,
  requestedAccess: 'read' | 'write' | 'readWrite',
): Promise<WatchInstallation> {
  const state = session.snapshot();
  if (state.capabilities?.supportsDataBreakpoints === true) {
    return installNativeDataBreakpoint(session, options, frameId, requestedAccess);
  }
  if (state.adapterId === 'gdb') {
    return installGdbWatchpoint(session, options, frameId, requestedAccess);
  }
  throw new DapError(
    `The active DAP adapter '${state.adapterId ?? 'unknown'}' does not advertise data-breakpoint support, so debug_find_writer cannot safely install a writer watch.`,
  );
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
    const requestedAccess = options.accessType ?? 'write';
    const watch = await installWriterWatch(session, options, frameId, requestedAccess);

    let outcome: ResumeOutcome;
    try {
      outcome = await continueToOutcome(session, selectedThreadId, timeoutMs);
    } catch (error) {
      try {
        await session.pause(selectedThreadId, true, Math.min(timeoutMs, 5_000));
      } catch {
        // The target may already have exited or the adapter may no longer be resumable.
      }
      const cleanupWarning = await watch.cleanup(frameId);
      if (cleanupWarning) {
        throw new DapError(`${error instanceof Error ? error.message : String(error)}; additionally failed to remove the temporary writer watch: ${cleanupWarning}`);
      }
      throw error;
    }

    let after;
    if (outcome.event === 'stopped') {
      after = await session.runtimeSnapshot({ ...snapshotOptions, threadId: selectedThreadId });
    }
    const cleanupWarning = await watch.cleanup(after?.frame.id ?? frameId);
    const hitConfirmed = outcome.event === 'stopped' && isDataBreakpointStop(outcome.body);

    return {
      query: {
        name: options.name,
        accessType: requestedAccess,
        ...(options.variablesReference === undefined ? {} : { variablesReference: options.variablesReference }),
        frameId,
      },
      strategy: watch.strategy,
      resolution: watch.resolution,
      priorDataBreakpointCount: watch.priorDataBreakpointCount,
      replaceExistingDataBreakpoints: options.replaceExistingDataBreakpoints ?? false,
      installed: watch.installed,
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
      ...(cleanupWarning ? { cleanupWarning } : {}),
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
  return structuredResult(value);
}

function errorResult(error: unknown) {
  return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
}

export function registerFindWriterTool(server: McpServer, session: GuardedDapSession): void {
  server.registerTool(
    'debug_find_writer',
    {
      title: 'Find Runtime Writer',
      description: 'Temporarily watch a variable or debugger expression, resume an authorized live target, and capture the first resulting stop to identify the immediate writer candidate. Use this after a stopped-state diagnosis suggests a value was corrupted and runtime provenance is needed; do not use it for crash dumps or when resuming is unsafe. Adapters with DAP data-breakpoint support use that protocol directly; GDB 14/15 uses a bounded watch/rwatch/awatch command through DAP REPL because those releases do not advertise native data breakpoints. The tool removes only the temporary watch it created and never automatically continues through an unrelated stop.',
      annotations: DEBUG_SESSION_CONTROL_ANNOTATIONS,
      outputSchema: debugFindWriterOutputSchema,
      inputSchema: z.object({
        name: z.string().min(1).max(512).describe('Variable child name or debugger expression to watch. Without variablesReference, the expression is resolved in frameId/current frame when supported. GDB fallback expressions must not contain control characters or line breaks.'),
        variablesReference: z.number().int().positive().optional().describe('Optional DAP variable-container reference when the adapter advertises native data breakpoints. Omit for the GDB watch-command fallback and pass a debugger-visible expression in name instead.'),
        frameId: z.number().int().positive().optional().describe('Optional stopped frame used to resolve an expression; omit to use the current snapshot frame. Ignored by native DAP child resolution when variablesReference is supplied.'),
        accessType: z.enum(['read', 'write', 'readWrite']).default('write').describe('Requested watchpoint access mode. write is the normal choice when finding who corrupts a value; GDB maps these to watch/rwatch/awatch.'),
        condition: z.string().min(1).optional().describe('Optional adapter-supported condition for native DAP data breakpoints. Intentionally rejected by the bounded GDB fallback.'),
        hitCondition: z.string().min(1).optional().describe('Optional adapter-supported hit-count condition for native DAP data breakpoints. Intentionally rejected by the bounded GDB fallback.'),
        threadId: z.number().int().positive().optional().describe('Stopped thread to resume and inspect; omit to use the debugger-selected stopped thread.'),
        timeoutMs: z.number().int().min(1000).max(120000).default(30000).describe('Maximum time in milliseconds to wait for a stop, exit, or termination after resuming.'),
        replaceExistingDataBreakpoints: z.boolean().default(false).describe('For native DAP data breakpoints, temporarily replace existing MCP-managed watches when true. The GDB fallback never deletes unrelated CLI watchpoints and only removes its own temporary watch.'),
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
