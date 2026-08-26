import path from 'node:path';

import type { DebugProtocol } from '@vscode/debugprotocol';

import type { RuntimeSnapshot } from '../dap/session.js';
import type {
  CrashDiagnosis,
  DiagnosisCategory,
  DiagnosisConfidence,
  DiagnosisHypothesis,
} from './analyze-snapshot.js';
import { diagnosticPathWithinRoot, normalizeDiagnosticPath } from './path-normalization.js';

export type IntelligentDiagnosisOptions = {
  projectRoots?: string[];
  projectModules?: string[];
  program?: string;
  cwd?: string;
  callerDepth?: number;
};

export type FrameAssessment = {
  index: number;
  frame: DebugProtocol.StackFrame;
  score: number;
  projectControlled: boolean;
  runtimeLikely: boolean;
  confidence: DiagnosisConfidence;
  reasons: string[];
};

export type ProjectFrameSelection = {
  selected: FrameAssessment;
  assessments: FrameAssessment[];
  skippedRuntimeFrames: number;
  usedExplicitProjectHint: boolean;
};

export type FrameEvidence = {
  index: number;
  frame: DebugProtocol.StackFrame;
  locals: DebugProtocol.Variable[];
  registers: DebugProtocol.Variable[];
  disassembly?: DebugProtocol.DisassembledInstruction[];
  collectionErrors?: string[];
};

export type MemoryRegisterRole = 'base' | 'index' | 'offset' | 'unknown';

export type RegisterBinding = {
  register: string;
  canonicalRegister: string;
  value?: string;
  referencedByMemoryOperand: boolean;
  memoryRole?: MemoryRegisterRole;
  suspicious?: 'null-like' | 'poison-pattern';
};

export type VariableRegisterBinding = {
  variable: string;
  variableType?: string;
  variableValue: string;
  register: string;
  registerValue: string;
  confidence: DiagnosisConfidence;
  reason: string;
};

export type OperandAnalysis = {
  frameIndex?: number;
  instruction?: DebugProtocol.DisassembledInstruction;
  mnemonic?: string;
  rawInstruction?: string;
  referencedRegisters: RegisterBinding[];
  memoryOperand?: string;
  variableBindings: VariableRegisterBinding[];
  likelyFaultOperand?: {
    register: string;
    value?: string;
    reason: string;
    confidence: DiagnosisConfidence;
    faultingFrame: boolean;
  };
};

export type CallChainFrame = {
  index: number;
  function: string;
  moduleId?: number | string;
  sourcePath?: string;
  line: number;
  role: 'fault' | 'project-fault' | 'project-caller' | 'runtime-boundary' | 'other';
  projectControlled: boolean;
  runtimeLikely: boolean;
  score: number;
};

export type CallChainAnalysis = {
  frames: CallChainFrame[];
  firstProjectFrame: CallChainFrame;
  runtimeBoundaryDepth: number;
  projectCallerFrames: CallChainFrame[];
  repeatedFunctions: Array<{ function: string; count: number }>;
  provenance: Array<{
    value: string;
    frames: Array<{ index: number; function: string; variables: string[] }>;
    confidence: DiagnosisConfidence;
  }>;
  rootCauseCandidate: {
    frame: CallChainFrame;
    confidence: DiagnosisConfidence;
    rationale: string[];
  };
};

export type FixWorkflow = {
  status: 'proposal-only' | 'evidence-required';
  candidateLocation: {
    function: string;
    sourcePath?: string;
    line: number;
  };
  hypothesis?: DiagnosisHypothesis;
  suggestedChanges: string[];
  phases: Array<{
    phase: 'diagnose' | 'fix' | 'rebuild' | 'reproduce' | 'verify';
    state: 'complete' | 'agent-action-required' | 'ready-after-rebuild' | 'not-applicable';
    instruction: string;
  }>;
};

export type VerificationBaseline = {
  classification: DiagnosisCategory;
  crashLikely: boolean;
  faultFunction: string;
  projectFunction: string;
  projectSourcePath?: string;
  projectLine: number;
  hypothesisKinds: string[];
  suspiciousNames: string[];
};

export type VerificationResult = {
  verdict: 'fixed' | 'not-fixed' | 'changed-failure' | 'inconclusive';
  confidence: DiagnosisConfidence;
  evidence: string[];
};

export type IntelligentCrashDiagnosis = CrashDiagnosis & {
  projectFrame: {
    index: number;
    function: string;
    moduleId?: number | string;
    sourcePath?: string;
    sourceName?: string;
    line: number;
    column: number;
    instructionPointerReference?: string;
    confidence: DiagnosisConfidence;
    reasons: string[];
  };
  frameSelection: ProjectFrameSelection;
  operandAnalysis: OperandAnalysis;
  callChain: CallChainAnalysis;
  fixWorkflow: FixWorkflow;
  verificationBaseline: VerificationBaseline;
};

const RUNTIME_MODULE_RE = /^(?:ntdll|kernel32|kernelbase|ucrtbase|vcruntime\d*|msvcp\d*|libc(?:\+\+)?|libstdc\+\+|libgcc_s|libpthread|libm|ld-linux|libsystem_[^/\\]*|dyld|objc|corefoundation)(?:\.[^/\\]+)?$/i;
const RUNTIME_PATH_RE = /(?:^|[/\\])(?:windows[/\\]system32|usr[/\\]lib|lib[/\\](?:x86_64-linux-gnu|aarch64-linux-gnu)|system[/\\]library)(?:[/\\]|$)/i;
const RUNTIME_FUNCTION_RE = /^(?:std::|__cxa_|__libc_|__pthread_|_?cxxthrowexception|raise$|abort$|terminate$|memcpy$|memmove$|malloc$|free$)/i;
const POISON_PATTERNS = [
  '0xcccccccc',
  '0xcdcdcdcd',
  '0xdddddddd',
  '0xfeeefeee',
  '0xfdfdfdfd',
  '0xdeadbeef',
  '0xbaadf00d',
];

function portableBasename(value: string): string {
  return value.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? value;
}

function portableDirname(value: string): string | undefined {
  const result = /^[a-z]:[\\/]/i.test(value) ? path.win32.dirname(value) : path.dirname(value);
  return result === '.' ? undefined : result;
}

function sourcePath(frame: DebugProtocol.StackFrame): string | undefined {
  return frame.source?.path ?? frame.source?.name;
}

function moduleBasename(frame: DebugProtocol.StackFrame): string {
  return portableBasename(String(frame.moduleId ?? '')).toLowerCase();
}

function confidenceFromScore(score: number): DiagnosisConfidence {
  if (score >= 80) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

function projectHints(options: IntelligentDiagnosisOptions) {
  const roots = new Set<string>();
  const addRoot = (value: string | undefined) => {
    const normalized = normalizeDiagnosticPath(value);
    if (normalized) roots.add(normalized);
  };
  for (const root of options.projectRoots ?? []) addRoot(root);
  addRoot(options.cwd);
  if (options.program) addRoot(portableDirname(options.program));

  const modules = new Set((options.projectModules ?? []).map((value) => portableBasename(value).toLowerCase()));
  if (options.program) modules.add(portableBasename(options.program).toLowerCase());
  return { roots, modules };
}

export function assessProjectFrames(
  stack: DebugProtocol.StackFrame[],
  options: IntelligentDiagnosisOptions = {},
): FrameAssessment[] {
  const hints = projectHints(options);
  return stack.map((frame, index) => {
    const reasons: string[] = [];
    let score = 0;
    const source = normalizeDiagnosticPath(sourcePath(frame));
    const moduleName = moduleBasename(frame);
    const runtimeModule = Boolean(moduleName && RUNTIME_MODULE_RE.test(moduleName));
    const runtimePath = Boolean(source && RUNTIME_PATH_RE.test(source));
    const runtimeFunction = RUNTIME_FUNCTION_RE.test(frame.name);
    const runtimeLikely = runtimeModule || runtimePath || (runtimeFunction && !source);

    if (source) {
      score += 25;
      reasons.push('frame has source information');
      if ([...hints.roots].some((root) => diagnosticPathWithinRoot(source, root))) {
        score += 120;
        reasons.push('source is inside an explicit/inferred project root');
      }
    }
    if (moduleName && hints.modules.has(moduleName)) {
      score += 100;
      reasons.push(`module ${moduleName} matches a project/program module hint`);
    }
    if (runtimeModule) {
      score -= 140;
      reasons.push(`module ${moduleName} looks like a runtime/system module`);
    }
    if (runtimePath) {
      score -= 100;
      reasons.push('source path looks like operating-system/runtime code');
    }
    if (runtimeFunction) {
      score -= 25;
      reasons.push('function name looks like a runtime helper');
    }
    if (!source && !moduleName) score -= 10;

    return {
      index,
      frame,
      score,
      projectControlled: score >= 30 && !runtimeModule && !runtimePath,
      runtimeLikely,
      confidence: confidenceFromScore(score),
      reasons,
    };
  });
}

export function selectProjectFrame(
  stack: DebugProtocol.StackFrame[],
  options: IntelligentDiagnosisOptions = {},
): ProjectFrameSelection {
  if (stack.length === 0) throw new Error('Cannot select a project frame from an empty stack.');
  const assessments = assessProjectFrames(stack, options);
  const hints = projectHints(options);
  const selected = assessments.find((item) => item.projectControlled)
    ?? assessments.find((item) => !item.runtimeLikely && Boolean(sourcePath(item.frame)))
    ?? assessments[0];
  if (!selected) throw new Error('Unable to select a project frame.');

  return {
    selected,
    assessments,
    skippedRuntimeFrames: assessments.slice(0, selected.index).filter((item) => item.runtimeLikely).length,
    usedExplicitProjectHint: hints.roots.size > 0 || hints.modules.size > 0,
  };
}

function parseAddress(value: string | undefined): bigint | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/[`'_\s]/g, '');
  const hex = /0x([0-9a-f]+)/i.exec(normalized)?.[1];
  try {
    if (hex) return BigInt(`0x${hex}`);
    if (/^-?\d+$/.test(normalized)) return BigInt(normalized);
  } catch {
    return undefined;
  }
  return undefined;
}

function suspiciousKind(value: string | undefined): 'null-like' | 'poison-pattern' | undefined {
  if (!value) return undefined;
  const compact = value.trim().toLowerCase().replace(/[`'_\s]/g, '');
  if (/^(?:0x0+|0|null|nullptr|nil|<null>)$/.test(compact)) return 'null-like';
  if (POISON_PATTERNS.some((pattern) => compact.includes(pattern))) return 'poison-pattern';
  return undefined;
}

function looksPointerLike(variable: DebugProtocol.Variable): boolean {
  return /\*|pointer|ptr\b|address|handle|\bthis\b|\bself\b|object|reference/i.test(
    `${variable.name} ${variable.type ?? ''}`,
  );
}

const X86_REGISTER_RE = /\b(?:r(?:ax|bx|cx|dx|si|di|sp|bp|ip|8|9|1[0-5])|r(?:8|9|1[0-5])(?:d|w|b)|e(?:ax|bx|cx|dx|si|di|sp|bp|ip)|(?:ax|bx|cx|dx|si|di|sp|bp|ip)|[abcd][lh]|[sd]il|[sb]pl)\b/gi;
const ARM_REGISTER_RE = /\b(?:[xw](?:[0-9]|[12][0-9]|30)|sp|pc|lr)\b/gi;

function canonicalX86Register(value: string): string {
  const name = value.toLowerCase();
  const aliases: Record<string, string> = {
    eax: 'rax', ax: 'rax', al: 'rax', ah: 'rax',
    ebx: 'rbx', bx: 'rbx', bl: 'rbx', bh: 'rbx',
    ecx: 'rcx', cx: 'rcx', cl: 'rcx', ch: 'rcx',
    edx: 'rdx', dx: 'rdx', dl: 'rdx', dh: 'rdx',
    esi: 'rsi', si: 'rsi', sil: 'rsi',
    edi: 'rdi', di: 'rdi', dil: 'rdi',
    esp: 'rsp', sp: 'rsp', spl: 'rsp',
    ebp: 'rbp', bp: 'rbp', bpl: 'rbp',
    eip: 'rip', ip: 'rip',
  };
  if (aliases[name]) return aliases[name];
  return /^(r(?:8|9|1[0-5]))(?:d|w|b)$/.exec(name)?.[1] ?? name;
}

function canonicalArmRegister(value: string): string {
  const name = value.toLowerCase();
  if (name === 'lr') return 'x30';
  const match = /^w(\d+)$/.exec(name)?.[1];
  return match ? `x${match}` : name;
}

function currentInstruction(evidence: FrameEvidence): DebugProtocol.DisassembledInstruction | undefined {
  const instructions = evidence.disassembly ?? [];
  const ip = evidence.frame.instructionPointerReference;
  if (!ip) return instructions[0];
  const exact = instructions.find((item) => item.address.toLowerCase() === ip.toLowerCase());
  if (exact) return exact;
  const target = parseAddress(ip);
  if (target === undefined) return instructions[0];

  let nearest: DebugProtocol.DisassembledInstruction | undefined;
  let distance: bigint | undefined;
  for (const instruction of instructions) {
    const address = parseAddress(instruction.address);
    if (address === undefined) continue;
    const delta = address >= target ? address - target : target - address;
    if (distance === undefined || delta < distance) {
      nearest = instruction;
      distance = delta;
    }
  }
  return nearest;
}

function memoryRegisterRoles(
  rawInstruction: string,
  memoryText: string,
  armLike: boolean,
  attMemorySyntax: boolean,
  canonicalize: (value: string) => string,
): Map<string, MemoryRegisterRole> {
  const regex = armLike ? ARM_REGISTER_RE : X86_REGISTER_RE;
  const matches = [...memoryText.matchAll(regex)];
  const roles = new Map<string, MemoryRegisterRole>();
  if (matches.length === 0) return roles;

  if (armLike) {
    matches.forEach((match, index) => {
      roles.set(canonicalize(match[0]), index === 0 ? 'base' : 'index');
    });
    return roles;
  }

  if (attMemorySyntax) {
    matches.forEach((match, index) => {
      roles.set(canonicalize(match[0]), index === 0 ? 'base' : index === 1 ? 'index' : 'unknown');
    });
    return roles;
  }

  let baseAssigned = false;
  for (const match of matches) {
    const canonical = canonicalize(match[0]);
    const start = match.index ?? rawInstruction.indexOf(match[0]);
    const relativeStart = Math.max(0, start - rawInstruction.indexOf(memoryText));
    const after = memoryText.slice(relativeStart + match[0].length);
    if (/^\s*\*/.test(after)) {
      roles.set(canonical, 'index');
      continue;
    }
    if (!baseAssigned) {
      roles.set(canonical, 'base');
      baseAssigned = true;
    } else if (!roles.has(canonical)) {
      roles.set(canonical, 'unknown');
    }
  }
  return roles;
}

export function analyzeInstructionOperands(evidence: FrameEvidence): OperandAnalysis {
  const instruction = currentInstruction(evidence);
  const rawInstruction = instruction?.instruction;
  if (!rawInstruction) return { frameIndex: evidence.index, referencedRegisters: [], variableBindings: [] };

  const armLike = /\b[wx](?:[0-9]|[12][0-9]|30)\b/i.test(rawInstruction);
  const registerRegex = armLike ? ARM_REGISTER_RE : X86_REGISTER_RE;
  const canonicalize = armLike ? canonicalArmRegister : canonicalX86Register;
  const memoryMatch = /\[([^\]]+)\]|\(([^)]+)\)/.exec(rawInstruction);
  const memoryOperand = memoryMatch?.[0];
  const memoryText = memoryMatch?.[1] ?? memoryMatch?.[2] ?? '';
  const referenced = [...new Set(
    [...rawInstruction.matchAll(registerRegex)].map((match) => canonicalize(match[0])),
  )];
  const roles = memoryRegisterRoles(rawInstruction, memoryText, armLike, memoryMatch?.[2] !== undefined, canonicalize);
  const memoryRegisters = new Set(roles.keys());

  const values = new Map<string, DebugProtocol.Variable>();
  for (const register of evidence.registers) values.set(canonicalize(register.name), register);
  const bindings: RegisterBinding[] = referenced.map((register) => {
    const value = values.get(register)?.value;
    const suspicious = suspiciousKind(value);
    const memoryRole = roles.get(register);
    return {
      register,
      canonicalRegister: register,
      ...(value === undefined ? {} : { value }),
      referencedByMemoryOperand: memoryRegisters.has(register),
      ...(memoryRole ? { memoryRole } : {}),
      ...(suspicious ? { suspicious } : {}),
    };
  });

  const variableBindings: VariableRegisterBinding[] = [];
  for (const local of evidence.locals) {
    const localValue = parseAddress(local.value);
    if (localValue === undefined) continue;
    for (const binding of bindings) {
      const registerValue = parseAddress(binding.value);
      if (registerValue === undefined || binding.value === undefined || registerValue !== localValue) continue;
      if (localValue === 0n && !looksPointerLike(local)) continue;
      variableBindings.push({
        variable: local.name,
        ...(local.type ? { variableType: local.type } : {}),
        variableValue: local.value,
        register: binding.register,
        registerValue: binding.value,
        confidence: binding.referencedByMemoryOperand && looksPointerLike(local) ? 'high' : 'medium',
        reason: binding.referencedByMemoryOperand
          ? `local value matches the ${binding.memoryRole ?? 'unknown'} register used by this frame's memory operand`
          : 'local value matches a register referenced by this frame\'s instruction',
      });
      if (variableBindings.length >= 12) break;
    }
    if (variableBindings.length >= 12) break;
  }

  // A zero index/offset is ordinary address arithmetic, not a null-pointer
  // dereference. Null-like values are only promoted when they are the base
  // address. Poison values remain suspicious in any effective-address role.
  const suspiciousMemory = bindings.find((binding) =>
    binding.referencedByMemoryOperand
      && (binding.suspicious === 'poison-pattern'
        || (binding.suspicious === 'null-like' && binding.memoryRole === 'base')),
  );
  const mnemonic = rawInstruction.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return {
    frameIndex: evidence.index,
    instruction,
    ...(mnemonic ? { mnemonic } : {}),
    rawInstruction,
    referencedRegisters: bindings,
    ...(memoryOperand ? { memoryOperand } : {}),
    variableBindings,
    ...(suspiciousMemory
      ? {
          likelyFaultOperand: {
            register: suspiciousMemory.register,
            ...(suspiciousMemory.value === undefined ? {} : { value: suspiciousMemory.value }),
            reason: `${suspiciousMemory.register} is the ${suspiciousMemory.memoryRole ?? 'unknown'} register used by this frame's memory operand and contains a ${suspiciousMemory.suspicious === 'null-like' ? 'null-like' : 'poison-pattern'} value`,
            confidence: evidence.index === 0 ? 'high' : 'medium',
            faultingFrame: evidence.index === 0,
          },
        }
      : {}),
  };
}

function compactFrame(assessment: FrameAssessment, role: CallChainFrame['role']): CallChainFrame {
  const source = sourcePath(assessment.frame);
  return {
    index: assessment.index,
    function: assessment.frame.name,
    ...(assessment.frame.moduleId === undefined ? {} : { moduleId: assessment.frame.moduleId }),
    ...(source ? { sourcePath: source } : {}),
    line: assessment.frame.line,
    role,
    projectControlled: assessment.projectControlled,
    runtimeLikely: assessment.runtimeLikely,
    score: assessment.score,
  };
}

function comparableValue(value: string): string | undefined {
  const parsed = parseAddress(value);
  return parsed === undefined ? undefined : `0x${parsed.toString(16)}`;
}

function buildProvenance(evidence: FrameEvidence[]): CallChainAnalysis['provenance'] {
  const values = new Map<string, Array<{ index: number; function: string; variable: string }>>();
  for (const frame of evidence) {
    for (const variable of frame.locals) {
      if (!looksPointerLike(variable)) continue;
      const value = comparableValue(variable.value);
      if (!value) continue;
      const occurrences = values.get(value) ?? [];
      occurrences.push({ index: frame.index, function: frame.frame.name, variable: variable.name });
      values.set(value, occurrences);
    }
  }

  const output: CallChainAnalysis['provenance'] = [];
  for (const [value, occurrences] of values) {
    if (new Set(occurrences.map((item) => item.index)).size < 2) continue;
    const frames = new Map<number, { index: number; function: string; variables: string[] }>();
    for (const occurrence of occurrences) {
      const item = frames.get(occurrence.index) ?? {
        index: occurrence.index,
        function: occurrence.function,
        variables: [],
      };
      if (!item.variables.includes(occurrence.variable)) item.variables.push(occurrence.variable);
      frames.set(occurrence.index, item);
    }
    const kind = suspiciousKind(value);
    output.push({
      value,
      frames: [...frames.values()].sort((a, b) => a.index - b.index),
      confidence: kind === 'poison-pattern' ? 'high' : kind === 'null-like' ? 'low' : 'medium',
    });
  }
  return output.slice(0, 8);
}

export function analyzeCallChain(
  selection: ProjectFrameSelection,
  evidence: FrameEvidence[],
): CallChainAnalysis {
  const selectedIndex = selection.selected.index;
  const frames = selection.assessments.map((assessment) => {
    let role: CallChainFrame['role'] = 'other';
    if (assessment.index === 0) role = assessment.index === selectedIndex ? 'project-fault' : 'fault';
    else if (assessment.index === selectedIndex) role = 'project-fault';
    else if (assessment.index > selectedIndex && assessment.projectControlled) role = 'project-caller';
    else if (assessment.index < selectedIndex && assessment.runtimeLikely) role = 'runtime-boundary';
    return compactFrame(assessment, role);
  });

  const counts = new Map<string, number>();
  for (const assessment of selection.assessments) {
    counts.set(assessment.frame.name, (counts.get(assessment.frame.name) ?? 0) + 1);
  }
  const repeatedFunctions = [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .map(([functionName, count]) => ({ function: functionName, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const firstProjectFrame = frames[selectedIndex] ?? frames[0];
  if (!firstProjectFrame) throw new Error('Unable to build call-chain analysis without a frame.');
  const projectCallerFrames = frames.filter((frame) => frame.index > selectedIndex && frame.projectControlled).slice(0, 6);
  const provenance = buildProvenance(evidence);
  const strongProvenance = provenance.some((item) =>
    item.confidence === 'high' && item.frames.some((frame) => frame.index === selectedIndex),
  );
  const rationale = [
    selectedIndex > 0
      ? `Frame ${selectedIndex} is the first likely application-controlled call site after ${selectedIndex} non-project frame(s).`
      : 'The faulting frame itself is likely application-controlled.',
    ...(provenance.length > 0
      ? ['Matching pointer-like values are visible across bounded project caller evidence; confidence depends on whether the value is distinctive and reaches the selected consumer.']
      : []),
    ...(repeatedFunctions.length > 0
      ? ['Repeated stack frames indicate recursion/re-entry that may be causally relevant.']
      : []),
  ];

  return {
    frames,
    firstProjectFrame,
    runtimeBoundaryDepth: selection.skippedRuntimeFrames,
    projectCallerFrames,
    repeatedFunctions,
    provenance,
    rootCauseCandidate: {
      frame: firstProjectFrame,
      confidence: strongProvenance ? 'high' : selection.selected.confidence === 'low' ? 'low' : 'medium',
      rationale,
    },
  };
}

function primaryHypothesis(base: CrashDiagnosis): DiagnosisHypothesis | undefined {
  return base.hypotheses.find((item) => item.confidence === 'high') ?? base.hypotheses[0];
}

function suggestedChanges(
  base: CrashDiagnosis,
  operand: OperandAnalysis,
  chain: CallChainAnalysis,
): string[] {
  const output: string[] = [];
  const variableBinding = operand.variableBindings[0];
  const suspiciousOperand = operand.likelyFaultOperand;

  if (suspiciousOperand && variableBinding) {
    output.push(`Trace ${variableBinding.variable} (${variableBinding.variableType ?? 'unknown type'}) from ${variableBinding.register}; the local and register values match at the selected project frame.`);
  } else if (suspiciousOperand) {
    output.push(`Trace the value loaded into ${suspiciousOperand.register}; it participates in the selected frame's memory operand and is suspicious.`);
  }

  switch (base.classification.category) {
    case 'access-violation':
    case 'segmentation-fault':
      output.push(base.hypotheses.some((item) => item.kind === 'invalid-lifetime')
        ? 'Fix the ownership/lifetime violation at the earliest evidenced producer instead of only masking the final dereference.'
        : 'Restore the pointer/reference invariant at the narrowest producer/caller boundary supported by the evidence.');
      break;
    case 'divide-by-zero':
      output.push('Restore the divisor invariant at its producer and add validation where zero is genuinely invalid.');
      break;
    case 'stack-overflow':
      output.push('Fix the recursion/re-entry termination condition or excessive per-frame stack use after confirming the repeating call pattern.');
      break;
    case 'abort-or-assert':
      output.push('Repair the violated invariant that led to abort/assert; do not simply suppress the assertion.');
      break;
    case 'heap-corruption':
      output.push('Fix the first invalid write/free or ownership transition; allocator failure may be downstream of the original corruption.');
      break;
    case 'illegal-instruction':
      output.push('Validate the control-flow target and binary/symbol match before changing source logic.');
      break;
    default:
      output.push('Apply the smallest source change directly supported by the highest-confidence debugger evidence.');
  }

  const strongestTrail = chain.provenance.find((item) => item.confidence === 'high') ?? chain.provenance[0];
  if (strongestTrail) {
    output.push(`Use the caller trail for ${strongestTrail.value} to find the earliest frame where the value first violates its contract.`);
  }
  return [...new Set(output)].slice(0, 6);
}

function buildFixWorkflow(
  base: CrashDiagnosis,
  selection: ProjectFrameSelection,
  operand: OperandAnalysis,
  chain: CallChainAnalysis,
): FixWorkflow {
  const frame = selection.selected.frame;
  const source = sourcePath(frame);
  const hypothesis = primaryHypothesis(base);

  if (!base.classification.crashLikely) {
    return {
      status: 'evidence-required',
      candidateLocation: {
        function: frame.name,
        ...(source ? { sourcePath: source } : {}),
        line: frame.line,
      },
      ...(hypothesis ? { hypothesis } : {}),
      suggestedChanges: base.nextActions.slice(0, 6),
      phases: [
        {
          phase: 'diagnose',
          state: 'complete',
          instruction: 'Preserve the stop/exception evidence, but do not treat a configured or first-chance stop as a fatal crash.',
        },
        {
          phase: 'fix',
          state: 'not-applicable',
          instruction: 'Do not edit source solely from this non-fatal/inconclusive stop.',
        },
        {
          phase: 'rebuild',
          state: 'not-applicable',
          instruction: 'No rebuild is warranted until a source fix is supported by conclusive crash evidence.',
        },
        {
          phase: 'reproduce',
          state: 'agent-action-required',
          instruction: 'Continue or repeat the same scenario until it reaches an unhandled crash or a clean terminal outcome.',
        },
        {
          phase: 'verify',
          state: 'agent-action-required',
          instruction: 'Reclassify only after the complete reproduction establishes whether the exception is handled or fatal.',
        },
      ],
    };
  }

  return {
    status: 'proposal-only',
    candidateLocation: {
      function: frame.name,
      ...(source ? { sourcePath: source } : {}),
      line: frame.line,
    },
    ...(hypothesis ? { hypothesis } : {}),
    suggestedChanges: suggestedChanges(base, operand, chain),
    phases: [
      {
        phase: 'diagnose',
        state: 'complete',
        instruction: 'Preserve classification, project-frame selection, operand bindings and call-chain provenance as the baseline evidence.',
      },
      {
        phase: 'fix',
        state: 'agent-action-required',
        instruction: 'Read the source around the selected project frame with normal coding tools and apply the smallest evidence-backed change.',
      },
      {
        phase: 'rebuild',
        state: 'agent-action-required',
        instruction: 'Rebuild with the project\'s normal build system and matching debug symbols. qwen-dap-mcp intentionally does not expose a general shell executor.',
      },
      {
        phase: 'reproduce',
        state: 'ready-after-rebuild',
        instruction: 'Run the same debug_this_crash scenario with workflow.stage="verify" and the returned verificationBaseline.',
      },
      {
        phase: 'verify',
        state: 'ready-after-rebuild',
        instruction: 'Only a complete successful reproduction, such as a clean process exit, is strong fix evidence. A breakpoint/entry stop alone is inconclusive.',
      },
    ],
  };
}

type BaselineInput = Pick<
  IntelligentCrashDiagnosis,
  'classification' | 'faultLocation' | 'projectFrame' | 'hypotheses' | 'suspiciousValues'
>;

export function createVerificationBaseline(diagnosis: BaselineInput): VerificationBaseline {
  return {
    classification: diagnosis.classification.category,
    crashLikely: diagnosis.classification.crashLikely,
    faultFunction: diagnosis.faultLocation.function,
    projectFunction: diagnosis.projectFrame.function,
    ...(diagnosis.projectFrame.sourcePath ? { projectSourcePath: diagnosis.projectFrame.sourcePath } : {}),
    projectLine: diagnosis.projectFrame.line,
    hypothesisKinds: diagnosis.hypotheses.map((item) => item.kind).slice(0, 8),
    suspiciousNames: diagnosis.suspiciousValues.map((item) => item.name).slice(0, 12),
  };
}

export function compareVerificationBaseline(
  baseline: VerificationBaseline,
  current: IntelligentCrashDiagnosis | undefined,
  terminal?: { event: 'exited' | 'terminated'; exitCode?: number },
): VerificationResult {
  if (terminal?.event === 'exited' && terminal.exitCode === 0) {
    return {
      verdict: 'fixed',
      confidence: 'high',
      evidence: ['The reproduced scenario reached a clean exit with code 0 before any crash stop was captured.'],
    };
  }
  if (!current) {
    return {
      verdict: 'inconclusive',
      confidence: 'low',
      evidence: [terminal?.event === 'terminated'
        ? 'The debuggee terminated without a stopped-state diagnosis.'
        : `The debuggee exited with code ${terminal?.exitCode ?? 'unknown'} without a stopped-state diagnosis.`],
    };
  }
  if (!current.classification.crashLikely) {
    return {
      verdict: 'inconclusive',
      confidence: 'low',
      evidence: [
        `The verification run stopped for ${current.classification.category}, which is not itself proof that the original crash is fixed.`,
        'Continue/reproduce the complete original scenario to a successful terminal outcome before claiming a fix.',
      ],
    };
  }

  const sameCategory = current.classification.category === baseline.classification;
  const sameFunction = current.projectFrame.function === baseline.projectFunction;
  const samePath = !baseline.projectSourcePath
    || normalizeDiagnosticPath(current.projectFrame.sourcePath) === normalizeDiagnosticPath(baseline.projectSourcePath);
  const sameLine = current.projectFrame.line === baseline.projectLine;
  const sharedHypothesis = current.hypotheses.some((item) => baseline.hypothesisKinds.includes(item.kind));

  if (sameCategory && sameFunction && samePath && (sameLine || sharedHypothesis)) {
    return {
      verdict: 'not-fixed',
      confidence: 'high',
      evidence: [
        `The same ${baseline.classification} crash family reproduced.`,
        `The selected project frame is still ${baseline.projectFunction}${baseline.projectSourcePath ? ` at ${baseline.projectSourcePath}` : ''}:${baseline.projectLine}.`,
        ...(sharedHypothesis ? ['At least one baseline root-cause hypothesis kind is still present.'] : []),
      ],
    };
  }

  return {
    verdict: 'changed-failure',
    confidence: 'medium',
    evidence: [
      `The run is still crash-related (${current.classification.category}) but no longer matches the original signature exactly.`,
      `Original project frame: ${baseline.projectFunction}:${baseline.projectLine}; current: ${current.projectFrame.function}:${current.projectFrame.line}.`,
      'Treat this as a potentially new or downstream failure and diagnose it separately.',
    ],
  };
}

export function buildIntelligentDiagnosis(
  snapshot: RuntimeSnapshot,
  base: CrashDiagnosis,
  selection: ProjectFrameSelection,
  evidence: FrameEvidence[],
): IntelligentCrashDiagnosis {
  const selectedEvidence = evidence.find((item) => item.index === selection.selected.index) ?? {
    index: selection.selected.index,
    frame: selection.selected.frame,
    locals: [],
    registers: [],
    ...(selection.selected.index === 0 && snapshot.disassembly ? { disassembly: snapshot.disassembly } : {}),
  };
  const operandAnalysis = analyzeInstructionOperands(selectedEvidence);
  const callChain = analyzeCallChain(selection, evidence);
  const frame = selection.selected.frame;
  const projectPath = sourcePath(frame);

  const projectFrame: IntelligentCrashDiagnosis['projectFrame'] = {
    index: selection.selected.index,
    function: frame.name,
    ...(frame.moduleId === undefined ? {} : { moduleId: frame.moduleId }),
    ...(frame.source?.path ? { sourcePath: frame.source.path } : {}),
    ...(frame.source?.name ? { sourceName: frame.source.name } : {}),
    line: frame.line,
    column: frame.column,
    ...(frame.instructionPointerReference ? { instructionPointerReference: frame.instructionPointerReference } : {}),
    confidence: selection.selected.confidence,
    reasons: selection.selected.reasons,
  };

  const summary = selection.selected.index === 0
    ? `${base.summary} The faulting frame is also the first likely project-controlled frame.`
    : `${base.summary} The first likely project-controlled frame is ${frame.name}${projectPath ? ` at ${projectPath}:${frame.line}` : ''} after ${selection.selected.index} non-project frame(s).`;

  const partial: Omit<IntelligentCrashDiagnosis, 'verificationBaseline'> = {
    ...base,
    summary,
    projectFrame,
    frameSelection: selection,
    operandAnalysis,
    callChain,
    fixWorkflow: buildFixWorkflow(base, selection, operandAnalysis, callChain),
  };

  return {
    ...partial,
    verificationBaseline: createVerificationBaseline(partial),
  };
}
