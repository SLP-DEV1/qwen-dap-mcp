import type { DebugProtocol } from '@vscode/debugprotocol';

import type { RuntimeSnapshot } from '../dap/session.js';

export type DiagnosisConfidence = 'high' | 'medium' | 'low';

export type DiagnosisCategory =
  | 'access-violation'
  | 'segmentation-fault'
  | 'stack-overflow'
  | 'divide-by-zero'
  | 'illegal-instruction'
  | 'abort-or-assert'
  | 'heap-corruption'
  | 'exception'
  | 'signal'
  | 'breakpoint'
  | 'entry'
  | 'manual-stop'
  | 'step'
  | 'unknown';

export type SuspiciousValue = {
  scope: 'local' | 'register';
  name: string;
  value: string;
  type?: string;
  reason: 'null-like-pointer' | 'poison-pattern';
};

export type SourceDisassemblyCorrelation = {
  frame: {
    name: string;
    moduleId?: number | string;
  };
  source?: {
    name?: string;
    path?: string;
    line: number;
    column: number;
  };
  instructionPointerReference?: string;
  exactInstructionMatch: boolean;
  currentInstruction?: DebugProtocol.DisassembledInstruction;
  previousInstructions: DebugProtocol.DisassembledInstruction[];
  nextInstructions: DebugProtocol.DisassembledInstruction[];
};

export type DiagnosisHypothesis = {
  kind: string;
  title: string;
  confidence: DiagnosisConfidence;
  evidence: string[];
  suggestedChecks: string[];
};

export type CrashDiagnosis = {
  summary: string;
  classification: {
    category: DiagnosisCategory;
    crashLikely: boolean;
    confidence: DiagnosisConfidence;
  };
  stopReason?: string;
  exception?: DebugProtocol.ExceptionInfoResponse['body'];
  faultLocation: {
    function: string;
    moduleId?: number | string;
    sourcePath?: string;
    sourceName?: string;
    line: number;
    column: number;
    instructionPointerReference?: string;
  };
  sourceDisassembly: SourceDisassemblyCorrelation;
  suspiciousValues: SuspiciousValue[];
  hypotheses: DiagnosisHypothesis[];
  nextActions: string[];
};

const POISON_PATTERNS = [
  '0xcccccccc',
  '0xcdcdcdcd',
  '0xdddddddd',
  '0xfeeefeee',
  '0xfdfdfdfd',
  '0xdeadbeef',
  '0xbaadf00d',
];

function collectText(value: unknown, output: string[] = [], depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) return output;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    output.push(String(value));
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) collectText(item, output, depth + 1);
    return output;
  }
  if (typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>).slice(0, 30)) {
      collectText(nested, output, depth + 1);
    }
  }
  return output;
}

function diagnosticText(snapshot: RuntimeSnapshot): string {
  const stopped = snapshot.stopped as DebugProtocol.StoppedEvent['body'] | undefined;
  return [
    stopped?.reason,
    stopped?.description,
    stopped?.text,
    ...collectText(snapshot.exception),
  ].filter((value): value is string => Boolean(value)).join(' ').toLowerCase();
}

function exceptionFatality(snapshot: RuntimeSnapshot): boolean | undefined {
  const mode = snapshot.exception?.breakMode;
  if (mode === 'unhandled' || mode === 'userUnhandled') return true;
  // `always` commonly means the debugger was configured to stop on every
  // throw/first-chance exception. It is evidence of an exception, not proof
  // that the process would have crashed if execution continued.
  if (mode === 'always' || mode === 'never') return false;
  return undefined;
}

function crashClassification(
  category: DiagnosisCategory,
  defaultConfidence: DiagnosisConfidence,
  fatality: boolean | undefined,
): CrashDiagnosis['classification'] {
  return {
    category,
    crashLikely: fatality !== false,
    confidence: fatality === false ? 'medium' : defaultConfidence,
  };
}

function classify(snapshot: RuntimeSnapshot): CrashDiagnosis['classification'] {
  const stopped = snapshot.stopped as DebugProtocol.StoppedEvent['body'] | undefined;
  const text = diagnosticText(snapshot);
  const fatality = stopped?.reason === 'exception' ? exceptionFatality(snapshot) : undefined;

  if (/access violation|exc_bad_access/.test(text)) {
    return crashClassification('access-violation', 'high', fatality);
  }
  if (/segmentation fault|sigsegv/.test(text)) {
    return crashClassification('segmentation-fault', 'high', fatality);
  }
  if (/stack overflow|stackoverflow|sigstkflt/.test(text)) {
    return crashClassification('stack-overflow', 'high', fatality);
  }
  if (/divide by zero|division by zero|integer divide|sigfpe/.test(text)) {
    return crashClassification('divide-by-zero', 'high', fatality);
  }
  if (/illegal instruction|sigill/.test(text)) {
    return crashClassification('illegal-instruction', 'high', fatality);
  }
  if (/heap corruption|double free|invalid free|use[- ]after[- ]free/.test(text)) {
    return crashClassification('heap-corruption', 'high', fatality);
  }
  if (/sigabrt|\babort\b|assertion failed|\bassert\b/.test(text)) {
    return crashClassification('abort-or-assert', 'high', fatality);
  }

  switch (stopped?.reason) {
    case 'exception':
      return {
        category: 'exception',
        crashLikely: fatality === true,
        confidence: fatality === undefined ? 'low' : snapshot.exception ? 'high' : 'medium',
      };
    case 'breakpoint':
      return { category: 'breakpoint', crashLikely: false, confidence: 'high' };
    case 'entry':
      return { category: 'entry', crashLikely: false, confidence: 'high' };
    case 'pause':
      return { category: 'manual-stop', crashLikely: false, confidence: 'high' };
    case 'step':
      return { category: 'step', crashLikely: false, confidence: 'high' };
    case 'signal':
      return { category: 'signal', crashLikely: true, confidence: 'medium' };
    default:
      return { category: 'unknown', crashLikely: false, confidence: 'low' };
  }
}

function parseAddress(value: string | undefined): bigint | undefined {
  if (!value) return undefined;
  const compact = value.trim().replace(/[`'_\s]/g, '');
  const match = /^0x([0-9a-f]+)$/i.exec(compact);
  if (!match?.[1]) return undefined;
  try {
    return BigInt(`0x${match[1]}`);
  } catch {
    return undefined;
  }
}

export function correlateSourceDisassembly(snapshot: RuntimeSnapshot): SourceDisassemblyCorrelation {
  const instructions = snapshot.disassembly ?? [];
  const ip = snapshot.frame.instructionPointerReference;
  const ipAddress = parseAddress(ip);
  let currentIndex = instructions.findIndex((instruction) => instruction.address.toLowerCase() === ip?.toLowerCase());

  if (currentIndex < 0 && ipAddress !== undefined && instructions.length > 0) {
    let nearestDistance: bigint | undefined;
    for (let index = 0; index < instructions.length; index += 1) {
      const address = parseAddress(instructions[index]?.address);
      if (address === undefined) continue;
      const distance = address >= ipAddress ? address - ipAddress : ipAddress - address;
      if (nearestDistance === undefined || distance < nearestDistance) {
        nearestDistance = distance;
        currentIndex = index;
      }
    }
  }

  const source = snapshot.frame.source;
  return {
    frame: {
      name: snapshot.frame.name,
      ...(snapshot.frame.moduleId === undefined ? {} : { moduleId: snapshot.frame.moduleId }),
    },
    ...(source
      ? {
          source: {
            ...(source.name ? { name: source.name } : {}),
            ...(source.path ? { path: source.path } : {}),
            line: snapshot.frame.line,
            column: snapshot.frame.column,
          },
        }
      : {}),
    ...(ip ? { instructionPointerReference: ip } : {}),
    exactInstructionMatch: currentIndex >= 0 && instructions[currentIndex]?.address.toLowerCase() === ip?.toLowerCase(),
    ...(currentIndex >= 0 && instructions[currentIndex]
      ? { currentInstruction: instructions[currentIndex] }
      : {}),
    previousInstructions: currentIndex >= 0 ? instructions.slice(Math.max(0, currentIndex - 3), currentIndex) : [],
    nextInstructions: currentIndex >= 0 ? instructions.slice(currentIndex + 1, currentIndex + 4) : [],
  };
}

function looksPointerLike(variable: DebugProtocol.Variable): boolean {
  return /\*|pointer|ptr\b|address|handle|\bthis\b|\bself\b|object|reference/i.test(
    `${variable.name} ${variable.type ?? ''}`,
  );
}

function suspiciousValues(snapshot: RuntimeSnapshot): SuspiciousValue[] {
  const output: SuspiciousValue[] = [];
  const scan = (scope: 'local' | 'register', variables: DebugProtocol.Variable[]) => {
    for (const variable of variables) {
      const normalized = variable.value.trim().toLowerCase();
      const compact = normalized.replace(/[`'_\s]/g, '');
      const nullLike = /^(?:0|0x0+|null|nullptr|nil|<null>)$/.test(compact);
      const poison = POISON_PATTERNS.find((pattern) => compact.includes(pattern));

      if (poison) {
        output.push({
          scope,
          name: variable.name,
          value: variable.value,
          ...(variable.type ? { type: variable.type } : {}),
          reason: 'poison-pattern',
        });
      } else if (nullLike && (scope === 'register' || looksPointerLike(variable))) {
        output.push({
          scope,
          name: variable.name,
          value: variable.value,
          ...(variable.type ? { type: variable.type } : {}),
          reason: 'null-like-pointer',
        });
      }
      if (output.length >= 16) return;
    }
  };

  scan('local', snapshot.locals);
  if (output.length < 16) scan('register', snapshot.registers);
  return output;
}

function locationText(snapshot: RuntimeSnapshot): string {
  const path = snapshot.frame.source?.path ?? snapshot.frame.source?.name;
  return path ? `${snapshot.frame.name} at ${path}:${snapshot.frame.line}` : snapshot.frame.name;
}

function buildHypotheses(
  snapshot: RuntimeSnapshot,
  classification: CrashDiagnosis['classification'],
  suspicious: SuspiciousValue[],
): DiagnosisHypothesis[] {
  const hypotheses: DiagnosisHypothesis[] = [];
  const nullValues = suspicious.filter((item) => item.reason === 'null-like-pointer');
  const poisonValues = suspicious.filter((item) => item.reason === 'poison-pattern');
  const location = locationText(snapshot);

  if (!classification.crashLikely && classification.category === 'exception') {
    hypotheses.push({
      kind: 'first-chance-or-configured-exception',
      title: 'The debugger stopped on an exception, but current break-mode evidence does not prove it is fatal.',
      confidence: 'high',
      evidence: [
        `Exception break mode: ${snapshot.exception?.breakMode ?? 'unknown'}.`,
        `Stopped frame: ${location}.`,
      ],
      suggestedChecks: [
        'Continue the same reproduction to determine whether the exception is handled or reaches an unhandled terminal failure.',
        'Do not patch source solely because a first-chance/configured exception stop was observed.',
      ],
    });
    return hypotheses;
  }

  if (classification.category === 'access-violation' || classification.category === 'segmentation-fault') {
    if (nullValues.length > 0) {
      hypotheses.push({
        kind: 'null-dereference',
        title: 'A null or near-null pointer dereference is a strong candidate.',
        confidence: 'high',
        evidence: [
          `The debugger stopped with ${classification.category}.`,
          ...nullValues.slice(0, 4).map((item) => `${item.scope} ${item.name} = ${item.value}`),
          `Faulting frame: ${location}.`,
        ],
        suggestedChecks: [
          'Inspect the operands used by the current instruction and map them back to locals/registers.',
          'Inspect the caller frame to find where the pointer/reference was produced.',
          'Check object lifetime and validation immediately before the faulting line.',
        ],
      });
    }
    if (poisonValues.length > 0) {
      hypotheses.push({
        kind: 'invalid-lifetime',
        title: 'Freed, uninitialized, or deliberately poisoned memory is a strong candidate.',
        confidence: 'high',
        evidence: poisonValues.slice(0, 4).map((item) => `${item.scope} ${item.name} contains ${item.value}`),
        suggestedChecks: [
          'Trace ownership/lifetime of the poisoned value back through caller frames.',
          'Use ASan/PageHeap or equivalent memory diagnostics in a reproducible live run.',
          'Check for use-after-free, uninitialized storage, and stale callbacks/handles.',
        ],
      });
    }
    if (hypotheses.length === 0) {
      hypotheses.push({
        kind: 'invalid-memory-access',
        title: 'The current instruction likely accessed an invalid address.',
        confidence: 'medium',
        evidence: [`The debugger classified the stop as ${classification.category}.`, `Faulting frame: ${location}.`],
        suggestedChecks: [
          'Inspect the current instruction operands and relevant registers.',
          'Inspect pointer/index locals in the top frame and its caller.',
          'Check bounds, object lifetime, and concurrent mutation around the fault site.',
        ],
      });
    }
  }

  if (classification.category === 'stack-overflow') {
    hypotheses.push({
      kind: 'stack-exhaustion',
      title: 'Recursive call growth or excessive stack allocation likely exhausted the stack.',
      confidence: 'high',
      evidence: [`Debugger evidence indicates stack overflow at ${location}.`],
      suggestedChecks: [
        'Look for repeating frame patterns in the stack trace.',
        'Check recursion termination conditions.',
        'Move large temporary buffers/objects off the stack where appropriate.',
      ],
    });
  }

  if (classification.category === 'divide-by-zero') {
    hypotheses.push({
      kind: 'zero-divisor',
      title: 'A zero divisor is the most likely immediate cause.',
      confidence: 'high',
      evidence: [`Debugger evidence indicates divide-by-zero at ${location}.`],
      suggestedChecks: [
        'Identify the divisor from source or current instruction operands.',
        'Trace the divisor value to the caller/input that produced it.',
        'Add validation only after identifying why the invariant was violated.',
      ],
    });
  }

  if (classification.category === 'illegal-instruction') {
    hypotheses.push({
      kind: 'bad-control-flow',
      title: 'Execution reached an invalid instruction or corrupted control-flow target.',
      confidence: 'medium',
      evidence: [`Illegal-instruction evidence points to ${location}.`],
      suggestedChecks: [
        'Inspect the current instruction address and containing module.',
        'Check function pointers/vtables/return addresses for corruption.',
        'Verify binary and symbols match the crashing executable.',
      ],
    });
  }

  if (classification.category === 'abort-or-assert') {
    hypotheses.push({
      kind: 'explicit-termination',
      title: 'The program appears to have terminated itself via abort/assertion.',
      confidence: 'high',
      evidence: [`Abort/assert evidence was found at ${location}.`],
      suggestedChecks: [
        'Inspect exception/stop text for the failed assertion or runtime message.',
        'Walk up past runtime abort helpers to the first application frame.',
        'Find the violated invariant rather than suppressing the assertion.',
      ],
    });
  }

  if (classification.category === 'heap-corruption') {
    hypotheses.push({
      kind: 'heap-corruption',
      title: 'Heap metadata or object lifetime appears corrupted.',
      confidence: 'high',
      evidence: [`Heap-corruption diagnostics were reported near ${location}.`],
      suggestedChecks: [
        'Use ASan/PageHeap or allocator diagnostics to catch the first invalid write/free.',
        'Inspect ownership transitions and double-free paths.',
        'Treat the reported crash site as possibly later than the original corruption.',
      ],
    });
  }

  if (classification.category === 'exception' && snapshot.exception) {
    hypotheses.push({
      kind: 'reported-exception',
      title: snapshot.exception.description || snapshot.exception.exceptionId || 'The debugger reported an exception.',
      confidence: 'high',
      evidence: [
        `Exception id: ${snapshot.exception.exceptionId}.`,
        ...(snapshot.exception.description ? [`Description: ${snapshot.exception.description}.`] : []),
        `Faulting frame: ${location}.`,
      ],
      suggestedChecks: [
        'Use the exception details together with the top application frame.',
        'Inspect locals and caller frames that feed values into the faulting operation.',
        'Confirm whether the exception is first-chance/handled or actually fatal for this run.',
      ],
    });
  }

  if (hypotheses.length === 0 && classification.crashLikely) {
    hypotheses.push({
      kind: 'crash-stop',
      title: 'The stop looks crash-related, but the available debugger evidence is not specific enough for one root-cause hypothesis.',
      confidence: 'low',
      evidence: [`Stop reason: ${(snapshot.stopped as DebugProtocol.StoppedEvent['body'] | undefined)?.reason ?? 'unknown'}.`, `Top frame: ${location}.`],
      suggestedChecks: [
        'Inspect exception information and the top application frames.',
        'Correlate the instruction pointer with source/disassembly.',
        'Collect a reproducible live run or matching-symbol crash dump for stronger evidence.',
      ],
    });
  }

  return hypotheses;
}

export function analyzeRuntimeSnapshot(snapshot: RuntimeSnapshot): CrashDiagnosis {
  const classification = classify(snapshot);
  const suspicious = suspiciousValues(snapshot);
  const correlation = correlateSourceDisassembly(snapshot);
  const stopped = snapshot.stopped as DebugProtocol.StoppedEvent['body'] | undefined;
  const hypotheses = buildHypotheses(snapshot, classification, suspicious);
  const location = locationText(snapshot);

  const summary = classification.crashLikely
    ? `${classification.category} is the best current classification; the most relevant frame is ${location}.`
    : classification.category === 'exception'
      ? `The debugger stopped on an exception at ${location}, but the current break mode does not prove that the process would terminate. Continue the reproduction before treating this as a crash.`
      : `The debugger stopped for ${stopped?.reason ?? classification.category}; current frame is ${location}. This is not automatically evidence of a crash.`;

  const nextActions = hypotheses
    .flatMap((hypothesis) => hypothesis.suggestedChecks)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 8);

  return {
    summary,
    classification,
    ...(stopped?.reason ? { stopReason: stopped.reason } : {}),
    ...(snapshot.exception ? { exception: snapshot.exception } : {}),
    faultLocation: {
      function: snapshot.frame.name,
      ...(snapshot.frame.moduleId === undefined ? {} : { moduleId: snapshot.frame.moduleId }),
      ...(snapshot.frame.source?.path ? { sourcePath: snapshot.frame.source.path } : {}),
      ...(snapshot.frame.source?.name ? { sourceName: snapshot.frame.source.name } : {}),
      line: snapshot.frame.line,
      column: snapshot.frame.column,
      ...(snapshot.frame.instructionPointerReference ? { instructionPointerReference: snapshot.frame.instructionPointerReference } : {}),
    },
    sourceDisassembly: correlation,
    suspiciousValues: suspicious,
    hypotheses,
    nextActions,
  };
}
