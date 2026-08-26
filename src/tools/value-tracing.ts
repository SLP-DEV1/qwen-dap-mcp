import type { McpServer } from '@modelcontextprotocol/server';
import type { DebugProtocol } from '@vscode/debugprotocol';
import * as z from 'zod/v4';

import { runWithDapOperationContext } from '../dap/operation-context.js';
import { GuardedDapSession } from '../dap/guarded-session.js';
import type { RuntimeSnapshot, RuntimeSnapshotOptions } from '../dap/session.js';
import { findWriter } from './find-writer.js';
import { debugTraceValueOutputSchema, structuredResult } from './agent-output.js';
import { DEBUG_SESSION_CONTROL_ANNOTATIONS } from './tool-annotations.js';

export type TraceValueOptions = {
  name: string;
  accessType?: 'write' | 'readWrite';
  threadId?: number;
  maxStops?: number;
  timeoutMs?: number;
  perStopTimeoutMs?: number;
  snapshot?: RuntimeSnapshotOptions;
};

export type ObservedTraceValue = {
  name: string;
  value: string;
  type?: string;
  evaluateName?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizedExpression(value: string): string {
  return value.trim().replace(/^this->/, '').replace(/^\*/, '');
}

export function findObservedValue(snapshot: RuntimeSnapshot, expression: string): ObservedTraceValue | undefined {
  const target = normalizedExpression(expression);
  const candidates: DebugProtocol.Variable[] = [...snapshot.locals, ...snapshot.registers];
  const exact = candidates.find((variable) => {
    const names = [variable.name, variable.evaluateName]
      .filter((value): value is string => typeof value === 'string')
      .map(normalizedExpression);
    return names.includes(target);
  });
  if (!exact) return undefined;
  return {
    name: exact.name,
    value: exact.value,
    ...(exact.type ? { type: exact.type } : {}),
    ...(exact.evaluateName ? { evaluateName: exact.evaluateName } : {}),
  };
}

export async function traceValue(session: GuardedDapSession, options: TraceValueOptions) {
  const maxStops = options.maxStops ?? 8;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const perStopTimeoutMs = options.perStopTimeoutMs ?? 15_000;
  const snapshotOptions: RuntimeSnapshotOptions = {
    ...(options.snapshot ?? {}),
    ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
    includeDisassembly: options.snapshot?.includeDisassembly ?? true,
    includeModules: options.snapshot?.includeModules ?? false,
    includeExceptionInfo: options.snapshot?.includeExceptionInfo ?? true,
  };

  return runWithDapOperationContext(
    { label: `trace-value:${options.name}`, timeoutMs },
    async (operation) => session.runExclusiveLifecycle('trace value', async () => {
      if (session.isPostmortem()) {
        throw new Error('debug_trace_value requires a live stopped target; a crash dump cannot produce a write timeline.');
      }

      let currentSnapshot = await session.runtimeSnapshot(snapshotOptions);
      const events: Array<Record<string, unknown>> = [];
      let stopReason: 'max-stops' | 'target-exited' | 'target-terminated' | 'unrelated-stop' | 'no-writer-snapshot' | 'error' = 'max-stops';
      let terminalError: string | undefined;

      for (let index = 0; index < maxStops; index += 1) {
        operation.throwIfAborted();
        const beforeValue = findObservedValue(currentSnapshot, options.name);
        const remaining = operation.remainingMs(perStopTimeoutMs);
        const writerTimeout = Math.max(1, Math.min(perStopTimeoutMs, remaining));

        let writer;
        try {
          writer = await findWriter(session, {
            name: options.name,
            frameId: currentSnapshot.frame.id,
            accessType: options.accessType ?? 'write',
            threadId: options.threadId ?? currentSnapshot.thread.id,
            timeoutMs: writerTimeout,
            replaceExistingDataBreakpoints: false,
            snapshot: snapshotOptions,
          });
        } catch (error) {
          stopReason = 'error';
          terminalError = errorMessage(error);
          break;
        }

        const afterSnapshot = writer.snapshot as RuntimeSnapshot | undefined;
        const afterValue = afterSnapshot ? findObservedValue(afterSnapshot, options.name) : undefined;
        events.push({
          index: index + 1,
          strategy: writer.strategy,
          hitConfirmed: writer.hitConfirmed,
          outcome: writer.outcome,
          ...(writer.writerFrame ? { writerFrame: writer.writerFrame } : {}),
          ...(writer.writerCorrelation ? { writerCorrelation: writer.writerCorrelation } : {}),
          ...(beforeValue ? { beforeValue } : {}),
          ...(afterValue ? { afterValue } : {}),
          valueChanged: beforeValue && afterValue ? beforeValue.value !== afterValue.value : undefined,
        });

        if (writer.outcome.event === 'exited') {
          stopReason = 'target-exited';
          break;
        }
        if (writer.outcome.event === 'terminated') {
          stopReason = 'target-terminated';
          break;
        }
        if (!writer.hitConfirmed) {
          stopReason = 'unrelated-stop';
          break;
        }
        if (!afterSnapshot) {
          stopReason = 'no-writer-snapshot';
          break;
        }
        currentSnapshot = afterSnapshot;
      }

      return {
        query: {
          name: options.name,
          accessType: options.accessType ?? 'write',
          maxStops,
          timeoutMs,
          perStopTimeoutMs,
        },
        events,
        stopReason,
        ...(terminalError ? { terminalError } : {}),
        finalSnapshot: currentSnapshot,
        guidance: [
          'Each confirmed event identifies an immediate runtime writer candidate observed by a data breakpoint/watchpoint.',
          'The sequence is temporal evidence, but it is not by itself proof that the earliest or latest writer is the root cause.',
          'A missing beforeValue/afterValue means the watched expression was not present as an exact local/register name in the bounded snapshot; the watchpoint stop itself may still be valid.',
          'The trace stops on unrelated debugger stops rather than silently continuing through them.',
        ],
        status: session.snapshot(),
      };
    }),
  );
}

function errorResult(error: unknown) {
  return { content: [{ type: 'text' as const, text: errorMessage(error) }], isError: true };
}

export function registerValueTracingTool(server: McpServer, session: GuardedDapSession): void {
  server.registerTool(
    'debug_trace_value',
    {
      title: 'Trace Runtime Value Writes',
      description: 'Build a bounded temporal write timeline for one debugger-visible variable or expression. Use this after differential or crash evidence identifies a suspicious value and repeated live-target resume is safe. The tool installs one temporary data breakpoint or watchpoint at a time, resumes to the next confirmed writer, captures bounded runtime evidence, removes only its own temporary watch, and repeats. Do not use it for crash dumps, unsafe-to-resume targets, or as proof that an observed writer is the root cause; it stops on unrelated debugger events rather than continuing through them.',
      annotations: DEBUG_SESSION_CONTROL_ANNOTATIONS,
      outputSchema: debugTraceValueOutputSchema,
      inputSchema: z.object({
        name: z.string().min(1).max(512).describe('Debugger-visible variable or expression to watch. Control characters and line breaks are rejected by the GDB fallback.'),
        accessType: z.enum(['write', 'readWrite']).default('write').describe('Watch writes only by default; readWrite may be used when read access is also relevant.'),
        threadId: z.number().int().positive().optional().describe('Initial stopped thread; omit to use the debugger-selected stopped thread. Writer snapshots follow the actual stopped event thread.'),
        maxStops: z.number().int().min(1).max(16).default(8).describe('Maximum confirmed or unrelated writer-stop observations before the trace ends.'),
        timeoutMs: z.number().int().min(1000).max(120_000).default(60_000).describe('Aggregate operation deadline across the entire write timeline.'),
        perStopTimeoutMs: z.number().int().min(250).max(30_000).default(15_000).describe('Maximum bounded wait allocated to each individual writer observation, also capped by the aggregate deadline.'),
        snapshot: z.object({
          stackLevels: z.number().int().positive().max(100).default(12),
          maxVariablesPerScope: z.number().int().positive().max(500).default(100),
          includeDisassembly: z.boolean().default(true),
          disassembleBefore: z.number().int().nonnegative().max(100).default(8),
          disassembleAfter: z.number().int().nonnegative().max(100).default(12),
          includeModules: z.boolean().default(false),
          moduleCount: z.number().int().positive().max(500).default(50),
          includeExceptionInfo: z.boolean().default(true),
        }).optional().describe('Optional bounded evidence settings for each observed writer stop.'),
      }),
    },
    async (options) => {
      try {
        return structuredResult(await traceValue(session, options as TraceValueOptions));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
