import path from 'node:path';

import type { DebugProtocol } from '@vscode/debugprotocol';

import type { RuntimeSnapshot } from '../dap/session.js';
import type {
  CrashDiagnosis,
  DiagnosisCategory,
  DiagnosisConfidence,
  DiagnosisHypothesis,
} from './analyze-snapshot.js';

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
};

export type RegisterBinding = {
  register: string;
  canonicalRegister: string;
  value?: string;
  referencedByMemoryOperand: boolean;
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
  status: 'proposal-only';
  candidateLocation: {
    function: string;
    sourcePath?: string;
    line: number;
  };
  hypothesis?: DiagnosisHypothesis;
  suggestedChanges: string[];
  phases: Array<{
    phase: 'diagnose' | 'fix' | 'rebuild' | 'reproduce' | 'verify';
    state: 'complete' | 'agent-action-required' | 'ready-after-rebuild';
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

function normalizedPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function portableBasename(value: string): string {
  return value.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? value;
}

function portableDirname(value: string): string | undefined {
  if (/^[a-z]:[\\/]/i.test(value)) {
    const result = path.win32.dirname(value);
    return result === '.' ? undefined : result;
  }
  const result = path.dirname(value);
  return result === '.' ? undefined : result;
}

function moduleText(frame: DebugProtocol.StackFrame): string {
  return String(frame.moduleId ?? '');
}

function moduleBasename(frame: DebugProtocol.StackFrame): string {
  return portableBasename(moduleText(frame)).toLowerCase();
}

function sourcePath(frame: DebugProtocol.StackFrame): string | undefined {
  return frame.source?.path ?? frame.source?.name;
}

function confidenceFromScore(score: number): DiagnosisConfidence {
  if (score >= 80) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

function normalizeModuleHint(value: string): string {
  return portableBasename(value).toLowerCase();
}

function projectHints(options: IntelligentDiagnosisOptions) {
  const roots = new Set<string>();
  for (const root of options.projectRoots ?? []) {
    const normalized = normalizedPath(root);
    if (normalized) roots.add(normalized);
  }
  if (options.cwd) {
    const normalized = normalizedPath(options.cwd);
    if (normalized) roots.add(normalized);
  }
  if (options.program) {
    const directory = portableDirname(options.program);
    const normalized = normalizedPath(directory);
    if (normalized) roots.add(normalized);
  }

  const modules = new Set<string>();
  for (const moduleName of options.projectModules ?? []) modules.add(normalizeModuleHint(moduleName));
  if (options.program) modules.add(normalizeModuleHint(options.program));

  return { roots, modules };
}

function pathWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

export function assessProjectFrames(
  stack: DebugProtocol.StackFrame[],
  options: IntelligentDiagnosisOptions = {},
): FrameAssessment[] {
  const hints = projectHints(options);

  return stack.map((frame, index) => {
    const reasons: string[] = [];
    let score = 0;
    const source = normalizedPath(sourcePath(frame));
    const moduleName = moduleBasename(frame);
    const runtimeModule = Boolean(moduleName && RUNTIME_MODULE_RE.test(moduleName));
    const runtimePath = Boolean(source && RUNTIME_PATH_RE.test(source));
    const runtimeFunction = RUNTIME_FUNCTION_RE.test(frame.name);
    const runtimeLikely = runtimeModule || runtimePath || (runtimeFunction && !source);

    if (source) {
      score += 25;
      reasons.push('frame has source information');
      for (const root of hints.roots) {
        if (pathWithinRoot(source, root)) {
          score += 120;
          reasons.push(`source is inside project root ${root}`);
          break;
        }
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

    const projectControlled = score >= 30 && !runtimeModule && !runtimePath;
    return {
      index,
      frame,
      score,
      projectControlled,
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
  const explicitHints = projectHints(options);
  const usedExplicitProjectHint = explicitHints.roots.size > 0 || explicitHints.modules.size > 0;

  let selected = assessments.find((assessment) => assessment.projectControlled);
  if (!selected) {
    selected = assessments.find((assessment) => !assessment.runtimeLikely && Boolean(sourcePath(assessment.frame)));
  }
  selected ??= assessments[0];
  if (!selected) throw new Error('Unable to select a project frame.');

  return {
    selected,
    assessments,
    skippedRuntimeFrames: assessments.slice(0, selected.index).filter((item) => item.runtimeLikely).length,
    usedExplicitProjectHint,
  };
}

function parseAddress(value: string | undefined): bigint | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/[`'_\s]/g, '');
  const match = /(?:^|[^0-9a-f])0x([0-9a-f]+)(?:$|[^0-9a-f])/i.exec(` ${normalized} `);
  if (match?.[1]) {
    try { return BigInt(`0x${match[1]}`); } catch { return undefined; }
  }
  if (/^-?\d+$/.test(normalized)) {
    try { return BigInt(normalized); } catch { return undefined; }
  }
  return undefined;
}

function poisonReason(value: string | undefined): 'null-like' | 'poison-pattern' | undefined {
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
  const familyMap: Record<string, string> = {
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
  if (familyMap[name]) return familyMap[name];
  const extended = /^(r(?:8|9|1[0-5]))(?:d|w|b)$/.exec(name);
  return extended?.[1] ?? name;
}

function canonicalArmRegister(value: string): string {
  const name = value.toLowerCase();
  if (name === 'lr') return 'x30';
  const wide = /^w(\d+)$/.exec(name);
  return wide?.[1] ? `x${wide[1]}` : name;
}

function currentInstruction(evidence: FrameEvidence): DebugProtocol.DisassembledInstruction | undefined {
  const instructions = evidence.disassembly ?? [];
  const ip = evidence.frame.instructionPointerReference;
  if (!ip) return instructions[0];
  const exact = instructions.find((instruction) => instruction.address.toLowerCase() === ip.toLowerCase());
  if (exact) return exact;
  const ipAddress = parseAddress(ip);
  if (ipAddress === undefined) return instructions[0];

  let nearest: DebugProtocol.DisassembledInstruction | undefined;
  let nearestDistance: bigint | undefined;
  for (const instruction of instructions) {
    const address = parseAddress(instruction.address);
    if (address === undefined) continue;
    const distance = address >= ipAddress ? address - ipAddress : ipAddress - address;
    if (nearestDistance === undefined || distance < nearestDistance) {
      nearest = instruction;
      nearestDistance = distance;
    }
  }
  return nearest;
}

export function analyzeInstructionOperands(evidence: FrameEvidence): OperandAnalysis {
  const instruction = currentInstruction(evidence);
  const rawInstruction = instruction?.instruction;
  if (!rawInstruction) {
    return { referencedRegisters: [], variableBindings: [] };
  }

  const armLike = /\b[wx](?:[0-9]|[12][0-9]|30)\b/i.test(rawInstruction);
  const registerRegex = armLike ? ARM_REGISTER_RE : X86_REGISTER_RE;
  const canonicalize = armLike ? canonicalArmRegister : canonicalX86Register;
  const memoryMatch = /\[([^\]]+)\]|\(([^)]+)\)/.exec(rawInstruction);
  const memoryOperand = memoryMatch?.[0];
  const memoryText = memoryMatch?.[1] ?? memoryMatch?.[2] ?? '';
  const referencedRaw = [...rawInstruction.matchAll(registerRegex)].map((match) => match[0]);
  const referencedRegisters = [...new Set(referencedRaw.map((name) => canonicalize(name)))];
  const memoryRegisters = new Set(
    [...memoryText.matchAll(armLike ? ARM_REGISTER_RE : X86_REGISTER_RE)].map((match) => canonicalize(match[0])),
  );

  const registerValues = new Map<string, DebugProtocol.Variable>();
  for (const register of evidence.registers) {
    registerValues.set(canonicalize(register.name), register);
  }

  const registerBindings: RegisterBinding[] = referencedRegisters.map((register) => {
    const variable = registerValues.get(register);
    return {
      register,
      canonicalRegister: register,
      ...(variable?.value === undefined ? {} : { value: variable.value }),
      referencedByMemoryOperand: memoryRegisters.has(register),
      ...(poisonReason(variable?.value) ? { suspicious: poisonReason(variable?.value) } : {}),
    };
  });

  const variableBindings: VariableRegisterBinding[] = [];
  for (const local of evidence.locals) {
    const localAddress = parseAddress(local.value);
    if (localAddress === undefined) continue;
    for (const binding of registerBindings) {
      const registerAddress = parseAddress(binding.value);
      if (registerAddress === undefined || registerAddress !== localAddress || binding.value === undefined) continue;
      if (localAddress === 0n && !looksPointerLike(local)) continue;
      variableBindings.push({
        variable: local.name,
        ...(local.type ? { variableType: local.type } : {}),
        variableValue: local.value,
        register: binding.register,
        registerValue: binding.value,
        confidence: binding.referencedByMemoryOperand && looksPointerLike(local) ? 'high' : 'medium',
        reason: binding.referencedByMemoryOperand
          ? 'local value matches a register used by the current memory operand'
          : 'local value matches a register referenced by the current instruction',
      });
      if (variableBindings.length >= 12) break;
    }
    if (variableBindings.length >= 12) break;
  }

  const suspiciousMemoryRegister = registerBindings.find(
    (binding) => binding.referencedByMemoryOperand && binding.suspicious,
  );

  const mnemonic = rawInstruction.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return {
    instruction,
    ...(mnemonic ? { mnemonic } : {}),
    rawInstruction,
    referencedRegisters: registerBindings,
    ...(memoryOperand ? { memoryOperand } : {}),
    variableBindings,
    ...(suspiciousMemoryRegister
      ? {
          likelyFaultOperand: {
            register: suspiciousMemoryRegister.register,
            ...(suspiciousMemoryRegister.value === undefined ? {} : { value: suspiciousMemoryRegister.value }),
            reason: `${suspiciousMemoryRegister.register} is used by the memory operand and contains a ${suspiciousMemoryRegister.suspicious === 'null-like' ? 'null-like' : 'poison-pattern'} value`,
            confidence: 'high',
          },
        }
      : {}),
  };
}

function compactFrame(assessment: FrameAssessment, role: CallChainFrame['role']): CallChainFrame {
  return {
    index: assessment.index,
    function: assessment.frame.name,
    ...(assessment.frame.moduleId === undefined ? {} : { moduleId: assessment.frame.moduleId }),
    ...(sourcePath(assessment.frame) ? { sourcePath: sourcePath(assessment.frame) } : {}),
    line: assessment.frame.line,
    role,
    projectControlled: assessment.projectControlled,
    runtimeLikely: assessment.runtimeLikely,
    score: assessment.score,
  };
}

function normalizedComparableValue(value: string): string | undefined {
  const address = parseAddress(value);
  if (address === undefined) return undefined;
  return `0x${address.toString(16)}`;
}

function buildProvenance(evidence: FrameEvidence[]): CallChainAnalysis['provenance'] {
  const values = new Map<string, Array<{ index: number; function: string; variable: string }>>();
  for (const frame of evidence) {
    for (const variable of frame.locals) {
      if (!looksPointerLike(variable)) continue;
      const normalized = normalizedComparableValue(variable.value);
      if (!normalized) continue;
      const current = values.get(normalized) ?? [];
      current.push({ index: frame.index, function: frame.frame.name, variable: variable.name });
      values.set(normalized, current);
    }
  }

  const output: CallChainAnalysis['provenance'] = [];
  for (const [value, occurrences] of values) {
    const frameIds = new Set(occurrences.map((item) => item.index));
    if (frameIds.size < 2) continue;
    const grouped = new Map<number, { index: number; function: string; variables: string[] }>();
    for (const occurrence of occurrences) {
      const existing = grouped.get(occurrence.index) ?? {
        index: occurrence.index,
        function: occurrence.function,
        variables: [],
      };
      if (!existing.variables.includes(occurrence.variable)) existing.variables.push(occurrence.variable);
      grouped.set(occurrence.index, existing);
    }
    output.push({
      value,
      frames: [...grouped.values()].sort((a, b) => a.index - b.index),
      confidence: poisonReason(value) ? 'high' : 'medium',
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

  const functionCounts = new Map<string, number>();
  for (const assessment of selection.assessments) {
    functionCounts.set(assessment.frame.name, (functionCounts.get(assessment.frame.name) ?? 0) + 1);
  }
  const repeatedFunctions = [...functionCounts.entries()]
    .filter(([, count]) => count >= 3)
    .map(([functionName, count]) => ({ function: functionName, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const firstProjectFrame = frames[selectedIndex] ?? frames[0];
  if (!firstProjectFrame) throw new Error('Unable to build call-chain analysis without a frame.');
  const projectCallerFrames = frames.filter((frame) => frame.index > selectedIndex && frame.projectControlled).slice(0, 6);
  const provenance = buildProvenance(evidence);

  const rationale: string[] = [];
  if (selectedIndex > 0) {
    rationale.push(`The first ${selectedIndex} frame(s) are outside the selected project boundary; frame ${selectedIndex} is the first likely application-controlled call site.`);
  } else {
    rationale.push('The faulting frame itself is likely application-controlled.');
  }
  if (provenance.length > 0) {
    rationale.push('The same pointer-like value is visible across multiple project frames, providing a bounded provenance trail through callers.');
  }
  if (repeatedFunctions.length > 0) {
    rationale.push('Repeated stack frames indicate recursive/re-entrant call growth that may be causally relevant.');
  }

  return {
    frames,
    firstProjectFrame,
    runtimeBoundaryDepth: selectedIndex,
    projectCallerFrames,
    repeatedFunctions,
    provenance,
    rootCauseCandidate: {
      frame: firstProjectFrame,
      confidence: selection.selected.confidence === 'high' || provenance.length > 0 ? 'high' : 'medium',
      rationale,
    },
  };
}

function primaryHypothesis(base: CrashDiagnosis): DiagnosisHypothesis | undefined {
  return base.hypotheses.find((hypothesis) => hypothesis.confidence === 'high') ?? base.hypotheses[0];
}

function suggestedChangesFor(
  base: CrashDiagnosis,
  operand: OperandAnalysis,
  callChain: CallChainAnalysis,
): string[] {
  const changes: string[] = [];
  const bound = operand.variableBindings[0];
  const faultOperand = operand.likelyFaultOperand;

  if (faultOperand && bound) {
    changes.push(`Trace ${bound.variable} (${bound.variableType ?? 'unknown type'}) from ${bound.register} at the selected project frame; it matches the register used by the faulting memory operand.`);
  } else if (faultOperand) {
    changes.push(`Trace the value loaded into ${faultOperand.register}; it is used by the current memory operand and is ${faultOperand.reason}.`);
  }

  switch (base.classification.category) {
    case 'access-violation':
    case 'segmentation-fault':
      if (base.hypotheses.some((hypothesis) => hypothesis.kind === 'invalid-lifetime')) {
        changes.push('Fix the ownership/lifetime violation at the earliest proven producer; do not only add a guard at the final dereference if the object is already stale.');
      } else {
        changes.push('Restore the pointer/reference invariant before the dereference, preferably at the producer or caller boundary that allowed the invalid value through.');
      }
      break;
    case 'divide-by-zero':
      changes.push('Restore the divisor invariant at its producer and add a validation/error path at the narrowest boundary where zero is genuinely invalid.');
      break;
    case 'stack-overflow':
      changes.push('Fix the recursion/re-entry termination condition or move excessive per-frame storage away from the stack after confirming the repeating call pattern.');
      break;
    case 'abort-or-assert':
      changes.push('Repair the violated invariant that led to abort/assert; keep the assertion unless the invariant itself is intentionally changing.');
      break;
    case 'heap-corruption':
      changes.push('Fix the first invalid write/free or ownership transition; treat the allocator crash site as potentially downstream from the original corruption.');
      break;
    case 'illegal-instruction':
      changes.push('Validate the control-flow target, function pointer/vtable/return-address provenance, and binary-symbol match before changing source logic.');
      break;
    default:
      changes.push('Apply the smallest source change that directly addresses the highest-confidence debugger evidence rather than the symptom alone.');
  }

  if (callChain.provenance.length > 0) {
    const trail = callChain.provenance[0];
    if (trail) {
      changes.push(`Use the caller trail for ${trail.value} to patch the earliest frame where the value first becomes invalid or violates its contract.`);
    }
  }

  return [...new Set(changes)].slice(0, 6);
}

function buildFixWorkflow(
  base: CrashDiagnosis,
  selection: ProjectFrameSelection,
  operand: OperandAnalysis,
  callChain: CallChainAnalysis,
): FixWorkflow {
  const frame = selection.selected.frame;
  const candidate = sourcePath(frame);
  return {
    status: 'proposal-only',
    candidateLocation: {
      function: frame.name,
      ...(candidate ? { sourcePath: candidate } : {}),
      line: frame.line,
    },
    ...(primaryHypothesis(base) ? { hypothesis: primaryHypothesis(base) } : {}),
    suggestedChanges: suggestedChangesFor(base, operand, callChain),
    phases: [
      {
        phase: 'diagnose',
        state: 'complete',
        instruction: 'Preserve the classification, selected project frame, operand/register/variable bindings, and call-chain provenance as the evidence baseline.',
      },
      {
        phase: 'fix',
        state: 'agent-action-required',
        instruction: 'Read the source around the selected project frame with normal coding tools and apply the smallest change supported by the debugger evidence.',
      },
      {
        phase: 'rebuild',
        state: 'agent-action-required',
        instruction: 'Rebuild the target with the project\'s existing build system and matching debug symbols. qwen-dap-mcp intentionally does not provide a general shell executor.',
      },
      {
        phase: 'reproduce',
        state: 'ready-after-rebuild',
        instruction: 'Run the same debug_this_crash launch/attach scenario again with workflow.stage="verify" and the returned verificationBaseline.',
      },
      {
        phase: 'verify',
        state: 'ready-after-rebuild',
        instruction: 'Treat a clean exit as strong evidence of a fix; treat the same crash category and same project location as not fixed; classify changed failures separately.',
      },
    ],
  };
}

export function createVerificationBaseline(diagnosis: IntelligentCrashDiagnosis): VerificationBaseline {
  return {
    classification: diagnosis.classification.category,
    crashLikely: diagnosis.classification.crashLikely,
    faultFunction: diagnosis.faultLocation.function,
    projectFunction: diagnosis.projectFrame.function,
    ...(diagnosis.projectFrame.sourcePath ? { projectSourcePath: diagnosis.projectFrame.sourcePath } : {}),
    projectLine: diagnosis.projectFrame.line,
    hypothesisKinds: diagnosis.hypotheses.map((hypothesis) => hypothesis.kind).slice(0, 8),
    suspiciousNames: diagnosis.suspiciousValues.map((value) => value.name).slice(0, 12),
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
      evidence: ['The reproduced scenario exited with code 0 before any crash stop was captured.'],
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
      verdict: 'fixed',
      confidence: 'medium',
      evidence: [
        `The verification stop is classified as ${current.classification.category}, not a crash.`,
        'Confirm the complete original scenario still reaches its expected successful outcome before closing the bug.',
      ],
    };
  }

  const sameCategory = current.classification.category === baseline.classification;
  const sameFunction = current.projectFrame.function === baseline.projectFunction;
  const samePath = !baseline.projectSourcePath || current.projectFrame.sourcePath === baseline.projectSourcePath;
  const sameLine = current.projectFrame.line === baseline.projectLine;
  const sharedHypothesis = current.hypotheses.some((hypothesis) => baseline.hypothesisKinds.includes(hypothesis.kind));

  if (sameCategory && sameFunction && samePath && (sameLine || sharedHypothesis)) {
    return {
      verdict: 'not-fixed',
      confidence: 'high',
      evidence: [
        `The same ${baseline.classification} crash family reproduced.`,
        `The selected project frame is still ${baseline.projectFunction}${baseline.projectSourcePath ? ` at ${baseline.projectSourcePath}` : ''}:${baseline.projectLine}.`,
        ...(sharedHypothesis ? ['At least one root-cause hypothesis kind from the baseline is still present.'] : []),
      ],
    };
  }

  return {
    verdict: 'changed-failure',
    confidence: 'medium',
    evidence: [
      `The verification run still looks crash-related (${current.classification.category}), but it no longer matches the original failure signature exactly.`,
      `Original project frame: ${baseline.projectFunction}:${baseline.projectLine}; current: ${current.projectFrame.function}:${current.projectFrame.line}.`,
      'Diagnose this as a potentially new or downstream failure rather than claiming the original fix is complete.',
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
  const projectPath = frame.source?.path ?? frame.source?.name;

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
    : `${base.summary} The first likely project-controlled frame is ${frame.name}${projectPath ? ` at ${projectPath}:${frame.line}` : ''} after ${selection.selected.index} runtime/system frame(s).`;

  const partial = {
    ...base,
    summary,
    projectFrame,
    frameSelection: selection,
    operandAnalysis,
    callChain,
    fixWorkflow: buildFixWorkflow(base, selection, operandAnalysis, callChain),
  } as Omit<IntelligentCrashDiagnosis, 'verificationBaseline'>;

  return {
    ...partial,
    verificationBaseline: createVerificationBaseline(partial as IntelligentCrashDiagnosis),
  };
}
