import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { buildCodeLldbLaunchConfiguration, discoverCodeLldb } from '../adapters/codelldb.js';
import { analyzeRuntimeSnapshot, correlateSourceDisassembly } from '../diagnostics/analyze-snapshot.js';
import { DapError } from '../dap/errors.js';
import type { RuntimeSnapshotOptions, SourceBreakpointGroup } from '../dap/session.js';
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

async function captureDiagnosticSnapshot(session: GuardedDapSession, options: RuntimeSnapshotOptions = {}) {
  const snapshot = await session.runtimeSnapshot({
    ...options,
    includeDisassembly: options.includeDisassembly ?? true,
    includeModules: options.includeModules ?? true,
    includeExceptionInfo: options.includeExceptionInfo ?? true,
  });
  return {
    snapshot,
    diagnosis: analyzeRuntimeSnapshot(snapshot),
  };
}

export function registerAgentDiagnosticTools(server: McpServer, session: GuardedDapSession): void {
  server.registerTool(
    'debug_diagnose_stop',
    {
      title: 'Diagnose Current Debug Stop',
      description:
        'Capture the current stopped state and produce an agent-friendly diagnosis with crash classification, exception evidence, suspicious values, ranked hypotheses, source/disassembly correlation, and next checks.',
      inputSchema: snapshotSchema,
    },
    async (options) => {
      try {
        return result(await captureDiagnosticSnapshot(session, options as RuntimeSnapshotOptions));
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
        'Correlate the current top source frame and instruction pointer with nearby disassembly, highlighting the current/nearest instruction and surrounding instructions.',
      inputSchema: z.object({
        threadId: z.number().int().positive().optional(),
        stackLevels: z.number().int().positive().max(100).default(12),
        disassembleBefore: z.number().int().nonnegative().max(100).default(8),
        disassembleAfter: z.number().int().nonnegative().max(100).default(12),
      }),
    },
    async ({ threadId, stackLevels, disassembleBefore, disassembleAfter }) => {
      try {
        const snapshot = await session.runtimeSnapshot({
          ...(threadId === undefined ? {} : { threadId }),
          stackLevels,
          maxVariablesPerScope: 20,
          includeDisassembly: true,
          disassembleBefore,
          disassembleAfter,
          includeModules: false,
          includeExceptionInfo: false,
        });
        return result({
          correlation: correlateSourceDisassembly(snapshot),
          frame: snapshot.frame,
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
        'High-level agent workflow. Diagnose the current stop, run an initialized DAP session until stop/exit, auto-start CodeLLDB and run a local native program, or open a crash dump; then return structured evidence and likely causes.',
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
    }) => {
      try {
        return result(await session.runExclusiveLifecycle('debug this crash', async () => {
          const snapshotOptions = (snapshot ?? {}) as RuntimeSnapshotOptions;

          if (mode === 'current') {
            return {
              mode,
              ...(await captureDiagnosticSnapshot(session, snapshotOptions)),
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
            return {
              mode,
              dump: opened,
              diagnosis: analyzeRuntimeSnapshot(opened.snapshot),
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
            return {
              mode,
              adapter,
              capabilities,
              run,
              diagnosis: run.snapshot
                ? analyzeRuntimeSnapshot(run.snapshot)
                : terminalOutcomeDiagnosis(run.outcome as { event: 'exited' | 'terminated'; body?: unknown }),
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
          return {
            mode,
            run,
            diagnosis: run.snapshot
              ? analyzeRuntimeSnapshot(run.snapshot)
              : terminalOutcomeDiagnosis(run.outcome as { event: 'exited' | 'terminated'; body?: unknown }),
            status: session.snapshot(),
          };
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
