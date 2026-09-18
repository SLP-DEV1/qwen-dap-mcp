import { createHash } from 'node:crypto';
import type { DebugProtocol } from '@vscode/debugprotocol';

import type { RuntimeSnapshot } from '../dap/session.js';

export type EvidenceItem = {
  kind: string;
  weight: number;
  summary: string;
  source: string;
};

export type FailureHypothesis = {
  id: string;
  title: string;
  evidenceScore: number;
  supporting: EvidenceItem[];
  contradicting: EvidenceItem[];
  nextEvidence: string[];
};

export type ThreadTimelineObservation = {
  sample: number;
  threadId: number;
  threadName: string;
  topFrame?: string;
  source?: string;
  line?: number;
  instructionPointerReference?: string;
  waitKind: 'lock' | 'join' | 'condition' | 'io' | 'sleep' | 'runnable-or-unknown';
  resources: Array<{
    name: string;
    value: string;
    ownerThreadId?: number;
    ownerEvidence?: string;
  }>;
};

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeFunctionName(name: string): string {
  return name
    .replace(/\+0x[0-9a-f]+$/i, '')
    .replace(/\s+at\s+0x[0-9a-f]+$/i, '')
    .replace(/<[^<>]{0,120}>/g, '<T>')
    .trim()
    .toLowerCase();
}

function sourceIdentity(frame: DebugProtocol.StackFrame): string {
  const path = frame.source?.path;
  const basename = path ? (path.split(/[\\/]/).pop() ?? path) : frame.source?.name ?? '';
  return basename.toLowerCase();
}

function exceptionText(snapshot: RuntimeSnapshot): string {
  const exception = snapshot.exception as { exceptionId?: unknown; description?: unknown; details?: { message?: unknown } } | undefined;
  const stopped = snapshot.stopped as { reason?: unknown; description?: unknown; text?: unknown } | undefined;
  return [
    exception?.exceptionId,
    exception?.description,
    exception?.details?.message,
    stopped?.reason,
    stopped?.description,
    stopped?.text,
  ].filter((value): value is string => typeof value === 'string').join(' ').toLowerCase();
}

function classifyException(text: string): string {
  if (/use-after-free/.test(text)) return 'use-after-free';
  if (/heap-buffer-overflow|buffer overflow|out.of.bounds/.test(text)) return 'buffer-overflow';
  if (/stack-buffer-overflow|stack smashing|security cookie|stack overflow/.test(text)) return 'stack-failure';
  if (/divide|sigfpe|integer divide/.test(text)) return 'divide-by-zero-or-fpe';
  if (/illegal instruction|sigill/.test(text)) return 'illegal-instruction';
  if (/access violation|sigsegv|segmentation|exc_bad_access/.test(text)) return 'invalid-memory-access';
  if (/abort|assert|sigabrt/.test(text)) return 'abort-or-assert';
  if (/data race|threadsanitizer/.test(text)) return 'data-race';
  return text ? 'exception-or-signal' : 'unknown-stop';
}

function variableHazards(snapshot: RuntimeSnapshot): string[] {
  const hazards = new Set<string>();
  const patterns: Array<[RegExp, string]> = [
    [/feeefeee/i, 'freed-heap-pattern'],
    [/dddddddd/i, 'freed-debug-heap-pattern'],
    [/cdcdcdcd|cccccccc|baadf00d/i, 'uninitialized-pattern'],
    [/deadbeef|fdfdfdfd/i, 'poison-or-guard-pattern'],
  ];
  for (const variable of [...snapshot.locals, ...snapshot.registers]) {
    const value = variable.value ?? '';
    for (const [pattern, kind] of patterns) {
      if (pattern.test(value)) hazards.add(kind);
    }
    if (/^(?:0x)?0+$/i.test(value.trim()) && /\*|ptr|pointer/i.test(variable.type ?? variable.name)) {
      hazards.add('null-like-pointer');
    }
  }
  return [...hazards].sort();
}

function sanitizerKinds(lines: readonly string[]): string[] {
  const joined = lines.join('\n').toLowerCase();
  const kinds = new Set<string>();
  if (joined.includes('addresssanitizer')) kinds.add('asan');
  if (joined.includes('threadsanitizer')) kinds.add('tsan');
  if (joined.includes('undefinedbehaviorsanitizer') || joined.includes('runtime error:')) kinds.add('ubsan');
  if (joined.includes('leaksanitizer')) kinds.add('lsan');
  if (joined.includes('use-after-free')) kinds.add('use-after-free');
  if (joined.includes('heap-buffer-overflow')) kinds.add('heap-buffer-overflow');
  if (joined.includes('stack-buffer-overflow')) kinds.add('stack-buffer-overflow');
  if (joined.includes('data race')) kinds.add('data-race');
  return [...kinds].sort();
}

export function crashFingerprintsV2(snapshot: RuntimeSnapshot, outputLines: readonly string[] = []) {
  const exceptionClass = classifyException(exceptionText(snapshot));
  const hazards = variableHazards(snapshot);
  const sanitizers = sanitizerKinds(outputLines);

  const exactMaterial = {
    version: 2,
    exception: exceptionText(snapshot),
    frames: snapshot.stack.slice(0, 8).map((frame) => ({
      function: normalizeFunctionName(frame.name),
      source: sourceIdentity(frame),
      line: frame.line,
    })),
    hazards,
    sanitizers,
  };
  const semanticMaterial = {
    version: 2,
    exceptionClass,
    frames: snapshot.stack.slice(0, 6).map((frame) => normalizeFunctionName(frame.name)),
    hazards,
    sanitizers,
  };
  const familyMaterial = {
    version: 2,
    exceptionClass,
    topFunctions: snapshot.stack.slice(0, 3).map((frame) => normalizeFunctionName(frame.name)),
    memoryFamily: hazards.filter((kind) => !kind.includes('uninitialized')).sort(),
    sanitizerFamilies: sanitizers.filter((kind) => /asan|tsan|ubsan|use-after|overflow|race/.test(kind)),
  };

  return {
    version: 2,
    exact: digest(exactMaterial),
    semantic: digest(semanticMaterial),
    family: digest(familyMaterial),
    materials: {
      exact: exactMaterial,
      semantic: semanticMaterial,
      family: familyMaterial,
    },
    note: 'exact keeps source lines, semantic suppresses path/address noise, and family intentionally collapses nearby failures into broader runtime families.',
  };
}

function parseAddress(value: string | undefined): bigint | undefined {
  if (!value) return undefined;
  const match = value.replace(/\`/g, '').match(/0x([0-9a-f]+)/i);
  if (!match) return undefined;
  try { return BigInt(`0x${match[1]}`); } catch { return undefined; }
}

function parseModuleRange(range: string | undefined): { start: bigint; end: bigint } | undefined {
  if (!range) return undefined;
  const matches = [...range.replace(/\`/g, '').matchAll(/0x([0-9a-f]+)/ig)];
  if (matches.length < 2) return undefined;
  try {
    const start = BigInt(`0x${matches[0]![1]}`);
    const end = BigInt(`0x${matches[1]![1]}`);
    if (end <= start) return undefined;
    return { start, end };
  } catch {
    return undefined;
  }
}

export function moduleForAddress(modules: readonly DebugProtocol.Module[] | undefined, address: string | undefined) {
  const target = parseAddress(address);
  if (target === undefined || !modules?.length) return undefined;
  for (const module of modules) {
    const range = parseModuleRange(module.addressRange);
    if (range && target >= range.start && target < range.end) return module;
  }
  return undefined;
}

export function analyzeStackIntegrity(snapshot: RuntimeSnapshot, outputLines: readonly string[] = []) {
  const findings: Array<Record<string, unknown>> = [];
  const modules = snapshot.modules;
  let outsideKnownModules = 0;
  const seenIps = new Map<string, number>();

  for (const [index, frame] of snapshot.stack.entries()) {
    const ip = frame.instructionPointerReference;
    if (ip) seenIps.set(ip, (seenIps.get(ip) ?? 0) + 1);
    if (modules?.length && ip && !moduleForAddress(modules, ip)) {
      outsideKnownModules += 1;
      findings.push({
        kind: 'instruction-pointer-outside-known-modules',
        frame: index,
        function: frame.name,
        instructionPointerReference: ip,
        confidence: 'medium',
      });
    }
  }

  const repeated = [...seenIps.entries()].filter(([, count]) => count >= 4);
  if (repeated.length) {
    findings.push({
      kind: 'highly-repeated-return-or-instruction-address',
      addresses: repeated,
      confidence: 'low',
      note: 'Repeated frames can also be legitimate recursion or unwinding artifacts.',
    });
  }

  const registerMap = new Map(snapshot.registers.map((register) => [register.name.toLowerCase(), register.value]));
  const spName = registerMap.has('rsp') ? 'rsp' : registerMap.has('sp') ? 'sp' : undefined;
  const sp = spName ? parseAddress(registerMap.get(spName)) : undefined;
  if (sp !== undefined && sp % 16n !== 0n) {
    findings.push({
      kind: 'non-16-byte-aligned-stack-pointer',
      register: spName,
      value: registerMap.get(spName!),
      confidence: 'low',
      note: 'A debugger stop can occur at a point where platform call-site alignment rules do not directly apply.',
    });
  }

  const output = outputLines.join('\n');
  if (/stack smashing detected|__stack_chk_fail|security cookie|stack buffer overrun/i.test(output)) {
    findings.push({
      kind: 'runtime-stack-protector-evidence',
      confidence: 'high',
      source: 'debugger-output',
    });
  }

  const severity = findings.some((finding) => finding.confidence === 'high')
    ? 'high'
    : outsideKnownModules >= 2
      ? 'medium'
      : findings.length
        ? 'low'
        : 'none';

  return {
    severity,
    findings,
    limitations: [
      'Generic DAP exposes stack frames after debugger unwinding; corrupted stacks can prevent or distort unwinding itself.',
      'Module range availability varies by adapter, so absence of an out-of-module finding is not proof that return addresses are valid.',
    ],
  };
}

const API_SIGNATURES: Array<{
  match: RegExp;
  name: string;
  params: string[];
  riskChecks: Array<{ index: number; kind: string }>;
}> = [
  { match: /(?:^|::)memcpy(?:$|\()/i, name: 'memcpy', params: ['destination', 'source', 'size'], riskChecks: [{ index: 0, kind: 'null-destination' }, { index: 1, kind: 'null-source' }] },
  { match: /(?:^|::)memmove(?:$|\()/i, name: 'memmove', params: ['destination', 'source', 'size'], riskChecks: [{ index: 0, kind: 'null-destination' }, { index: 1, kind: 'null-source' }] },
  { match: /(?:^|::)memset(?:$|\()/i, name: 'memset', params: ['destination', 'value', 'size'], riskChecks: [{ index: 0, kind: 'null-destination' }] },
  { match: /(?:^|::)strlen(?:$|\()/i, name: 'strlen', params: ['string'], riskChecks: [{ index: 0, kind: 'null-string' }] },
  { match: /(?:^|::)(?:free|operator delete)(?:$|\()/i, name: 'free/delete', params: ['pointer'], riskChecks: [] },
  { match: /pthread_mutex_lock/i, name: 'pthread_mutex_lock', params: ['mutex'], riskChecks: [{ index: 0, kind: 'null-mutex' }] },
  { match: /WaitForSingleObject/i, name: 'WaitForSingleObject', params: ['handle', 'milliseconds'], riskChecks: [{ index: 0, kind: 'null-or-invalid-handle' }] },
  { match: /(?:^|::)read(?:$|\()/i, name: 'read', params: ['fd', 'buffer', 'count'], riskChecks: [{ index: 1, kind: 'null-buffer' }] },
  { match: /(?:^|::)write(?:$|\()/i, name: 'write', params: ['fd', 'buffer', 'count'], riskChecks: [{ index: 1, kind: 'null-buffer' }] },
];

export function analyzeKnownApiCall(
  snapshot: RuntimeSnapshot,
  abiArguments: Array<{ index: number; register: string; value?: string }>,
) {
  const signature = API_SIGNATURES.find((candidate) => candidate.match.test(snapshot.frame.name));
  if (!signature) {
    return {
      recognized: false,
      function: snapshot.frame.name,
      note: 'Top frame is not in the bounded known native API signature catalog.',
    };
  }

  const argumentsMapped = signature.params.map((parameter, index) => {
    const carrier = abiArguments[index];
    return {
      parameter,
      index: index + 1,
      register: carrier?.register,
      value: carrier?.value,
    };
  });
  const risks = signature.riskChecks.flatMap((check) => {
    const arg = argumentsMapped[check.index];
    if (!arg?.value || !/^(?:0x)?0+$/i.test(arg.value.trim())) return [];
    return [{ kind: check.kind, parameter: arg.parameter, value: arg.value, confidence: 'medium' }];
  });

  return {
    recognized: true,
    function: signature.name,
    arguments: argumentsMapped,
    risks,
    note: 'Argument carriers follow the selected ABI; semantic validity still depends on the exact call site and target platform.',
  };
}

function evidence(kind: string, weight: number, summary: string, source: string): EvidenceItem {
  return { kind, weight, summary, source };
}

function score(items: EvidenceItem[], contradictions: EvidenceItem[]): number {
  const value = items.reduce((sum, item) => sum + item.weight, 0)
    - contradictions.reduce((sum, item) => sum + item.weight, 0);
  return Math.max(0, Math.min(100, value));
}

export function buildFailureHypotheses(options: {
  snapshot: RuntimeSnapshot;
  outputLines?: readonly string[];
  memoryHazards?: Array<Record<string, unknown>>;
  apiAnalysis?: Record<string, unknown>;
  stackIntegrity?: ReturnType<typeof analyzeStackIntegrity>;
}): FailureHypothesis[] {
  const outputLines = options.outputLines ?? [];
  const text = `${exceptionText(options.snapshot)}\n${outputLines.join('\n').toLowerCase()}`;
  const hazardKinds = new Set((options.memoryHazards ?? []).map((item) => String(item.kind ?? '')));
  const stackIntegrity = options.stackIntegrity ?? analyzeStackIntegrity(options.snapshot, outputLines);
  const hypotheses: FailureHypothesis[] = [];

  const add = (
    id: string,
    title: string,
    supporting: EvidenceItem[],
    contradicting: EvidenceItem[],
    nextEvidence: string[],
  ) => {
    if (!supporting.length) return;
    hypotheses.push({ id, title, evidenceScore: score(supporting, contradicting), supporting, contradicting, nextEvidence });
  };

  const nullSupport: EvidenceItem[] = [];
  if (hazardKinds.has('null-like-pointer')) nullSupport.push(evidence('null-like-pointer', 25, 'Debugger-visible pointer-like state is null.', 'runtime'));
  if (/access violation|sigsegv|segmentation|exc_bad_access/.test(text)) nullSupport.push(evidence('invalid-memory-access', 15, 'Stop is an invalid-memory-access family failure.', 'exception'));
  const apiRisks = Array.isArray((options.apiAnalysis as { risks?: unknown[] } | undefined)?.risks)
    ? (options.apiAnalysis as { risks: Array<{ kind?: unknown }> }).risks
    : [];
  if (apiRisks.some((risk) => /null/.test(String(risk.kind)))) nullSupport.push(evidence('null-api-argument', 35, 'Known native API received a null-like risky argument carrier.', 'abi-api'));
  add('null-dereference', 'Null or invalid pointer dereference', nullSupport, [], [
    'Correlate the faulting memory operand with the null-like register/local.',
    'Trace the pointer writer or inspect its initialization path.',
  ]);

  const uafSupport: EvidenceItem[] = [];
  if (/use-after-free/.test(text)) uafSupport.push(evidence('sanitizer-uaf', 70, 'Sanitizer/runtime output reports use-after-free.', 'sanitizer'));
  if ([...hazardKinds].some((kind) => /freed/.test(kind))) uafSupport.push(evidence('freed-pattern', 30, 'Pointer/value contains a common freed-memory debug fill pattern.', 'runtime'));
  add('use-after-free', 'Use-after-free / stale object lifetime', uafSupport, [], [
    'Trace object lifetime and the last deallocation/release site.',
    'Compare allocation/free stack evidence when sanitizer provenance is available.',
  ]);

  const overflowSupport: EvidenceItem[] = [];
  if (/heap-buffer-overflow|stack-buffer-overflow|buffer overflow/.test(text)) overflowSupport.push(evidence('sanitizer-overflow', 75, 'Runtime/sanitizer output reports a buffer overflow.', 'sanitizer'));
  if (hazardKinds.has('poison-or-guard-pattern')) overflowSupport.push(evidence('guard-pattern', 20, 'A guard/poison pattern is visible in runtime state.', 'runtime'));
  add('buffer-overflow', 'Buffer overwrite / out-of-bounds access', overflowSupport, [], [
    'Inspect the size/index operands at the earliest overwrite site.',
    'Use writer tracing on the corrupted field or adjacent guard value.',
  ]);

  const stackSupport: EvidenceItem[] = [];
  if (stackIntegrity.severity === 'high') stackSupport.push(evidence('stack-protector', 70, 'Stack protector or strong stack-integrity evidence is present.', 'stack-integrity'));
  else if (stackIntegrity.severity === 'medium') stackSupport.push(evidence('stack-anomaly', 35, 'Multiple stack/unwind anomalies are present.', 'stack-integrity'));
  add('stack-corruption', 'Stack corruption / smashed return state', stackSupport, [], [
    'Inspect writes to local buffers and saved return-state vicinity.',
    'Avoid patching only the final fault instruction; corruption may have happened much earlier.',
  ]);

  const raceSupport: EvidenceItem[] = [];
  if (/threadsanitizer|data race/.test(text)) raceSupport.push(evidence('tsan-race', 80, 'ThreadSanitizer/runtime output reports a data race.', 'sanitizer'));
  add('data-race', 'Data race / synchronization defect', raceSupport, [], [
    'Capture a multi-thread timeline around the conflicting accesses.',
    'Inspect lock ownership and synchronization around the reported addresses.',
  ]);

  const fpeSupport: EvidenceItem[] = [];
  if (/sigfpe|divide|integer divide/.test(text)) fpeSupport.push(evidence('fpe', 70, 'Exception text indicates divide/FPE failure.', 'exception'));
  add('divide-by-zero', 'Divide-by-zero / arithmetic exception', fpeSupport, [], [
    'Inspect the divisor register/local at the faulting instruction.',
    'Trace the divisor producer when zero is unexpected.',
  ]);

  return hypotheses.sort((a, b) => b.evidenceScore - a.evidenceScore);
}

export function buildBreakpointPlan(hypotheses: readonly FailureHypothesis[], snapshot: RuntimeSnapshot) {
  const functions = new Set<string>();
  const reasons: Array<{ function: string; reason: string; hypothesis: string }> = [];
  const add = (name: string, reason: string, hypothesis: string) => {
    if (!functions.has(name)) {
      functions.add(name);
      reasons.push({ function: name, reason, hypothesis });
    }
  };

  for (const hypothesis of hypotheses.slice(0, 4)) {
    if (hypothesis.id === 'use-after-free') {
      for (const name of ['free', 'operator delete', 'operator delete[]']) add(name, 'Observe deallocation paths for the suspect object.', hypothesis.id);
    }
    if (hypothesis.id === 'buffer-overflow') {
      for (const name of ['memcpy', 'memmove', 'memset']) add(name, 'Observe common bulk-memory writers near the corruption.', hypothesis.id);
    }
    if (hypothesis.id === 'data-race') {
      for (const name of ['pthread_mutex_lock', 'pthread_mutex_unlock']) add(name, 'Observe synchronization boundaries around the race.', hypothesis.id);
    }
  }
  for (const frame of snapshot.stack.slice(1, 5)) {
    if (frame.name && !/^(?:\?\?|unknown|<unknown>)/i.test(frame.name)) {
      add(frame.name, 'Project/runtime caller near the observed failure.', 'call-chain');
    }
  }

  return {
    functionBreakpoints: reasons.slice(0, 16),
    dataBreakpointCandidates: snapshot.locals
      .filter((variable) => /\*|ptr|pointer/i.test(variable.type ?? variable.name))
      .slice(0, 8)
      .map((variable) => ({
        name: variable.evaluateName ?? variable.name,
        value: variable.value,
        reason: 'Pointer-like local is a candidate for bounded writer/lifetime tracing.',
      })),
    note: 'This is a breakpoint plan only. Installation remains an explicit debugger-control action so the user/agent can review side effects and scope.',
  };
}

function parseOwnerThreadId(name: string, value: string): number | undefined {
  if (!/(?:owner|owning).*(?:thread|tid)|(?:thread|tid).*owner/i.test(name)) return undefined;
  const match = value.match(/\b(\d{1,10})\b/);
  if (!match) return undefined;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export function classifyThreadObservation(
  sample: number,
  thread: DebugProtocol.Thread,
  stack: readonly DebugProtocol.StackFrame[],
  variables: readonly DebugProtocol.Variable[],
): ThreadTimelineObservation {
  const top = stack[0];
  const stackText = stack.slice(0, 6).map((frame) => frame.name).join(' ').toLowerCase();
  const waitKind: ThreadTimelineObservation['waitKind'] =
    /mutex|criticalsection|srwlock|futex|lock|semaphore/.test(stackText) ? 'lock'
      : /join|waitforthread|pthread_join/.test(stackText) ? 'join'
        : /condition|cond_wait|event|waitforsingleobject/.test(stackText) ? 'condition'
          : /recv|send|readfile|writefile|epoll|poll|select|kevent/.test(stackText) ? 'io'
            : /sleep|nanosleep|usleep|delay/.test(stackText) ? 'sleep'
              : 'runnable-or-unknown';

  const explicitOwners = variables
    .map((variable) => ({ variable, ownerThreadId: parseOwnerThreadId(variable.name, variable.value) }))
    .filter((entry): entry is { variable: DebugProtocol.Variable; ownerThreadId: number } => entry.ownerThreadId !== undefined);
  const resources = variables
    .filter((variable) => /mutex|lock|critical|semaphore|event|futex/i.test(variable.name))
    .slice(0, 8)
    .map((variable) => {
      const owner = explicitOwners.find((entry) => entry.variable.name.toLowerCase().includes(variable.name.toLowerCase())
        || variable.name.toLowerCase().includes(entry.variable.name.toLowerCase().replace(/owner|thread|tid/gi, '')));
      return {
        name: variable.name,
        value: variable.value,
        ...(owner ? { ownerThreadId: owner.ownerThreadId, ownerEvidence: `${owner.variable.name}=${owner.variable.value}` } : {}),
      };
    });

  return {
    sample,
    threadId: thread.id,
    threadName: thread.name,
    ...(top ? { topFrame: top.name, source: top.source?.path ?? top.source?.name, line: top.line, instructionPointerReference: top.instructionPointerReference } : {}),
    waitKind,
    resources,
  };
}

function detectCycle(edges: Array<{ from: number; to: number; resource: string; evidence: string }>) {
  const adjacency = new Map<number, typeof edges>();
  for (const edge of edges) {
    const bucket = adjacency.get(edge.from) ?? [];
    bucket.push(edge);
    adjacency.set(edge.from, bucket);
  }

  for (const start of adjacency.keys()) {
    const path: typeof edges = [];
    const visiting = new Set<number>();
    const walk = (node: number): typeof edges | undefined => {
      if (visiting.has(node)) {
        const cycleStart = path.findIndex((edge) => edge.from === node);
        return cycleStart >= 0 ? path.slice(cycleStart) : [...path];
      }
      visiting.add(node);
      for (const edge of adjacency.get(node) ?? []) {
        path.push(edge);
        const found = walk(edge.to);
        if (found) return found;
        path.pop();
      }
      visiting.delete(node);
      return undefined;
    };
    const found = walk(start);
    if (found?.length) return found;
  }
  return undefined;
}

export function buildLockOwnerGraph(observations: readonly ThreadTimelineObservation[]) {
  const latestByThread = new Map<number, ThreadTimelineObservation>();
  for (const observation of observations) latestByThread.set(observation.threadId, observation);

  const edges = [...latestByThread.values()].flatMap((observation) =>
    observation.resources.flatMap((resource) => resource.ownerThreadId && resource.ownerThreadId !== observation.threadId
      ? [{
          from: observation.threadId,
          to: resource.ownerThreadId,
          resource: resource.name,
          evidence: resource.ownerEvidence ?? `${resource.name}=${resource.value}`,
        }]
      : []),
  );
  const cycle = detectCycle(edges);
  return {
    edges,
    cycleProven: Boolean(cycle?.length),
    cycle: cycle ?? [],
    evidenceKind: edges.length ? 'explicit-debugger-variable-owner-ids' : 'no-portable-owner-evidence',
    limitations: [
      'A proven cycle is emitted only when debugger-visible variables explicitly identify owner thread IDs.',
      'Generic DAP does not expose a standard lock-owner graph; missing edges must not be interpreted as absence of contention or deadlock.',
    ],
  };
}

export function compareCrashFamilies(reports: Array<{
  label?: string;
  fingerprintsV2?: { exact?: string; semantic?: string; family?: string; materials?: Record<string, unknown> };
  fingerprint?: string;
  exceptionKey?: string;
  frameKey?: string;
}>) {
  const byFamily = new Map<string, typeof reports>();
  for (const report of reports) {
    const key = report.fingerprintsV2?.family ?? report.fingerprint ?? 'unknown';
    const bucket = byFamily.get(key) ?? [];
    bucket.push(report);
    byFamily.set(key, bucket);
  }
  const families = [...byFamily.entries()].map(([family, members]) => ({
    family,
    count: members.length,
    semanticVariants: [...new Set(members.map((member) => member.fingerprintsV2?.semantic ?? member.fingerprint ?? 'unknown'))].length,
    exactVariants: [...new Set(members.map((member) => member.fingerprintsV2?.exact ?? member.fingerprint ?? 'unknown'))].length,
    members: members.map((member) => member.label ?? member.fingerprintsV2?.exact ?? member.fingerprint ?? 'unknown'),
    representative: members[0],
  })).sort((a, b) => b.count - a.count);

  return {
    totalReports: reports.length,
    families,
    sharedFamilyCount: families.filter((family) => family.count > 1).length,
    note: 'Family equality is a triage relationship, not proof of one root cause. Semantic/exact variants show how much concrete failure state differs inside each family.',
  };
}
