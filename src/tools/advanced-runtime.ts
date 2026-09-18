import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { RuntimeSnapshot } from '../dap/session.js';
import { GuardedDapSession } from '../dap/guarded-session.js';
import { traceValue, findObservedValue } from './value-tracing.js';
import {
  DEBUG_SESSION_CONTROL_ANNOTATIONS,
  READ_ONLY_LOCAL_TOOL_ANNOTATIONS,
} from './tool-annotations.js';
import {
  debugAdvancedOutputSchema,
  structuredResult,
} from './agent-output.js';

type AbiKind = 'auto' | 'windows-x64' | 'sysv-amd64' | 'aarch64';

type CrashReport = {
  fingerprint: string;
  frameKey: string;
  exceptionKey: string;
  symbolStatus: string;
  sanitizer: Array<Record<string, unknown>>;
  memoryHazards: Array<Record<string, unknown>>;
  abi: Record<string, unknown>;
  symbolDoctor: Record<string, unknown>;
  outputTail: string[];
  snapshot: RuntimeSnapshot;
  limitations: string[];
};

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function normalizeHex(value: string): string {
  return value.trim().toLowerCase().replace(/\`/g, '');
}

function variableMap(snapshot: RuntimeSnapshot): Map<string, string> {
  const map = new Map<string, string>();
  for (const variable of [...snapshot.registers, ...snapshot.locals]) {
    map.set(variable.name.trim().toLowerCase(), variable.value);
    if (variable.evaluateName) map.set(variable.evaluateName.trim().toLowerCase(), variable.value);
  }
  return map;
}

function resolveAbi(snapshot: RuntimeSnapshot, requested: AbiKind): Exclude<AbiKind, 'auto'> | 'unknown' {
  if (requested !== 'auto') return requested;
  const names = new Set(snapshot.registers.map((register) => register.name.toLowerCase()));
  if (names.has('x0') || names.has('x1')) return 'aarch64';
  if (names.has('rcx') && names.has('rdx') && names.has('r8') && names.has('r9')) {
    return process.platform === 'win32' ? 'windows-x64' : 'sysv-amd64';
  }
  return 'unknown';
}

export function analyzeAbiArguments(snapshot: RuntimeSnapshot, requested: AbiKind = 'auto') {
  const abi = resolveAbi(snapshot, requested);
  const values = variableMap(snapshot);
  const registerOrder =
    abi === 'windows-x64' ? ['rcx', 'rdx', 'r8', 'r9']
      : abi === 'sysv-amd64' ? ['rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9']
        : abi === 'aarch64' ? ['x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7']
          : [];

  return {
    abi,
    frame: snapshot.frame.name,
    arguments: registerOrder.map((register, index) => ({
      index: index + 1,
      register,
      value: values.get(register),
    })),
    note: registerOrder.length
      ? 'Register-to-argument mapping follows the selected platform ABI. It identifies call-site argument carriers, not high-level parameter names or ownership semantics.'
      : 'The active snapshot did not expose enough recognizable registers to infer a supported ABI.',
  };
}

const POISON_PATTERNS = new Map([
  ['0xfeeefeee', 'freed-heap-pattern'],
  ['0xdddddddd', 'freed-debug-heap-pattern'],
  ['0xcdcdcdcd', 'uninitialized-heap-pattern'],
  ['0xcccccccc', 'uninitialized-stack-pattern'],
  ['0xdeadbeef', 'poison-sentinel'],
  ['0xbaadf00d', 'uninitialized-heap-pattern'],
  ['0xfdfdfdfd', 'heap-guard-pattern'],
]);

export function detectMemoryHazards(snapshot: RuntimeSnapshot) {
  const findings: Array<Record<string, unknown>> = [];
  for (const variable of [...snapshot.locals, ...snapshot.registers]) {
    const normalized = normalizeHex(variable.value);
    for (const [pattern, kind] of POISON_PATTERNS) {
      if (!normalized.includes(pattern.slice(2))) continue;
      findings.push({
        kind,
        variable: variable.name,
        value: variable.value,
        type: variable.type,
        confidence: 'medium',
        note: 'A poison/debug fill pattern is evidence of suspicious lifetime or initialization state, not standalone proof of memory corruption.',
      });
    }
    if (/^(?:0x)?0+$/.test(normalized) && /\*|ptr|pointer/i.test(variable.type ?? variable.name)) {
      findings.push({
        kind: 'null-like-pointer',
        variable: variable.name,
        value: variable.value,
        type: variable.type,
        confidence: 'low',
        note: 'Null-like pointer state becomes causal evidence only when correlated with a dereferencing instruction or API argument.',
      });
    }
  }
  return findings.slice(0, 100);
}

export function parseSanitizerEvidence(lines: readonly string[]) {
  const findings: Array<Record<string, unknown>> = [];
  const joined = lines.join('\n');
  const patterns: Array<[RegExp, string]> = [
    [/AddressSanitizer:\s*([^\n]+)/i, 'asan'],
    [/ERROR:\s*AddressSanitizer:\s*([^\n]+)/i, 'asan'],
    [/UndefinedBehaviorSanitizer|runtime error:\s*([^\n]+)/i, 'ubsan'],
    [/ThreadSanitizer:\s*([^\n]+)/i, 'tsan'],
    [/LeakSanitizer:\s*([^\n]+)/i, 'lsan'],
  ];
  for (const [pattern, sanitizer] of patterns) {
    const match = pattern.exec(joined);
    if (!match) continue;
    findings.push({
      sanitizer,
      summary: (match[1] ?? match[0]).trim().slice(0, 500),
      evidenceSource: 'adapter-stderr',
    });
  }
  return findings;
}

function stableFrameKey(snapshot: RuntimeSnapshot): string {
  const frames = snapshot.stack.slice(0, 6).map((frame) => {
    const source = frame.source?.path ?? frame.source?.name ?? '';
    return `${frame.name}|${source}|${frame.line}`;
  });
  return frames.join('>');
}

function exceptionKey(snapshot: RuntimeSnapshot): string {
  const exception = snapshot.exception as { exceptionId?: unknown; description?: unknown } | undefined;
  return [
    typeof exception?.exceptionId === 'string' ? exception.exceptionId : '',
    typeof exception?.description === 'string' ? exception.description : '',
    (snapshot.stopped as { reason?: unknown } | undefined)?.reason ?? '',
  ].join('|');
}

function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const byte of Buffer.from(input, 'utf8')) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, '0');
}

export function buildCrashReport(
  snapshot: RuntimeSnapshot,
  status: ReturnType<GuardedDapSession['snapshot']>,
  options: { redactPaths?: boolean; includeOutputTail?: boolean; abi?: AbiKind } = {},
): CrashReport {
  const rawFrameKey = stableFrameKey(snapshot);
  const rawExceptionKey = exceptionKey(snapshot);
  const dapOutput = options.includeOutputTail === false ? [] : status.recentEvents
    .filter((record) => (record as { event?: unknown }).event === 'output')
    .map((record) => {
      const body = (record as { body?: { output?: unknown } }).body;
      return typeof body?.output === 'string' ? body.output.trim() : '';
    })
    .filter(Boolean);
  const outputTail = options.includeOutputTail === false
    ? []
    : [...status.recentAdapterStderr.slice(-30), ...dapOutput.slice(-30)].slice(-60);
  const sanitizer = parseSanitizerEvidence(outputTail);
  const memoryHazards = detectMemoryHazards(snapshot);
  const abi = analyzeAbiArguments(snapshot, options.abi ?? 'auto');
  const symbolDoctor = {
    status: snapshot.symbolHealth.status,
    summary: snapshot.symbolHealth.summary,
    stack: snapshot.symbolHealth.stack,
    modules: snapshot.symbolHealth.modules,
    limitations: snapshot.symbolHealth.limitations,
    nextActions: snapshot.symbolHealth.status === 'good'
      ? []
      : [
          'Verify that debug symbols match the exact executable/module build being inspected.',
          'Check source-map/source-path configuration when frames have symbols but no source locations.',
          'Prefer a symbol-complete representative reproduction before making source-level causal claims.',
        ],
  };
  const fingerprint = fnv1a64(`${rawExceptionKey}\n${rawFrameKey}`);
  const redactedFrameKey = options.redactPaths
    ? rawFrameKey.replace(/([A-Za-z]:)?[\\/][^|>]+/g, '<path>')
    : rawFrameKey;

  return {
    fingerprint,
    frameKey: redactedFrameKey,
    exceptionKey: rawExceptionKey,
    symbolStatus: snapshot.symbolHealth.status,
    sanitizer,
    memoryHazards,
    abi,
    symbolDoctor,
    outputTail,
    snapshot,
    limitations: [
      'The fingerprint intentionally normalizes around exception identity and top stack frames; it is a triage key, not a cryptographic crash identity.',
      'Sanitizer correlation only uses debugger-visible adapter stderr captured by this process.',
      'Heap poison patterns and ABI mappings are heuristic evidence and must be correlated with source and instruction behavior.',
    ],
  };
}

function sampleSignature(snapshot: RuntimeSnapshot) {
  return {
    threadId: snapshot.thread.id,
    frame: snapshot.frame.name,
    source: snapshot.frame.source?.path ?? snapshot.frame.source?.name,
    line: snapshot.frame.line,
    instruction: snapshot.frame.instructionPointerReference,
  };
}

export async function progressProbe(
  session: GuardedDapSession,
  options: { samples?: number; intervalMs?: number; threadId?: number },
) {
  return session.runExclusiveLifecycle('progress probe', async () => {
  if (session.isPostmortem()) throw new Error('debug_progress_probe requires a live target; frozen dumps cannot demonstrate forward progress.');
  const samples = options.samples ?? 4;
  const intervalMs = options.intervalMs ?? 250;
  const captures: Array<{ index: number; signature: ReturnType<typeof sampleSignature>; topFrames: Array<{ name: string; source?: string; line: number }> }> = [];

  for (let index = 0; index < samples; index += 1) {
    const snapshot = await session.runtimeSnapshot({
      ...(options.threadId ? { threadId: options.threadId } : {}),
      stackLevels: 8,
      maxVariablesPerScope: 20,
      includeDisassembly: false,
      includeModules: false,
      includeExceptionInfo: false,
    });
    captures.push({
      index: index + 1,
      signature: sampleSignature(snapshot),
      topFrames: snapshot.stack.slice(0, 5).map((frame) => ({
        name: frame.name,
        ...(frame.source?.path || frame.source?.name ? { source: frame.source?.path ?? frame.source?.name } : {}),
        line: frame.line,
      })),
    });
    if (index === samples - 1) break;

    await session.continueExecution(snapshot.thread.id, false, Math.max(1000, intervalMs * 4));
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const threads = await session.threads();
    const preferred = threads.find((thread) => thread.id === snapshot.thread.id) ?? threads[0];
    if (!preferred) throw new Error('Target exposed no thread to pause during progress probing.');
    await session.pause(preferred.id, true, Math.max(1000, intervalMs * 4));
  }

  const keys = captures.map(({ signature }) => JSON.stringify(signature));
  const unique = new Set(keys);
  const sameFrame = new Set(captures.map(({ signature }) => `${signature.frame}|${signature.source ?? ''}|${signature.line}`)).size === 1;
  const instructionValues = captures.map(({ signature }) => signature.instruction).filter(Boolean);
  const uniqueInstructions = new Set(instructionValues);

  let classification = 'forward-progress-observed';
  if (unique.size === 1) classification = 'no-observed-progress';
  else if (sameFrame && instructionValues.length >= 2 && uniqueInstructions.size <= 3) classification = 'probable-busy-loop';
  else if (sameFrame) classification = 'same-frame-progress';

  return {
    classification,
    samples,
    intervalMs,
    captures,
    evidence: {
      uniqueSampleSignatures: unique.size,
      sameSourceFrameAcrossSamples: sameFrame,
      uniqueInstructionPointers: uniqueInstructions.size,
    },
    limitations: [
      'Sampling perturbs scheduling because the debugger resumes and pauses the target.',
      'Repeated program counters are consistent with a spin/busy loop but do not prove lack of useful work.',
      'Observed movement between samples demonstrates execution movement, not necessarily application-level progress.',
    ],
    status: session.snapshot(),
  };

  });
}

export async function causalTrace(
  session: GuardedDapSession,
  options: { name: string; maxDepth?: number; maxStops?: number; timeoutMs?: number },
) {
  return session.runExclusiveLifecycle('causal trace', async () => {
  const initial = await session.runtimeSnapshot({
    stackLevels: 16,
    maxVariablesPerScope: 120,
    includeDisassembly: true,
    includeModules: false,
    includeExceptionInfo: true,
  });
  const observed = findObservedValue(initial, options.name);
  const timeline = await traceValue(session, {
    name: options.name,
    maxStops: Math.min(options.maxStops ?? 8, 16),
    timeoutMs: options.timeoutMs ?? 60_000,
    perStopTimeoutMs: 15_000,
  });
  const depth = Math.min(options.maxDepth ?? 4, timeline.events.length);
  const chain = timeline.events.slice(0, depth).map((event, index) => ({
    depth: index + 1,
    writerFrame: event.writerFrame,
    beforeValue: event.beforeValue,
    afterValue: event.afterValue,
    valueChanged: event.valueChanged,
    evidence: event.writerCorrelation,
  }));
  return {
    query: { name: options.name, maxDepth: options.maxDepth ?? 4 },
    consumer: {
      frame: initial.frame,
      observedValue: observed,
      disassembly: initial.disassembly,
    },
    producerChain: chain,
    trace: timeline,
    conclusion: chain.length
      ? 'Observed writer stops form a bounded temporal producer chain. Treat the chain as causal evidence to inspect, not automatic root-cause proof.'
      : 'No confirmed writer chain was captured within the configured evidence budget.',
    limitations: [
      'Watchpoints observe runtime writes after the starting stop; they do not travel backward through already-executed history.',
      'A writer may merely propagate an already-invalid value. Continue source/lifetime analysis when the first writer is not the origin.',
    ],
  };

  });
}

export function clusterCrashReports(reports: Array<{ fingerprint: string; frameKey?: string; exceptionKey?: string }>) {
  const clusters = new Map<string, typeof reports>();
  for (const report of reports) {
    const bucket = clusters.get(report.fingerprint) ?? [];
    bucket.push(report);
    clusters.set(report.fingerprint, bucket);
  }
  return {
    totalReports: reports.length,
    clusters: [...clusters.entries()]
      .map(([fingerprint, entries]) => ({
        fingerprint,
        count: entries.length,
        representative: entries[0],
      }))
      .sort((a, b) => b.count - a.count),
    note: 'Clustering uses qwen-dap-mcp normalized crash fingerprints. Re-open representative dumps when deeper semantic confirmation is needed.',
  };
}

export function regressionOracle(currentFingerprint: string, baselineFingerprint: string, terminal = true) {
  const verdict = !terminal
    ? 'inconclusive'
    : currentFingerprint === baselineFingerprint
      ? 'original-crash'
      : 'changed-crash';
  return {
    verdict,
    baselineFingerprint,
    currentFingerprint,
    terminal,
    suitableForBisect: terminal,
    note: terminal
      ? 'A changed fingerprint means the original failure signature changed; it does not by itself prove the revision is good.'
      : 'Only a complete terminal reproduction should be used as a strong bisect oracle.',
  };
}

export function registerAdvancedRuntimeTools(server: McpServer, session: GuardedDapSession): void {
  server.registerTool(
    'debug_causal_trace',
    {
      title: 'Trace Runtime Causality',
      description: 'Build a bounded consumer-to-writer evidence chain for one suspicious debugger-visible value. Use it after crash or differential evidence identifies a value whose runtime producers matter. It combines the current stopped snapshot with repeated watchpoint writer tracing. Do not use it for frozen dumps or unsafe-to-resume targets, and do not treat an observed writer as automatic proof of root cause.',
      annotations: DEBUG_SESSION_CONTROL_ANNOTATIONS,
      outputSchema: debugAdvancedOutputSchema,
      inputSchema: z.object({
        name: z.string().min(1).max(512).describe('Debugger-visible variable or expression whose producer chain should be traced.'),
        maxDepth: z.number().int().min(1).max(8).default(4).describe('Maximum number of confirmed writer events promoted into the causal producer chain.'),
        maxStops: z.number().int().min(1).max(16).default(8).describe('Maximum watchpoint stops available to the underlying bounded temporal trace.'),
        timeoutMs: z.number().int().min(1000).max(120_000).default(60_000).describe('Aggregate deadline for the entire causal trace operation.'),
      }),
    },
    async (args) => {
      try { return structuredResult(await causalTrace(session, args)); } catch (error) { return errorResult(error); }
    },
  );

  server.registerTool(
    'debug_progress_probe',
    {
      title: 'Probe Runtime Progress',
      description: 'Sample a live target across short resume/pause intervals to distinguish no observed progress, same-frame execution movement, and probable busy loops. Use it when a process appears hung but a single thread snapshot cannot distinguish blocking from spinning. Do not use it when resuming the target is unsafe; sampling perturbs scheduling and is not proof of application-level progress.',
      annotations: DEBUG_SESSION_CONTROL_ANNOTATIONS,
      outputSchema: debugAdvancedOutputSchema,
      inputSchema: z.object({
        samples: z.number().int().min(2).max(8).default(4).describe('Number of stopped runtime samples to collect across resume/pause intervals.'),
        intervalMs: z.number().int().min(25).max(5000).default(250).describe('Approximate execution interval between debugger samples.'),
        threadId: z.number().int().positive().optional().describe('Preferred thread to sample; omit to follow the debugger-selected stopped thread.'),
      }),
    },
    async (args) => {
      try { return structuredResult(await progressProbe(session, args)); } catch (error) { return errorResult(error); }
    },
  );

  server.registerTool(
    'debug_reverse_execution',
    {
      title: 'Reverse Debugger Execution',
      description: 'Move a stopped live target backward using DAP reverseContinue or stepBack when the active adapter advertises reverse-execution support. Use it with record/replay-capable debuggers to inspect state before a failure without waiting for a future writer. Do not use it on ordinary adapters that lack supportsStepBack, on frozen dumps, or as a substitute for reproducible verification.',
      annotations: DEBUG_SESSION_CONTROL_ANNOTATIONS,
      outputSchema: debugAdvancedOutputSchema,
      inputSchema: z.object({
        action: z.enum(['reverseContinue', 'stepBack']).describe('Reverse execution operation to request from the active DAP adapter.'),
        threadId: z.number().int().positive().describe('Stopped DAP thread identifier that should be moved backward.'),
        waitForStop: z.boolean().default(true).describe('Wait for the next stopped event after the reverse request before returning.'),
        timeoutMs: z.number().int().min(1000).max(120_000).default(15_000).describe('Maximum time to wait for the reverse operation and resulting stopped event.'),
      }),
    },
    async ({ action, threadId, waitForStop, timeoutMs }) => {
      try {
        if (session.isPostmortem()) throw new Error('debug_reverse_execution requires a live record/replay-capable target.');
        const result = action === 'stepBack'
          ? await session.stepBack(threadId, waitForStop, timeoutMs)
          : await session.reverseContinue(threadId, waitForStop, timeoutMs);
        return structuredResult({ action, result, status: session.snapshot() });
      } catch (error) { return errorResult(error); }
    },
  );

  server.registerTool(
    'debug_runtime_report',
    {
      title: 'Build Runtime Debug Report',
      description: 'Create a shareable structured report from the current stopped target with normalized crash fingerprinting, Symbol Doctor status, sanitizer stderr correlation, poison-pattern memory hazard detection, ABI register-to-argument mapping, and recent debugger output. Use it only for evidence-driven triage and issue handoff. Do not treat heuristic poison patterns, ABI mappings, or sanitizer text correlation as standalone proof.',
      annotations: READ_ONLY_LOCAL_TOOL_ANNOTATIONS,
      outputSchema: debugAdvancedOutputSchema,
      inputSchema: z.object({
        redactPaths: z.boolean().default(true).describe('Replace path-like portions of the report fingerprint frame key with a generic marker.'),
        includeOutputTail: z.boolean().default(true).describe('Include the bounded recent adapter stderr tail used for sanitizer correlation.'),
        abi: z.enum(['auto', 'windows-x64', 'sysv-amd64', 'aarch64']).default('auto').describe('ABI used to map argument registers; auto infers from debugger registers and host platform when possible.'),
      }),
    },
    async (args) => {
      try {
        const snapshot = await session.runtimeSnapshot({ stackLevels: 24, maxVariablesPerScope: 150, includeDisassembly: true, includeModules: true, includeExceptionInfo: true });
        return structuredResult(buildCrashReport(snapshot, session.snapshot(), args));
      } catch (error) { return errorResult(error); }
    },
  );

  server.registerTool(
    'debug_cluster_crashes',
    {
      title: 'Cluster Crash Reports',
      description: 'Group multiple previously produced qwen-dap-mcp runtime reports by their normalized crash fingerprint. Use it after opening and reporting several dumps or reproductions to identify dominant failure families without comparing unstable raw addresses. This tool only clusters supplied report identities; do not use cluster membership as proof that every crash has the same root cause.',
      annotations: READ_ONLY_LOCAL_TOOL_ANNOTATIONS,
      outputSchema: debugAdvancedOutputSchema,
      inputSchema: z.object({
        reports: z.array(z.object({
          fingerprint: z.string().min(1),
          frameKey: z.string().optional(),
          exceptionKey: z.string().optional(),
        })).min(1).max(500).describe('Runtime-report identities to cluster; typically copy fingerprint/frameKey/exceptionKey from debug_runtime_report results.'),
      }),
    },
    async ({ reports }) => structuredResult(clusterCrashReports(reports)),
  );

  server.registerTool(
    'debug_child_requests',
    {
      title: 'Inspect Child Debug Requests',
      description: 'Inspect bounded DAP reverse requests such as startDebugging emitted by an adapter when a child, fork, worker, or subprocess wants a debugger session. Use it to discover child-debug opportunities without silently granting adapter-controlled process execution. This tool is read-only: qwen-dap-mcp continues to reject reverse requests by default, so do not expect it to auto-launch child sessions.',
      annotations: READ_ONLY_LOCAL_TOOL_ANNOTATIONS,
      outputSchema: debugAdvancedOutputSchema,
      inputSchema: z.object({
        command: z.string().min(1).optional().describe('Optional reverse-request command filter, for example startDebugging; omit to return the bounded recent history.'),
      }),
    },
    async ({ command }) => {
      const requests = session.connection.recentReverseRequests
        .filter((request) => !command || request.command === command)
        .slice(-50);
      return structuredResult({
        requests,
        autoAccepted: false,
        policy: 'fail-closed',
        guidance: [
          'startDebugging requests are captured for visibility but still rejected by the DAP transport.',
          'Create and authorize a separate debugger session explicitly before taking control of a child target.',
        ],
      });
    },
  );

  server.registerTool(
    'debug_regression_oracle',
    {
      title: 'Classify Regression Reproduction',
      description: 'Classify a completed reproduction against an original crash fingerprint for git-bisect-style workflows. Use it only after debug_runtime_report or crash verification has produced stable fingerprints. It reports original-crash, changed-crash, or inconclusive; it intentionally does not label a changed crash as good, because a different downstream failure can still be a regression.',
      annotations: READ_ONLY_LOCAL_TOOL_ANNOTATIONS,
      outputSchema: debugAdvancedOutputSchema,
      inputSchema: z.object({
        baselineFingerprint: z.string().min(1).describe('Fingerprint of the original failure being tracked through the regression search.'),
        currentFingerprint: z.string().min(1).describe('Fingerprint produced by the current reproduction or runtime report.'),
        terminal: z.boolean().default(true).describe('Whether the reproduction reached a complete terminal crash/exit state rather than an early debugger stop.'),
      }),
    },
    async ({ baselineFingerprint, currentFingerprint, terminal }) =>
      structuredResult(regressionOracle(currentFingerprint, baselineFingerprint, terminal)),
  );
}
