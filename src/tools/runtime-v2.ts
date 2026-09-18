import type { McpServer } from '@modelcontextprotocol/server';
import type { DebugProtocol } from '@vscode/debugprotocol';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod/v4';

import { discoverCodeLldb } from '../adapters/codelldb.js';
import {
  buildGdbDapRemoteAttachConfiguration,
  discoverGdbDap,
} from '../adapters/gdb-dap.js';
import { discoverLldbDap } from '../adapters/lldb-dap.js';
import { buildRrReplayPlan, discoverRr, recordWithRr } from '../adapters/rr.js';
import { ManagedRrReplay } from '../adapters/rr-replay.js';
import { DapError } from '../dap/errors.js';
import { GuardedDapSession } from '../dap/guarded-session.js';
import type { RuntimeSnapshot } from '../dap/session.js';
import {
  buildLockOwnerGraph,
  classifyThreadObservation,
  compareCrashFamilies,
  moduleForAddress,
} from '../diagnostics/runtime-v2.js';
import {
  configuredSymbolResolvers,
  findLocalSymbolCandidates,
  inspectBinaryIdentity,
  inspectPdbIdentity,
  symbolMismatchSummary,
} from '../diagnostics/symbol-doctor.js';
import { exportEvidenceBundle, importEvidenceBundle } from '../evidence-bundle.js';
import { resolveExistingDirectory } from '../local-path.js';
import { securityProfileSnapshot } from '../security-profile.js';
import {
  analyzeAbiArguments,
  buildCrashReport,
  detectMemoryHazards,
  parseSanitizerEvidence,
} from './advanced-runtime.js';
import {
  debugAdapterDoctorOutputSchema,
  debugAdaptiveEvidenceOutputSchema,
  debugCppObjectOutputSchema,
  debugCrashFamiliesOutputSchema,
  debugDumpBatchOutputSchema,
  debugEvidenceBundleOutputSchema,
  debugLifetimeTraceOutputSchema,
  debugSymbolDoctorOutputSchema,
  debugThreadTimelineOutputSchema,
  debugTimeTravelOutputSchema,
  structuredResult,
} from './agent-output.js';
import { openDump, type DumpAdapterKind } from './register-dump-tools.js';
import { findObservedValue, traceValue } from './value-tracing.js';
import {
  DEBUG_SESSION_CONTROL_ANNOTATIONS,
  LOCAL_TARGET_EXECUTION_ANNOTATIONS,
  READ_ONLY_LOCAL_TOOL_ANNOTATIONS,
} from './tool-annotations.js';

const RR_REPLAY_BY_CONNECTION = new WeakMap<object, ManagedRrReplay>();

function replayManagerFor(session: GuardedDapSession): ManagedRrReplay {
  const key = session.connection as unknown as object;
  let manager = RR_REPLAY_BY_CONNECTION.get(key);
  if (!manager) {
    manager = new ManagedRrReplay();
    RR_REPLAY_BY_CONNECTION.set(key, manager);
  }
  return manager;
}

const LOCAL_ARTIFACT_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function debuggerOutput(session: GuardedDapSession): string[] {
  const status = session.snapshot();
  const dap = status.recentEvents
    .filter((record) => (record as { event?: unknown }).event === 'output')
    .map((record) => {
      const body = (record as { body?: { output?: unknown } }).body;
      return typeof body?.output === 'string' ? body.output.trim() : '';
    })
    .filter(Boolean);
  return [...status.recentAdapterStderr.slice(-50), ...dap.slice(-50)].slice(-100);
}

function parsePointer(value: string): bigint | undefined {
  const match = value.replace(/\`/g, '').match(/0x([0-9a-f]+)/i);
  if (!match) return undefined;
  try { return BigInt('0x' + match[1]); } catch { return undefined; }
}

function pointerSize(snapshot: RuntimeSnapshot): 4 | 8 {
  const names = new Set(snapshot.registers.map((register) => register.name.toLowerCase()));
  return names.has('eip') && !names.has('rip') ? 4 : 8;
}

function decodeMemory(data: string | undefined): Buffer {
  if (!data) return Buffer.alloc(0);
  return Buffer.from(data.replace(/\s+/g, ''), 'base64');
}

async function reverseLifetime(session: GuardedDapSession, name: string, steps: number) {
  const events: Array<Record<string, unknown>> = [];
  let current = await session.runtimeSnapshot({ stackLevels: 10, maxVariablesPerScope: 80, includeDisassembly: false, includeModules: false, includeExceptionInfo: true });
  let prior = findObservedValue(current, name);
  for (let index = 0; index < steps; index += 1) {
    await session.stepBack(current.thread.id, true, 15_000);
    current = await session.runtimeSnapshot({ stackLevels: 10, maxVariablesPerScope: 80, includeDisassembly: false, includeModules: false, includeExceptionInfo: true });
    const observed = findObservedValue(current, name);
    events.push({
      index: index + 1,
      frame: current.frame,
      before: prior,
      after: observed,
      changed: Boolean(prior && observed && prior.value !== observed.value),
    });
    if (prior && observed && prior.value !== observed.value) break;
    prior = observed;
  }
  return events;
}

async function captureTimeline(session: GuardedDapSession, options: { samples: number; intervalMs: number; maxThreads: number; stackLevels: number; maxVariables: number }) {
  if (session.isPostmortem()) throw new DapError('Thread timeline sampling requires a live target.');
  return session.runExclusiveLifecycle('thread timeline', async () => {
    const observations: ReturnType<typeof classifyThreadObservation>[] = [];
    let stopReason: 'sample-budget' | 'target-exited' | 'target-terminated' | 'no-threads' = 'sample-budget';

    for (let sample = 1; sample <= options.samples; sample += 1) {
      const threads = (await session.threads()).slice(0, options.maxThreads);
      for (const thread of threads) {
        let stack: DebugProtocol.StackFrame[] = [];
        let variables: DebugProtocol.Variable[] = [];
        try {
          stack = await session.stackTrace(thread.id, 0, options.stackLevels);
          const frame = stack[0];
          if (frame) {
            const scopes = await session.scopes(frame.id);
            for (const scope of scopes.filter((candidate) => /locals?|arguments?|parameters?/i.test(candidate.name)).slice(0, 2)) {
              if (scope.variablesReference > 0) {
                variables.push(...await session.variables(scope.variablesReference, 0, options.maxVariables));
              }
            }
          }
        } catch {
          // Keep partial thread evidence; one broken stack/scope must not discard the entire process timeline.
        }
        observations.push(classifyThreadObservation(sample, thread, stack, variables));
      }

      if (sample === options.samples) break;
      const resumeThread = threads[0];
      if (!resumeThread) {
        stopReason = 'no-threads';
        break;
      }

      const eventCountBeforeResume = session.snapshot().recentEvents.length;
      await session.continueExecution(resumeThread.id, false, Math.max(5000, options.intervalMs * 4));
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs));

      const eventsAfterResume = session.snapshot().recentEvents.slice(eventCountBeforeResume);
      const terminal = [...eventsAfterResume].reverse().find((record) => {
        const event = (record as { event?: unknown }).event;
        return event === 'exited' || event === 'terminated';
      }) as { event?: 'exited' | 'terminated' } | undefined;
      if (terminal?.event === 'exited') {
        stopReason = 'target-exited';
        break;
      }
      if (terminal?.event === 'terminated') {
        stopReason = 'target-terminated';
        break;
      }

      try {
        await session.pause(resumeThread.id, true, Math.max(5000, options.intervalMs * 4));
      } catch (error) {
        const recent = session.snapshot().recentEvents.slice(eventCountBeforeResume);
        const lateTerminal = [...recent].reverse().find((record) => {
          const event = (record as { event?: unknown }).event;
          return event === 'exited' || event === 'terminated';
        }) as { event?: 'exited' | 'terminated' } | undefined;
        if (lateTerminal?.event === 'exited') {
          stopReason = 'target-exited';
          break;
        }
        if (lateTerminal?.event === 'terminated') {
          stopReason = 'target-terminated';
          break;
        }
        throw error;
      }
    }

    const lockGraph = buildLockOwnerGraph(observations);
    const byThread = new Map<number, typeof observations>();
    for (const observation of observations) {
      const bucket = byThread.get(observation.threadId) ?? [];
      bucket.push(observation);
      byThread.set(observation.threadId, bucket);
    }
    const progression = [...byThread.entries()].map(([threadId, entries]) => ({
      threadId,
      samples: entries.length,
      uniqueLocations: new Set(entries.map((entry) => [entry.topFrame, entry.source, entry.line, entry.instructionPointerReference].join('|'))).size,
      waitKinds: [...new Set(entries.map((entry) => entry.waitKind))],
    }));
    return {
      observations,
      progression,
      lockGraph,
      stopReason,
      completeSampleBudget: stopReason === 'sample-budget',
      status: session.snapshot(),
    };
  });
}

function installedAdapter(name: string, fn: () => unknown) {
  try { return { name, available: true, details: fn() }; }
  catch (error) { return { name, available: false, error: error instanceof Error ? error.message : String(error) }; }
}

export function registerRuntimeV2Tools(server: McpServer, session: GuardedDapSession): void {
  server.registerTool(
    'debug_time_travel',
    {
      title: 'Record and Time-Travel Debugging',
      description: 'Coordinate bounded record/replay debugging with rr and DAP reverse execution. Use doctor to inspect rr availability, record to execute one explicitly supplied program under rr, replay-plan to generate a loopback-only rr/GDB handoff, or reverse to move an already record/replay-capable DAP target backward. Do not use record on untrusted targets outside an isolation boundary or assume ordinary debuggers support reverse execution.',
      annotations: LOCAL_TARGET_EXECUTION_ANNOTATIONS,
      outputSchema: debugTimeTravelOutputSchema,
      inputSchema: z.object({
        action: z.enum(['doctor', 'record', 'replay-plan', 'replay-start', 'replay-status', 'replay-stop', 'reverse']).describe('Time-travel action: inspect rr, record, plan/start/status/stop a managed loopback replay, or issue DAP reverse execution.'),
        program: z.string().min(1).optional().describe('Executable used only for action=record.'),
        args: z.array(z.string()).max(128).optional().describe('Literal argv entries for rr record; arguments are passed without a shell.'),
        cwd: z.string().optional().describe('Optional working directory for rr record.'),
        env: z.record(z.string(), z.string()).optional().describe('Optional environment overrides for rr record.'),
        traceDir: z.string().min(1).optional().describe('New trace output path for record, or existing trace directory for replay-plan.'),
        rrPath: z.string().min(1).optional().describe('Optional explicit rr executable path; otherwise RR_PATH/PATH discovery is used.'),
        timeoutMs: z.number().int().min(1000).max(600000).default(120000).describe('Bound for rr record or reverse debugger wait operations.'),
        port: z.number().int().min(1).max(65535).default(50505).describe('Loopback TCP port used by replay-plan or managed replay-start.'),
        gdbAdapterPath: z.string().min(1).optional().describe('Optional explicit GDB executable for managed replay attach; omit to use normal GDB discovery.'),
        attachReplay: z.boolean().default(true).describe('For replay-start, initialize GDB DAP and attach it to the managed rr loopback endpoint after rr starts.'),
        disconnectDebugger: z.boolean().default(true).describe('For replay-stop, disconnect an attached GDB DAP session before terminating rr.'),
        requestTimeoutMs: z.number().int().min(1000).max(120000).default(30000).describe('DAP request timeout used when replay-start performs the optional GDB attach.'),
        reverseAction: z.enum(['reverseContinue', 'stepBack']).default('stepBack').describe('DAP reverse operation used only for action=reverse.'),
        threadId: z.number().int().positive().optional().describe('Stopped thread required for action=reverse.'),
      }),
    },
    async (args) => {
      try {
        if (args.action === 'doctor') return structuredResult({ action: 'doctor', rr: discoverRr({ ...(args.rrPath ? { explicitPath: args.rrPath } : {}) }), security: securityProfileSnapshot() });
        if (args.action === 'record') {
          if (!args.program) throw new DapError('debug_time_travel action=record requires program.');
          return structuredResult({ action: 'record' as const, ...recordWithRr({ program: args.program, args: args.args, cwd: args.cwd, env: args.env, traceDir: args.traceDir, timeoutMs: args.timeoutMs, rrPath: args.rrPath }) });
        }
        if (args.action === 'replay-plan') {
          if (!args.traceDir) throw new DapError('debug_time_travel action=replay-plan requires traceDir.');
          return structuredResult({
            action: 'replay-plan' as const,
            ...buildRrReplayPlan({
              traceDir: args.traceDir,
              port: args.port,
              ...(args.rrPath ? { rrPath: args.rrPath } : {}),
            }),
          });
        }
        const replay = replayManagerFor(session);
        if (args.action === 'replay-status') {
          return structuredResult({ action: 'replay-status', replay: replay.status(), status: session.snapshot() });
        }
        if (args.action === 'replay-stop') {
          if (args.disconnectDebugger && session.snapshot().adapterRunning && session.snapshot().adapterId === 'gdb') {
            await session.disconnect(false);
          }
          return structuredResult({ action: 'replay-stop', replay: await replay.stop(), status: session.snapshot() });
        }
        if (args.action === 'replay-start') {
          if (!args.traceDir) throw new DapError('debug_time_travel action=replay-start requires traceDir.');
          const replayStatus = await replay.start({
            traceDir: args.traceDir,
            port: args.port,
            ...(args.rrPath ? { rrPath: args.rrPath } : {}),
            readyTimeoutMs: Math.min(args.requestTimeoutMs, 15_000),
          });
          if (!args.attachReplay) {
            return structuredResult({ action: 'replay-start', replay: replayStatus, attached: false, status: session.snapshot() });
          }

          try {
            const adapter = discoverGdbDap({
              ...(args.gdbAdapterPath ? { explicitPath: args.gdbAdapterPath } : {}),
            });
            const capabilities = await session.start({
              command: adapter.command,
              args: adapter.args,
              adapterId: 'gdb',
              requestTimeoutMs: args.requestTimeoutMs,
            });
            const attach = await session.attach(buildGdbDapRemoteAttachConfiguration({
              host: '127.0.0.1',
              port: args.port,
              ...(args.program ? { program: args.program } : {}),
            }));
            return structuredResult({
              action: 'replay-start',
              replay: replay.status(),
              attached: true,
              adapter,
              capabilities,
              attach,
              status: session.snapshot(),
            });
          } catch (error) {
            await replay.stop();
            await session.reset().catch(() => undefined);
            throw error;
          }
        }
        if (!args.threadId) throw new DapError('debug_time_travel action=reverse requires threadId.');
        if (session.isPostmortem()) throw new DapError('Reverse execution requires a live record/replay-capable target.');
        const result = args.reverseAction === 'stepBack'
          ? await session.stepBack(args.threadId, true, Math.min(args.timeoutMs, 120000))
          : await session.reverseContinue(args.threadId, true, Math.min(args.timeoutMs, 120000));
        return structuredResult({ action: 'reverse', reverseAction: args.reverseAction, result, status: session.snapshot() });
      } catch (error) { return errorResult(error); }
    },
  );

  server.registerTool(
    'debug_trace_lifetime',
    {
      title: 'Trace Object Lifetime',
      description: 'Trace lifetime evidence for one debugger-visible pointer or object handle using the current snapshot, sanitizer/runtime output, bounded forward writer tracing, and optional reverse stepping when supported. Use this for suspected use-after-free, stale ownership, or unexpected pointer replacement. Do not use forward tracing on a frozen dump or when resuming the target is unsafe.',
      annotations: DEBUG_SESSION_CONTROL_ANNOTATIONS,
      outputSchema: debugLifetimeTraceOutputSchema,
      inputSchema: z.object({
        name: z.string().min(1).max(512).describe('Debugger-visible pointer/object expression whose lifetime should be investigated.'),
        direction: z.enum(['forward', 'reverse', 'hybrid']).default('forward').describe('Forward uses writer watchpoints, reverse uses stepBack, and hybrid collects both when supported.'),
        maxStops: z.number().int().min(1).max(16).default(6).describe('Maximum forward writer observations.'),
        reverseSteps: z.number().int().min(1).max(32).default(8).describe('Maximum reverse stepBack operations when reverse or hybrid is selected.'),
        timeoutMs: z.number().int().min(1000).max(120000).default(60000).describe('Aggregate bound for forward temporal tracing.'),
      }),
    },
    async (args) => {
      try {
        return structuredResult(await session.runExclusiveLifecycle('trace lifetime', async () => {
          const initial = await session.runtimeSnapshot({ stackLevels: 16, maxVariablesPerScope: 120, includeDisassembly: true, includeModules: true, includeExceptionInfo: true });
          const observed = findObservedValue(initial, args.name);
          const output = debuggerOutput(session);
          const sanitizer = parseSanitizerEvidence(output);
          const hazards = detectMemoryHazards(initial).filter((item) => item.variable === observed?.name || String(item.value ?? '') === observed?.value);
          const result: Record<string, unknown> = {
            query: args.name,
            initial: { frame: initial.frame, observed },
            sanitizer,
            memoryHazards: hazards,
            allocationDeallocationHints: output.filter((line) => /allocated by|freed by|operator delete|operator new|malloc|free\(/i.test(line)).slice(-40),
          };
          if ((args.direction === 'reverse' || args.direction === 'hybrid') && session.snapshot().capabilities?.supportsStepBack === true) {
            result.reverseTimeline = await reverseLifetime(session, args.name, args.reverseSteps);
          } else if (args.direction === 'reverse') {
            throw new DapError('The active adapter does not advertise supportsStepBack required for reverse lifetime tracing.');
          }
          if (args.direction === 'forward' || args.direction === 'hybrid') {
            if (session.isPostmortem()) throw new DapError('Forward lifetime tracing requires a live target.');
            result.forwardTimeline = await traceValue(session, { name: args.name, maxStops: args.maxStops, timeoutMs: args.timeoutMs, perStopTimeoutMs: 15000 });
          }
          result.guidance = [
            'A writer can propagate an already-stale pointer; continue toward allocation/deallocation evidence when a writer is not the lifetime origin.',
            'Sanitizer allocation/free stacks, when present, are stronger lifetime evidence than debug fill patterns alone.',
          ];
          return result;
        }));
      } catch (error) { return errorResult(error); }
    },
  );

  server.registerTool(
    'debug_thread_timeline',
    {
      title: 'Capture Multi-Thread Timeline',
      description: 'Capture bounded all-thread stack/variable samples across short resume-pause intervals, classify waits, measure per-thread execution movement, and build a conservative lock-owner graph only from explicit debugger-visible owner thread IDs. Use this for starvation, livelock, lock contention, and deadlock investigation. Do not use it when target resumption is unsafe because sampling perturbs scheduling.',
      annotations: DEBUG_SESSION_CONTROL_ANNOTATIONS,
      outputSchema: debugThreadTimelineOutputSchema,
      inputSchema: z.object({
        samples: z.number().int().min(2).max(8).default(4).describe('Number of process-wide samples to capture.'),
        intervalMs: z.number().int().min(25).max(5000).default(250).describe('Approximate live execution interval between samples.'),
        maxThreads: z.number().int().min(1).max(64).default(24).describe('Maximum threads inspected in each sample.'),
        stackLevels: z.number().int().min(1).max(32).default(8).describe('Maximum stack frames captured per sampled thread.'),
        maxVariables: z.number().int().min(1).max(100).default(24).describe('Maximum local/argument variables per sampled thread top frame.'),
      }),
    },
    async (args) => {
      try { return structuredResult(await captureTimeline(session, args)); } catch (error) { return errorResult(error); }
    },
  );

  server.registerTool(
    'debug_symbol_doctor',
    {
      title: 'Diagnose Symbols and Binary Identity',
      description: 'Diagnose missing or mismatched native debug symbols using current DAP module evidence, bounded local symbol-cache search, optional PE/PDB GUID-age comparison, ELF Build-ID or Mach-O UUID probing, and explicit configured symbol-server candidates. Use it before source-level root-cause claims when symbols are partial or suspicious. Do not use filename-only cache matches as proof of identity, and this tool never downloads remote symbols automatically.',
      annotations: READ_ONLY_LOCAL_TOOL_ANNOTATIONS,
      outputSchema: debugSymbolDoctorOutputSchema,
      inputSchema: z.object({
        program: z.string().min(1).optional().describe('Optional executable image for local PE/ELF/Mach-O identity probing.'),
        pdb: z.string().min(1).optional().describe('Optional PDB path for GUID/age comparison when llvm-pdbutil is locally available.'),
        searchPaths: z.array(z.string().min(1)).max(20).default([]).describe('Bounded local directories searched for matching symbol artifact filenames.'),
        maxEntries: z.number().int().min(1).max(10000).default(2000).describe('Maximum filesystem entries inspected across local symbol search paths.'),
        maxDepth: z.number().int().min(0).max(8).default(4).describe('Maximum local symbol-search directory recursion depth.'),
      }),
    },
    async (args) => {
      try {
        const snapshot = await session.runtimeSnapshot({ stackLevels: 24, maxVariablesPerScope: 40, includeDisassembly: false, includeModules: true, moduleCount: 300, includeExceptionInfo: false });
        const modules = snapshot.modules ?? [];
        const binaryIdentity = args.program ? inspectBinaryIdentity(args.program) : undefined;
        const pdbIdentity = args.pdb ? inspectPdbIdentity(args.pdb) : undefined;
        const localSearch = args.searchPaths.length ? findLocalSymbolCandidates(modules, args.searchPaths, { maxEntries: args.maxEntries, maxDepth: args.maxDepth }) : undefined;
        return structuredResult({
          symbolHealth: snapshot.symbolHealth,
          binaryIdentity,
          pdbIdentity,
          mismatch: symbolMismatchSummary({ modules, binaryIdentity, pdbIdentity, localSearch }),
          localSearch,
          resolver: configuredSymbolResolvers(binaryIdentity),
        });
      } catch (error) { return errorResult(error); }
    },
  );

  server.registerTool(
    'debug_dump_batch',
    {
      title: 'Analyze Crash Dump Batch',
      description: 'Open a bounded set of native dump/core files from one local directory through the existing hardened postmortem adapter flow, generate runtime reports for each, and cluster them with v2 crash families. Use it for recurring crash fleets and support bundles. Do not use it on untrusted enormous directories or assume one family fingerprint proves one root cause.',
      annotations: READ_ONLY_LOCAL_TOOL_ANNOTATIONS,
      outputSchema: debugDumpBatchOutputSchema,
      inputSchema: z.object({
        directory: z.string().min(1).describe('Local directory containing native dump/core files.'),
        program: z.string().min(1).optional().describe('Optional matching executable image reused for each dump.'),
        adapter: z.enum(['codelldb', 'lldb-dap', 'gdb']).default('codelldb').describe('Postmortem debugger adapter used for every selected dump.'),
        adapterPath: z.string().min(1).optional().describe('Optional explicit debugger adapter path.'),
        maxDumps: z.number().int().min(1).max(50).default(20).describe('Maximum dump files analyzed from the directory.'),
        namePattern: z.string().max(200).optional().describe('Optional case-insensitive substring required in selected dump filenames.'),
      }),
    },
    async (args) => {
      try {
        return structuredResult(await session.runExclusiveLifecycle('dump batch', async () => {
          const directory = resolveExistingDirectory(args.directory, 'Crash dump batch directory');
          const candidates = readdirSync(directory, { withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name)
            .filter((name) => /(?:\.dmp|\.mdmp|\.core|\.dump|^core(?:\.|$))/i.test(name))
            .filter((name) => !args.namePattern || name.toLowerCase().includes(args.namePattern.toLowerCase()))
            .sort()
            .slice(0, args.maxDumps);
          const reports: Array<Record<string, unknown>> = [];
          const errors: Array<Record<string, unknown>> = [];
          for (const name of candidates) {
            const dumpPath = join(directory, name);
            try {
              const opened = await openDump(session, { dumpPath, program: args.program, adapter: args.adapter as DumpAdapterKind, adapterPath: args.adapterPath, includeModules: true, includeDisassembly: true });
              const report = buildCrashReport(opened.snapshot, session.snapshot(), { redactPaths: true, includeOutputTail: true });
              reports.push({ label: name, ...report });
            } catch (error) {
              errors.push({ dump: name, error: error instanceof Error ? error.message : String(error) });
            } finally {
              await session.reset();
            }
          }
          return {
            directory,
            selected: candidates,
            analyzed: reports.length,
            failed: errors.length,
            reports,
            errors,
            families: compareCrashFamilies(reports as any),
          };
        }));
      } catch (error) { return errorResult(error); }
    },
  );

  server.registerTool(
    'debug_adaptive_evidence',
    {
      title: 'Collect Adaptive Runtime Evidence',
      description: 'Collect runtime evidence in progressively richer bounded phases instead of immediately requesting a maximal snapshot. Use it when token/DAP cost matters or the amount of evidence needed is unknown: it starts with stack and small locals, expands only when symbols, exception state, or variables are insufficient, and finishes with a full runtime report when needed. Do not use it to replace deliberate deep inspection when the required evidence is already known.',
      annotations: READ_ONLY_LOCAL_TOOL_ANNOTATIONS,
      outputSchema: debugAdaptiveEvidenceOutputSchema,
      inputSchema: z.object({
        forceFull: z.boolean().default(false).describe('Force the full evidence phase even if the cheap snapshot already looks sufficient.'),
        maxVariables: z.number().int().min(10).max(200).default(80).describe('Maximum locals/registers per scope in the richest phase.'),
      }),
    },
    async (args) => {
      try {
        const cheap = await session.runtimeSnapshot({ stackLevels: 6, maxVariablesPerScope: 16, includeDisassembly: false, includeModules: false, includeExceptionInfo: true });
        const reasons: string[] = [];
        if (cheap.symbolHealth.status !== 'good') reasons.push('symbol-health-not-good');
        if (!cheap.exception && (cheap.stopped as { reason?: unknown } | undefined)?.reason === 'exception') reasons.push('exception-info-missing');
        if (cheap.locals.length === 0) reasons.push('no-locals');
        const needMore = args.forceFull || reasons.length > 0;
        if (!needMore) {
          return structuredResult({
            selectedPhase: 'cheap',
            expansionReasons: [],
            evidenceBudget: { stackLevels: 6, maxVariablesPerScope: 16, modules: false, disassembly: false },
            snapshot: cheap,
          });
        }
        const medium = await session.runtimeSnapshot({ stackLevels: 16, maxVariablesPerScope: Math.min(args.maxVariables, 60), includeDisassembly: true, includeModules: false, includeExceptionInfo: true });
        const needFull = args.forceFull || medium.symbolHealth.status !== 'good' || medium.collectionErrors?.length || medium.locals.length === 0;
        if (!needFull) {
          return structuredResult({
            selectedPhase: 'medium',
            expansionReasons: reasons,
            evidenceBudget: { stackLevels: 16, maxVariablesPerScope: Math.min(args.maxVariables, 60), modules: false, disassembly: true },
            snapshot: medium,
          });
        }
        const full = await session.runtimeSnapshot({ stackLevels: 32, maxVariablesPerScope: args.maxVariables, includeDisassembly: true, includeModules: true, moduleCount: 200, includeExceptionInfo: true });
        return structuredResult({
          selectedPhase: 'full',
          expansionReasons: [...reasons, 'medium-evidence-remained-incomplete'],
          evidenceBudget: { stackLevels: 32, maxVariablesPerScope: args.maxVariables, modules: true, disassembly: true },
          report: buildCrashReport(full, session.snapshot(), { redactPaths: true, includeOutputTail: true }),
        });
      } catch (error) { return errorResult(error); }
    },
  );

  server.registerTool(
    'debug_crash_families',
    {
      title: 'Compare Crash Families',
      description: 'Compare supplied runtime reports using exact, semantic, and broad family fingerprints so superficially different crashes can be grouped while retaining concrete variants. Use it after debug_runtime_report or debug_dump_batch has produced v2 fingerprints. Do not use shared family membership as proof of one root cause; it is a triage relationship.',
      annotations: READ_ONLY_LOCAL_TOOL_ANNOTATIONS,
      outputSchema: debugCrashFamiliesOutputSchema,
      inputSchema: z.object({
        reports: z.array(z.object({
          label: z.string().optional(),
          fingerprint: z.string().optional(),
          fingerprintsV2: z.object({ exact: z.string().optional(), semantic: z.string().optional(), family: z.string().optional() }).catchall(z.unknown()).optional(),
          exceptionKey: z.string().optional(),
          frameKey: z.string().optional(),
        }).catchall(z.unknown())).min(1).max(500).describe('Previously produced runtime report identities to group into v2 crash families.'),
      }),
    },
    async ({ reports }) => structuredResult(compareCrashFamilies(reports as any)),
  );

  server.registerTool(
    'debug_cpp_object',
    {
      title: 'Inspect C++ Object and VTable',
      description: 'Read a bounded object header from a debugger-visible pointer, decode the probable first-word vtable pointer, correlate it with loaded modules, and return surrounding bytes plus ABI context. Use it for suspected stale C++ objects, invalid virtual dispatch, or overwritten object headers. Do not use a first-word pointer as proven vtable evidence without module/symbol/source corroboration, and this tool never writes target memory.',
      annotations: READ_ONLY_LOCAL_TOOL_ANNOTATIONS,
      outputSchema: debugCppObjectOutputSchema,
      inputSchema: z.object({
        pointer: z.string().min(1).optional().describe('Literal pointer/memory reference such as 0x1234; omit when name identifies a debugger-visible local/register.'),
        name: z.string().min(1).optional().describe('Debugger-visible local/register whose value contains the object pointer.'),
        bytes: z.number().int().min(8).max(256).default(64).describe('Bounded object-header byte count read from target memory.'),
      }),
    },
    async (args) => {
      try {
        const snapshot = await session.runtimeSnapshot({ stackLevels: 16, maxVariablesPerScope: 100, includeDisassembly: true, includeModules: true, moduleCount: 300, includeExceptionInfo: true });
        const observed = args.name ? findObservedValue(snapshot, args.name) : undefined;
        const pointerText = args.pointer ?? observed?.value;
        if (!pointerText) throw new DapError('debug_cpp_object requires pointer or a name that resolves to an exact local/register.');
        const address = parsePointer(pointerText);
        if (address === undefined || address === 0n) throw new DapError('Object pointer must resolve to a non-zero hexadecimal address.');
        const memory = await session.readMemory(pointerText, args.bytes, 0);
        const raw = decodeMemory(memory.data);
        const size = pointerSize(snapshot);
        const vtable = raw.length >= size ? (size === 8 ? raw.readBigUInt64LE(0) : BigInt(raw.readUInt32LE(0))) : undefined;
        const vtableRef = vtable === undefined ? undefined : '0x' + vtable.toString(16);
        const module = moduleForAddress(snapshot.modules, vtableRef);
        return structuredResult({
          pointer: pointerText,
          observed,
          pointerSize: size,
          bytesRead: raw.length,
          hex: raw.toString('hex').match(/.{1,2}/g)?.join(' ') ?? '',
          probableVtable: vtableRef,
          vtableModule: module,
          abi: analyzeAbiArguments(snapshot),
          hazards: detectMemoryHazards(snapshot),
          guidance: 'A module-backed first-word pointer is consistent with a vtable but remains heuristic until symbol/source evidence identifies the dynamic type.',
        });
      } catch (error) { return errorResult(error); }
    },
  );

  server.registerTool(
    'debug_evidence_bundle',
    {
      title: 'Export or Import Debug Evidence',
      description: 'Export bounded structured debugger evidence as JSON, Markdown, or SARIF, or import a JSON/SARIF bundle for offline analysis after the original process is gone. Use it for reproducible bug reports, CI handoff, or evidence replay between sessions. Do not use imported evidence as if it were live state, and exports refuse accidental overwrite by default.',
      annotations: LOCAL_ARTIFACT_WRITE_ANNOTATIONS,
      outputSchema: debugEvidenceBundleOutputSchema,
      inputSchema: z.object({
        action: z.enum(['export', 'import']).describe('Export supplied structured evidence to a local artifact or import a bounded JSON/SARIF artifact for offline use.'),
        path: z.string().min(1).describe('Local evidence file path to create or read.'),
        evidence: z.unknown().optional().describe('Structured evidence required only for export; typically a debug_runtime_report, debug_dump_batch member, or adaptive report.'),
        format: z.enum(['json', 'markdown', 'sarif']).default('json').describe('Export representation; import accepts structured JSON/SARIF regardless of this value.'),
        overwrite: z.boolean().default(false).describe('Allow replacing an existing regular file during export; symbolic-link targets are always rejected.'),
      }),
    },
    async (args) => {
      try {
        if (args.action === 'import') return structuredResult(importEvidenceBundle(args.path));
        if (args.evidence === undefined) throw new DapError('debug_evidence_bundle action=export requires evidence.');
        return structuredResult(exportEvidenceBundle({ path: args.path, evidence: args.evidence, format: args.format, overwrite: args.overwrite }));
      } catch (error) { return errorResult(error); }
    },
  );

  server.registerTool(
    'debug_adapter_doctor',
    {
      title: 'Audit Debugger Adapter Capabilities',
      description: 'Audit the active DAP session and locally installed debugger adapters, report capability support relevant to qwen-dap-mcp workflows, inspect the resolved security profile, and identify missing prerequisites such as rr. Use it during setup or when an agent workflow is unexpectedly unavailable. Do not use adapter discovery as permission to attach to or execute arbitrary targets.',
      annotations: READ_ONLY_LOCAL_TOOL_ANNOTATIONS,
      outputSchema: debugAdapterDoctorOutputSchema,
      inputSchema: z.object({
        mode: z.enum(['current', 'installed', 'all']).default('all').describe('Audit the current initialized DAP session, local adapter installations, or both.'),
      }),
    },
    async ({ mode }) => {
      const result: Record<string, unknown> = { security: securityProfileSnapshot() };
      if (mode === 'current' || mode === 'all') {
        const status = session.snapshot();
        const capabilities = status.capabilities ?? {};
        result.current = {
          status,
          capabilityMatrix: {
            modules: capabilities.supportsModulesRequest === true,
            disassembly: capabilities.supportsDisassembleRequest === true,
            memoryRead: capabilities.supportsReadMemoryRequest === true,
            exceptionInfo: capabilities.supportsExceptionInfoRequest === true,
            dataBreakpoints: capabilities.supportsDataBreakpoints === true,
            reverseExecution: capabilities.supportsStepBack === true,
            functionBreakpoints: capabilities.supportsFunctionBreakpoints === true,
            instructionBreakpoints: capabilities.supportsInstructionBreakpoints === true,
          },
        };
      }
      if (mode === 'installed' || mode === 'all') {
        result.installed = [
          installedAdapter('CodeLLDB', () => discoverCodeLldb()),
          installedAdapter('lldb-dap', () => discoverLldbDap()),
          installedAdapter('GDB DAP', () => discoverGdbDap()),
          installedAdapter('rr', () => discoverRr()),
        ];
      }
      return structuredResult(result);
    },
  );
}