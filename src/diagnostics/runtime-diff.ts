import type { DebugProtocol } from '@vscode/debugprotocol';

import type { RuntimeSnapshot } from '../dap/session.js';

export type SemanticDiffStatus = 'same' | 'changed' | 'added' | 'removed' | 'unavailable' | 'unstable';

export type RuntimeValueDiff = {
  key: string;
  name: string;
  status: SemanticDiffStatus;
  baseline?: string;
  candidate?: string;
  type?: string;
  reason?: string;
};

export type RuntimeFrameDiff = {
  index: number;
  status: SemanticDiffStatus;
  baseline?: RuntimeFrameIdentity;
  candidate?: RuntimeFrameIdentity;
};

export type RuntimeFrameIdentity = {
  function: string;
  sourcePath?: string;
  line?: number;
  moduleId?: string;
};

export type RuntimeSnapshotDiff = {
  summary: {
    meaningfulDifferences: number;
    changedLocals: number;
    changedRegisters: number;
    unstableValues: number;
    stackChanges: number;
    addedModules: number;
    removedModules: number;
  };
  stack: {
    status: SemanticDiffStatus;
    frames: RuntimeFrameDiff[];
  };
  locals: RuntimeValueDiff[];
  registers: RuntimeValueDiff[];
  exception: {
    status: SemanticDiffStatus;
    baseline?: unknown;
    candidate?: unknown;
  };
  symbolHealth: {
    status: SemanticDiffStatus;
    baseline: RuntimeSnapshot['symbolHealth'];
    candidate: RuntimeSnapshot['symbolHealth'];
  };
  modules: {
    status: SemanticDiffStatus;
    added: string[];
    removed: string[];
  };
  firstMeaningfulDifference?: {
    category: 'local' | 'register' | 'exception' | 'stack' | 'symbol-health' | 'module';
    key?: string;
    status: SemanticDiffStatus;
    baseline?: unknown;
    candidate?: unknown;
    reason?: string;
  };
  limitations: string[];
};

const ADDRESS_RE = /^(?:0x)?[0-9a-f]{6,}$/i;
const NULL_RE = /^(?:0x)?0+$/i;

function normalizeSourcePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\\/g, '/');
  return /^[A-Za-z]:\//.test(normalized)
    ? `${normalized[0]?.toLowerCase()}${normalized.slice(1)}`.toLowerCase()
    : normalized;
}

function canonicalJson(value: unknown): string {
  const visit = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(visit);
    if (!input || typeof input !== 'object') return input;
    const record = input as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, visit(record[key])]));
  };
  return JSON.stringify(visit(value));
}

function isNullLike(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'null' || normalized === 'nullptr' || normalized === '(nil)' || normalized === 'nil' || NULL_RE.test(normalized);
}

function isAddressLike(value: string): boolean {
  return ADDRESS_RE.test(value.trim());
}

function frameIdentity(frame: DebugProtocol.StackFrame | undefined): RuntimeFrameIdentity | undefined {
  if (!frame) return undefined;
  const sourcePath = normalizeSourcePath(frame.source?.path);
  return {
    function: frame.name || '<unknown>',
    ...(sourcePath ? { sourcePath } : {}),
    ...(Number.isInteger(frame.line) && frame.line > 0 ? { line: frame.line } : {}),
    ...(frame.moduleId === undefined ? {} : { moduleId: String(frame.moduleId) }),
  };
}

function sameFrame(left: RuntimeFrameIdentity | undefined, right: RuntimeFrameIdentity | undefined): boolean {
  if (!left || !right) return left === right;
  return left.function === right.function
    && left.sourcePath === right.sourcePath
    && left.line === right.line
    && left.moduleId === right.moduleId;
}

function variableKey(variable: DebugProtocol.Variable): string {
  return [variable.evaluateName || variable.name, variable.type ?? ''].join('\u0000');
}

function firstVariablesByKey(variables: DebugProtocol.Variable[]): Map<string, DebugProtocol.Variable> {
  const output = new Map<string, DebugProtocol.Variable>();
  for (const variable of variables) {
    const key = variableKey(variable);
    if (!output.has(key)) output.set(key, variable);
  }
  return output;
}

function diffVariable(
  key: string,
  baseline: DebugProtocol.Variable | undefined,
  candidate: DebugProtocol.Variable | undefined,
): RuntimeValueDiff {
  const name = baseline?.name ?? candidate?.name ?? key;
  const type = baseline?.type ?? candidate?.type;
  if (!baseline) {
    return { key, name, status: 'added', candidate: candidate?.value, ...(type ? { type } : {}) };
  }
  if (!candidate) {
    return { key, name, status: 'removed', baseline: baseline.value, ...(type ? { type } : {}) };
  }
  if (baseline.value === candidate.value) {
    return { key, name, status: 'same', baseline: baseline.value, candidate: candidate.value, ...(type ? { type } : {}) };
  }

  const baselineNull = isNullLike(baseline.value);
  const candidateNull = isNullLike(candidate.value);
  if (baselineNull !== candidateNull) {
    return {
      key,
      name,
      status: 'changed',
      baseline: baseline.value,
      candidate: candidate.value,
      ...(type ? { type } : {}),
      reason: 'Nullability changed between runs.',
    };
  }

  if (!baselineNull && !candidateNull && isAddressLike(baseline.value) && isAddressLike(candidate.value)) {
    return {
      key,
      name,
      status: 'unstable',
      baseline: baseline.value,
      candidate: candidate.value,
      ...(type ? { type } : {}),
      reason: 'Both values look like non-null raw addresses; address-only differences are treated as unstable across runs because of ASLR/allocation variance.',
    };
  }

  return {
    key,
    name,
    status: 'changed',
    baseline: baseline.value,
    candidate: candidate.value,
    ...(type ? { type } : {}),
  };
}

function diffVariables(
  baseline: DebugProtocol.Variable[],
  candidate: DebugProtocol.Variable[],
): RuntimeValueDiff[] {
  const left = firstVariablesByKey(baseline);
  const right = firstVariablesByKey(candidate);
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  return keys.map((key) => diffVariable(key, left.get(key), right.get(key)));
}

function moduleKey(module: DebugProtocol.Module): string {
  const path = normalizeSourcePath(module.path);
  return path || module.name || String(module.id);
}

function diffModules(
  baseline: DebugProtocol.Module[] | undefined,
  candidate: DebugProtocol.Module[] | undefined,
): RuntimeSnapshotDiff['modules'] {
  if (!baseline && !candidate) return { status: 'unavailable', added: [], removed: [] };
  const left = new Set((baseline ?? []).map(moduleKey));
  const right = new Set((candidate ?? []).map(moduleKey));
  const added = [...right].filter((item) => !left.has(item)).sort();
  const removed = [...left].filter((item) => !right.has(item)).sort();
  return {
    status: added.length || removed.length ? 'changed' : 'same',
    added,
    removed,
  };
}

function diffStack(baseline: RuntimeSnapshot, candidate: RuntimeSnapshot): RuntimeSnapshotDiff['stack'] {
  const count = Math.max(baseline.stack.length, candidate.stack.length);
  const frames: RuntimeFrameDiff[] = [];
  for (let index = 0; index < count; index += 1) {
    const left = frameIdentity(baseline.stack[index]);
    const right = frameIdentity(candidate.stack[index]);
    let status: SemanticDiffStatus;
    if (!left) status = 'added';
    else if (!right) status = 'removed';
    else status = sameFrame(left, right) ? 'same' : 'changed';
    frames.push({ index, status, ...(left ? { baseline: left } : {}), ...(right ? { candidate: right } : {}) });
  }
  return { status: frames.some((frame) => frame.status !== 'same') ? 'changed' : 'same', frames };
}

function firstMeaningful(
  locals: RuntimeValueDiff[],
  registers: RuntimeValueDiff[],
  exceptionStatus: SemanticDiffStatus,
  baselineException: unknown,
  candidateException: unknown,
  stack: RuntimeSnapshotDiff['stack'],
  baseline: RuntimeSnapshot,
  candidate: RuntimeSnapshot,
  modules: RuntimeSnapshotDiff['modules'],
): RuntimeSnapshotDiff['firstMeaningfulDifference'] {
  const local = locals.find((item) => item.status === 'changed' || item.status === 'added' || item.status === 'removed');
  if (local) return { category: 'local', key: local.key, status: local.status, baseline: local.baseline, candidate: local.candidate, ...(local.reason ? { reason: local.reason } : {}) };

  if (exceptionStatus === 'changed' || exceptionStatus === 'added' || exceptionStatus === 'removed') {
    return { category: 'exception', status: exceptionStatus, baseline: baselineException, candidate: candidateException };
  }

  const stackFrame = stack.frames.find((item) => item.status !== 'same');
  if (stackFrame) return { category: 'stack', key: String(stackFrame.index), status: stackFrame.status, baseline: stackFrame.baseline, candidate: stackFrame.candidate };

  const register = registers.find((item) => item.status === 'changed' || item.status === 'added' || item.status === 'removed');
  if (register) return { category: 'register', key: register.key, status: register.status, baseline: register.baseline, candidate: register.candidate, ...(register.reason ? { reason: register.reason } : {}) };

  if (baseline.symbolHealth.status !== candidate.symbolHealth.status) {
    return { category: 'symbol-health', status: 'changed', baseline: baseline.symbolHealth, candidate: candidate.symbolHealth };
  }

  if (modules.status === 'changed') {
    return { category: 'module', status: 'changed', baseline: modules.removed, candidate: modules.added };
  }

  return undefined;
}

export function compareRuntimeSnapshots(
  baseline: RuntimeSnapshot,
  candidate: RuntimeSnapshot,
): RuntimeSnapshotDiff {
  const locals = diffVariables(baseline.locals, candidate.locals);
  const registers = diffVariables(baseline.registers, candidate.registers);
  const stack = diffStack(baseline, candidate);
  const modules = diffModules(baseline.modules, candidate.modules);

  const baselineException = baseline.exception;
  const candidateException = candidate.exception;
  let exceptionStatus: SemanticDiffStatus;
  if (baselineException === undefined && candidateException === undefined) exceptionStatus = 'unavailable';
  else if (baselineException === undefined) exceptionStatus = 'added';
  else if (candidateException === undefined) exceptionStatus = 'removed';
  else exceptionStatus = canonicalJson(baselineException) === canonicalJson(candidateException) ? 'same' : 'changed';

  const symbolHealthStatus: SemanticDiffStatus = baseline.symbolHealth.status === candidate.symbolHealth.status ? 'same' : 'changed';
  const changedLocals = locals.filter((item) => ['changed', 'added', 'removed'].includes(item.status)).length;
  const changedRegisters = registers.filter((item) => ['changed', 'added', 'removed'].includes(item.status)).length;
  const unstableValues = [...locals, ...registers].filter((item) => item.status === 'unstable').length;
  const stackChanges = stack.frames.filter((item) => item.status !== 'same').length;
  const meaningfulDifferences = changedLocals
    + changedRegisters
    + stackChanges
    + modules.added.length
    + modules.removed.length
    + (['changed', 'added', 'removed'].includes(exceptionStatus) ? 1 : 0)
    + (symbolHealthStatus === 'changed' ? 1 : 0);

  const first = firstMeaningful(
    locals,
    registers,
    exceptionStatus,
    baselineException,
    candidateException,
    stack,
    baseline,
    candidate,
    modules,
  );

  return {
    summary: {
      meaningfulDifferences,
      changedLocals,
      changedRegisters,
      unstableValues,
      stackChanges,
      addedModules: modules.added.length,
      removedModules: modules.removed.length,
    },
    stack,
    locals,
    registers,
    exception: {
      status: exceptionStatus,
      ...(baselineException === undefined ? {} : { baseline: baselineException }),
      ...(candidateException === undefined ? {} : { candidate: candidateException }),
    },
    symbolHealth: {
      status: symbolHealthStatus,
      baseline: baseline.symbolHealth,
      candidate: candidate.symbolHealth,
    },
    modules,
    ...(first ? { firstMeaningfulDifference: first } : {}),
    limitations: [
      'Runtime snapshots are compared semantically, not byte-for-byte.',
      'Non-null raw address changes are classified as unstable unless another semantic change makes them meaningful.',
      'A first meaningful difference is an evidence-prioritization hint, not proof of root cause or temporal causality.',
      'Stack comparison is frame-position based in v0.17 phase 1; recursive/inlined stack realignment may be added later.',
    ],
  };
}
