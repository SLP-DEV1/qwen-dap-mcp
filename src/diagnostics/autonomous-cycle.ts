import { createHash } from 'node:crypto';

import type {
  IntelligentCrashDiagnosis,
  VerificationBaseline,
  VerificationResult,
} from './intelligent-diagnosis.js';

export type AutonomousAgentStatus =
  | 'needs-evidence'
  | 'needs-fix'
  | 'retry-fix'
  | 'needs-reproduction'
  | 'changed-failure'
  | 'fixed'
  | 'budget-exhausted'
  | 'blocked';

export type AutonomousAgentActionType =
  | 'collect-evidence'
  | 'inspect-source'
  | 'propose-fix'
  | 'apply-fix'
  | 'build'
  | 'reproduce'
  | 'verify'
  | 'rollback'
  | 'broaden-diagnosis'
  | 'stop-and-report';

export type AutonomousAgentActionStatus = 'pending' | 'satisfied' | 'blocked' | 'skipped';

export type AutonomousAgentAction = {
  id: string;
  type: AutonomousAgentActionType;
  owner: 'coding-agent' | 'debugger';
  status: AutonomousAgentActionStatus;
  instruction: string;
  requires: string[];
  input: Record<string, unknown>;
  expectedResult: {
    description: string;
    successCriteria: string[];
  };
  evidence?: string[];
};

export type AutonomousAgentHistoryEntry = {
  iteration: number;
  phase: 'diagnosis' | 'verification';
  fingerprint: string;
  verdict?: VerificationResult['verdict'];
  confidence?: VerificationResult['confidence'];
  projectFunction?: string;
  projectSourcePath?: string;
  projectLine?: number;
  summary: string;
};

export type AutonomousAgentState = {
  schemaVersion: 1;
  iteration: number;
  maxIterations: number;
  status: AutonomousAgentStatus;
  rootBaseline: VerificationBaseline;
  activeBaseline: VerificationBaseline;
  rootFingerprint: string;
  activeFingerprint: string;
  history: AutonomousAgentHistoryEntry[];
};

export type RootCauseBacktrack = {
  target: {
    register?: string;
    variable?: string;
    value?: string;
    instruction?: string;
  };
  runtimeTrail: Array<{
    frameIndex: number;
    function: string;
    variables: string[];
    value?: string;
    role: 'consumer' | 'propagated' | 'producer-candidate';
  }>;
  producerCandidates: Array<{
    frameIndex: number;
    function: string;
    sourcePath?: string;
    line: number;
    reason: string;
  }>;
  confidence: 'low' | 'medium' | 'high';
  limitation: string;
};

export type VerificationQuality = {
  score: number;
  grade: 'weak' | 'moderate' | 'strong';
  checks: {
    reproduction: 'complete' | 'incomplete';
    rootCrash: 'gone' | 'reproduced' | 'changed' | 'unknown';
    newCrash: 'none-observed' | 'present' | 'unknown';
    build: 'external-unverified';
    tests: 'external-unverified';
    sameInputs: 'external-unverified';
  };
  evidence: string[];
  note: string;
};

export type AutonomousAgentDecision = {
  protocolVersion: 2;
  state: AutonomousAgentState;
  shouldContinue: boolean;
  nextActions: AutonomousAgentAction[];
  rootCauseBacktrack?: RootCauseBacktrack;
  verificationQuality?: VerificationQuality;
  stopReason?: string;
};

function normalizedPath(value: string | undefined): string | undefined {
  return value?.replace(/\\/g, '/').toLowerCase();
}

function normalizedValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const compact = value.trim().toLowerCase().replace(/[`'_\s]/g, '');
  const match = /0x([0-9a-f]+)/i.exec(compact);
  if (match?.[1]) {
    try { return `0x${BigInt(`0x${match[1]}`).toString(16)}`; } catch { return compact; }
  }
  if (/^\d+$/.test(compact)) {
    try { return `0x${BigInt(compact).toString(16)}`; } catch { return compact; }
  }
  return compact;
}

export function baselineFingerprint(baseline: VerificationBaseline): string {
  const canonical = {
    classification: baseline.classification,
    crashLikely: baseline.crashLikely,
    faultFunction: baseline.faultFunction,
    projectFunction: baseline.projectFunction,
    projectSourcePath: normalizedPath(baseline.projectSourcePath),
    projectLine: baseline.projectLine,
    hypothesisKinds: [...baseline.hypothesisKinds].sort(),
    suspiciousNames: [...baseline.suspiciousNames].sort(),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

export function validateAutonomousAgentState(state: AutonomousAgentState): void {
  if (state.schemaVersion !== 1) {
    throw new Error(`Unsupported autonomous agent state schema version: ${state.schemaVersion}`);
  }
  if (!Number.isInteger(state.maxIterations) || state.maxIterations < 1 || state.maxIterations > 10) {
    throw new Error(`Invalid autonomous agent maxIterations: ${state.maxIterations}. Expected an integer from 1 to 10.`);
  }
  if (!Number.isInteger(state.iteration) || state.iteration < 1 || state.iteration > state.maxIterations) {
    throw new Error(
      `Invalid autonomous agent iteration: ${state.iteration}. Expected an integer from 1 to maxIterations (${state.maxIterations}).`,
    );
  }
  if (state.history.length > 24) {
    throw new Error(`Invalid autonomous agent history length: ${state.history.length}. Maximum is 24 entries.`);
  }

  const expectedRootFingerprint = baselineFingerprint(state.rootBaseline);
  if (state.rootFingerprint !== expectedRootFingerprint) {
    throw new Error(
      `Autonomous agent state root fingerprint mismatch: expected ${expectedRootFingerprint}, got ${state.rootFingerprint}.`,
    );
  }

  const expectedActiveFingerprint = baselineFingerprint(state.activeBaseline);
  if (state.activeFingerprint !== expectedActiveFingerprint) {
    throw new Error(
      `Autonomous agent state active fingerprint mismatch: expected ${expectedActiveFingerprint}, got ${state.activeFingerprint}.`,
    );
  }
}

function boundedMaxIterations(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 3;
  return Math.min(10, Math.max(1, Math.trunc(value)));
}

function diagnosisHistory(
  diagnosis: IntelligentCrashDiagnosis,
  fingerprint: string,
): AutonomousAgentHistoryEntry {
  return {
    iteration: 0,
    phase: 'diagnosis',
    fingerprint,
    projectFunction: diagnosis.projectFrame.function,
    ...(diagnosis.projectFrame.sourcePath ? { projectSourcePath: diagnosis.projectFrame.sourcePath } : {}),
    projectLine: diagnosis.projectFrame.line,
    summary: diagnosis.summary,
  };
}

function verificationHistory(
  state: AutonomousAgentState,
  verification: VerificationResult,
  diagnosis?: IntelligentCrashDiagnosis,
): AutonomousAgentHistoryEntry {
  const fingerprint = diagnosis
    ? baselineFingerprint(diagnosis.verificationBaseline)
    : state.activeFingerprint;
  return {
    iteration: state.iteration,
    phase: 'verification',
    fingerprint,
    verdict: verification.verdict,
    confidence: verification.confidence,
    ...(diagnosis
      ? {
          projectFunction: diagnosis.projectFrame.function,
          ...(diagnosis.projectFrame.sourcePath ? { projectSourcePath: diagnosis.projectFrame.sourcePath } : {}),
          projectLine: diagnosis.projectFrame.line,
        }
      : {}),
    summary: verification.evidence.join(' '),
  };
}

function evidenceReady(diagnosis: IntelligentCrashDiagnosis): boolean {
  if (!diagnosis.classification.crashLikely) return false;
  if (!diagnosis.projectFrame.sourcePath) return false;
  if (diagnosis.projectFrame.confidence === 'low') return false;
  return diagnosis.hypotheses.some((item) => item.confidence === 'high' || item.confidence === 'medium')
    || diagnosis.callChain.rootCauseCandidate.confidence === 'high';
}

function action(
  iteration: number,
  type: AutonomousAgentActionType,
  owner: AutonomousAgentAction['owner'],
  instruction: string,
  options: {
    requires?: string[];
    input?: Record<string, unknown>;
    expected: string;
    successCriteria: string[];
    evidence?: string[];
    status?: AutonomousAgentActionStatus;
  },
): AutonomousAgentAction {
  return {
    id: `${iteration}:${type}`,
    type,
    owner,
    status: options.status ?? 'pending',
    instruction,
    requires: options.requires ?? [],
    input: options.input ?? {},
    expectedResult: {
      description: options.expected,
      successCriteria: options.successCriteria,
    },
    ...(options.evidence ? { evidence: options.evidence } : {}),
  };
}

export function buildRootCauseBacktrack(diagnosis: IntelligentCrashDiagnosis): RootCauseBacktrack {
  const operand = diagnosis.operandAnalysis.likelyFaultOperand;
  const binding = diagnosis.operandAnalysis.variableBindings[0];
  const targetValue = normalizedValue(operand?.value ?? binding?.variableValue);
  const matchingTrail = targetValue
    ? diagnosis.callChain.provenance.find((item) => normalizedValue(item.value) === targetValue)
    : undefined;

  const runtimeTrail: RootCauseBacktrack['runtimeTrail'] = [];
  if (matchingTrail) {
    const frames = [...matchingTrail.frames].sort((a, b) => a.index - b.index);
    frames.forEach((frame, index) => {
      runtimeTrail.push({
        frameIndex: frame.index,
        function: frame.function,
        variables: frame.variables,
        value: matchingTrail.value,
        role: index === 0
          ? 'consumer'
          : index === frames.length - 1
            ? 'producer-candidate'
            : 'propagated',
      });
    });
  } else if (binding) {
    runtimeTrail.push({
      frameIndex: diagnosis.projectFrame.index,
      function: diagnosis.projectFrame.function,
      variables: [binding.variable],
      ...(targetValue ? { value: targetValue } : {}),
      role: 'consumer',
    });
  }

  const trailIndexes = new Set(runtimeTrail.map((item) => item.frameIndex));
  const producerCandidates = diagnosis.callChain.frames
    .filter((frame) => frame.projectControlled && frame.index >= diagnosis.projectFrame.index)
    .filter((frame) => frame.index !== diagnosis.projectFrame.index || runtimeTrail.length === 0)
    .sort((a, b) => b.index - a.index)
    .slice(0, 5)
    .map((frame) => ({
      frameIndex: frame.index,
      function: frame.function,
      ...(frame.sourcePath ? { sourcePath: frame.sourcePath } : {}),
      line: frame.line,
      reason: trailIndexes.has(frame.index)
        ? 'The same distinctive runtime value is visible in this caller frame; inspect where it was produced or passed onward.'
        : 'Project-controlled caller on the bounded path; inspect assignments/returns that feed the crashing consumer.',
    }));

  const confidence: RootCauseBacktrack['confidence'] = matchingTrail?.confidence === 'high'
    ? 'high'
    : matchingTrail || binding
      ? 'medium'
      : 'low';

  return {
    target: {
      ...(operand?.register ? { register: operand.register } : {}),
      ...(binding?.variable ? { variable: binding.variable } : {}),
      ...(targetValue ? { value: targetValue } : {}),
      ...(diagnosis.operandAnalysis.rawInstruction ? { instruction: diagnosis.operandAnalysis.rawInstruction } : {}),
    },
    runtimeTrail,
    producerCandidates,
    confidence,
    limitation:
      'This is runtime provenance, not static source dataflow. Exact assignments/returns must be confirmed by reading the listed source frames before editing.',
  };
}

export function verificationQuality(verification: VerificationResult): VerificationQuality {
  let score = 25;
  let reproduction: VerificationQuality['checks']['reproduction'] = 'incomplete';
  let rootCrash: VerificationQuality['checks']['rootCrash'] = 'unknown';
  let newCrash: VerificationQuality['checks']['newCrash'] = 'unknown';

  switch (verification.verdict) {
    case 'fixed':
      score = verification.confidence === 'high' ? 75 : 60;
      reproduction = 'complete';
      rootCrash = 'gone';
      newCrash = 'none-observed';
      break;
    case 'not-fixed':
      score = verification.confidence === 'high' ? 85 : 70;
      reproduction = 'complete';
      rootCrash = 'reproduced';
      newCrash = 'unknown';
      break;
    case 'changed-failure':
      score = verification.confidence === 'high' ? 75 : 65;
      reproduction = 'complete';
      rootCrash = 'changed';
      newCrash = 'present';
      break;
    case 'inconclusive':
      score = verification.confidence === 'medium' ? 40 : 25;
      break;
  }

  const grade: VerificationQuality['grade'] = score >= 75 ? 'strong' : score >= 50 ? 'moderate' : 'weak';
  return {
    score,
    grade,
    checks: {
      reproduction,
      rootCrash,
      newCrash,
      build: 'external-unverified',
      tests: 'external-unverified',
      sameInputs: 'external-unverified',
    },
    evidence: verification.evidence,
    note:
      'The score measures debugger evidence only. Build success, project tests and exact reproduction inputs remain external to qwen-dap-mcp and must be reported by the coding/build agent before claiming end-to-end verification.',
  };
}

function evidenceActions(diagnosis: IntelligentCrashDiagnosis, iteration: number): AutonomousAgentAction[] {
  const evidence = [
    `projectFrame confidence=${diagnosis.projectFrame.confidence}`,
    `project source=${diagnosis.projectFrame.sourcePath ?? 'missing'}`,
    `root-cause confidence=${diagnosis.callChain.rootCauseCandidate.confidence}`,
  ];
  return [action(
    iteration,
    'collect-evidence',
    'debugger',
    'Do not patch yet. Re-run diagnosis with explicit project roots/modules, a deeper bounded stack, and enough caller depth to resolve source-backed causal evidence.',
    {
      expected: 'A source-backed project frame plus at least medium-confidence causal evidence.',
      successCriteria: [
        'projectFrame.sourcePath is present',
        'projectFrame confidence is medium or high',
        'at least one causal hypothesis or backtrack candidate is medium/high confidence',
      ],
      evidence,
    },
  )];
}

function fixActions(
  diagnosis: IntelligentCrashDiagnosis,
  state: AutonomousAgentState,
  broaden = false,
): AutonomousAgentAction[] {
  const iteration = state.iteration;
  const location = `${diagnosis.projectFrame.sourcePath ?? diagnosis.projectFrame.function}:${diagnosis.projectFrame.line}`;
  const backtrack = buildRootCauseBacktrack(diagnosis);
  const evidence = [
    `active crash fingerprint=${state.activeFingerprint}`,
    `root-cause candidate=${diagnosis.callChain.rootCauseCandidate.frame.function}`,
    `root-cause confidence=${diagnosis.callChain.rootCauseCandidate.confidence}`,
    `runtime backtrack confidence=${backtrack.confidence}`,
    ...diagnosis.fixWorkflow.suggestedChanges.slice(0, 3),
  ];

  const output: AutonomousAgentAction[] = [];
  if (broaden) {
    output.push(action(
      iteration,
      'broaden-diagnosis',
      'debugger',
      'The same failure signature survived multiple fix attempts. Broaden evidence around the earliest producer candidate before editing again.',
      {
        expected: 'A revised causal path that explains why the previous fix did not remove the active fingerprint.',
        successCriteria: ['inspect earlier producer/caller frames', 'prefer ownership/producer evidence over another final-site guard'],
        evidence,
      },
    ));
  }

  const broadenId = broaden ? `${iteration}:broaden-diagnosis` : undefined;
  const inspect = action(
    iteration,
    'inspect-source',
    'coding-agent',
    `Read source around ${location} and the earliest runtime backtrack producer candidates before changing code.`,
    {
      requires: broadenId ? [broadenId] : [],
      input: {
        location,
        producerCandidates: backtrack.producerCandidates,
        runtimeTrail: backtrack.runtimeTrail,
      },
      expected: 'Source evidence connecting the crashing consumer to the earliest plausible producer/ownership boundary.',
      successCriteria: ['identify the violated invariant', 'confirm or reject the runtime producer candidate in source'],
      evidence,
    },
  );
  output.push(inspect);

  const propose = action(
    iteration,
    'propose-fix',
    'coding-agent',
    'Form one minimal evidence-backed fix hypothesis before editing. Prefer the earliest confirmed producer or ownership boundary.',
    {
      requires: [inspect.id],
      input: { suggestedChanges: diagnosis.fixWorkflow.suggestedChanges.slice(0, 6) },
      expected: 'A small patch plan tied to the debugger evidence and a clear invariant to restore.',
      successCriteria: ['names the source location to change', 'explains why this change should remove the active crash fingerprint'],
      evidence,
    },
  );
  output.push(propose);

  const apply = action(
    iteration,
    'apply-fix',
    'coding-agent',
    'Apply the proposed minimal source change. Avoid masking the final crash site when evidence points upstream.',
    {
      requires: [propose.id],
      expected: 'A focused source patch implementing the evidence-backed invariant repair.',
      successCriteria: ['patch is limited to the diagnosed cause', 'no unrelated behavior is changed'],
      evidence: diagnosis.fixWorkflow.suggestedChanges.slice(0, 6),
    },
  );
  output.push(apply);

  const build = action(
    iteration,
    'build',
    'coding-agent',
    'Rebuild with the project\'s normal authorized build workflow and matching debug symbols.',
    {
      requires: [apply.id],
      expected: 'A successful build of the patched program with symbols matching the reproduced binary.',
      successCriteria: ['build exits successfully', 'debug symbols correspond to the rebuilt executable'],
    },
  );
  output.push(build);

  const reproduce = action(
    iteration,
    'reproduce',
    'debugger',
    'Repeat the exact original debug_this_crash scenario and pass workflow.autonomousAgent.state unchanged.',
    {
      requires: [build.id],
      input: { activeFingerprint: state.activeFingerprint, rootFingerprint: state.rootFingerprint },
      expected: 'A complete terminal outcome or a stopped-state crash diagnosis from the same scenario.',
      successCriteria: ['same reproduction path is exercised', 'run reaches crash diagnosis or clean terminal exit'],
    },
  );
  output.push(reproduce);

  output.push(action(
    iteration,
    'verify',
    'debugger',
    'Compare the reproduced outcome with the active verification baseline and decide fixed/not-fixed/changed/inconclusive.',
    {
      requires: [reproduce.id],
      expected: 'A debugger-backed verification verdict and quality score.',
      successCriteria: ['active fingerprint comparison completed', 'clean exit is required for strong fixed evidence'],
    },
  ));

  return output;
}

export function startAutonomousCycle(
  diagnosis: IntelligentCrashDiagnosis,
  maxIterations?: number,
): AutonomousAgentDecision {
  const baseline = diagnosis.verificationBaseline;
  const fingerprint = baselineFingerprint(baseline);
  const ready = evidenceReady(diagnosis);
  const state: AutonomousAgentState = {
    schemaVersion: 1,
    iteration: 1,
    maxIterations: boundedMaxIterations(maxIterations),
    status: ready ? 'needs-fix' : 'needs-evidence',
    rootBaseline: baseline,
    activeBaseline: baseline,
    rootFingerprint: fingerprint,
    activeFingerprint: fingerprint,
    history: [diagnosisHistory(diagnosis, fingerprint)],
  };

  return {
    protocolVersion: 2,
    state,
    shouldContinue: true,
    nextActions: ready ? fixActions(diagnosis, state) : evidenceActions(diagnosis, state.iteration),
    rootCauseBacktrack: buildRootCauseBacktrack(diagnosis),
  };
}

function sameFailedFingerprintCount(state: AutonomousAgentState): number {
  return state.history.filter((item) =>
    item.phase === 'verification'
      && item.verdict === 'not-fixed'
      && item.fingerprint === state.activeFingerprint,
  ).length;
}

function stopAction(
  state: AutonomousAgentState,
  instruction: string,
  evidence: string[],
): AutonomousAgentAction {
  return action(state.iteration, 'stop-and-report', 'coding-agent', instruction, {
    expected: 'A final evidence report with no further autonomous source edits.',
    successCriteria: ['report preserves fingerprints and verification evidence'],
    evidence,
  });
}

export function advanceAutonomousCycle(
  previous: AutonomousAgentState,
  verification: VerificationResult,
  currentDiagnosis?: IntelligentCrashDiagnosis,
): AutonomousAgentDecision {
  validateAutonomousAgentState(previous);

  const historyEntry = verificationHistory(previous, verification, currentDiagnosis);
  const history = [...previous.history, historyEntry].slice(-24);
  const quality = verificationQuality(verification);
  const backtrack = currentDiagnosis ? buildRootCauseBacktrack(currentDiagnosis) : undefined;

  if (verification.verdict === 'fixed') {
    const state: AutonomousAgentState = { ...previous, status: 'fixed', history };
    return {
      protocolVersion: 2,
      state,
      shouldContinue: false,
      stopReason: 'The original reproduction completed successfully without reproducing the active crash signature.',
      nextActions: [stopAction(
        state,
        'Stop the autonomous loop. Report debugger evidence, source change, external build/test results, and the clean verification outcome.',
        verification.evidence,
      )],
      ...(backtrack ? { rootCauseBacktrack: backtrack } : {}),
      verificationQuality: quality,
    };
  }

  if (verification.verdict === 'inconclusive') {
    const state: AutonomousAgentState = { ...previous, status: 'needs-reproduction', history };
    const reproduce = action(
      state.iteration,
      'reproduce',
      'debugger',
      'Do not edit again. Continue or repeat the complete original reproduction until it reaches a crash diagnosis or clean terminal outcome.',
      {
        input: { activeFingerprint: state.activeFingerprint },
        expected: 'A complete crash or clean-exit reproduction.',
        successCriteria: ['do not consume another fix iteration', 'reach terminal or crash state'],
        evidence: verification.evidence,
      },
    );
    return {
      protocolVersion: 2,
      state,
      shouldContinue: true,
      nextActions: [
        reproduce,
        action(state.iteration, 'verify', 'debugger', 'Verify only after the reproduction completes.', {
          requires: [reproduce.id],
          expected: 'A conclusive fingerprint comparison.',
          successCriteria: ['verdict is fixed, not-fixed, or changed-failure'],
        }),
      ],
      ...(backtrack ? { rootCauseBacktrack: backtrack } : {}),
      verificationQuality: quality,
    };
  }

  if (previous.iteration >= previous.maxIterations) {
    const state: AutonomousAgentState = { ...previous, status: 'budget-exhausted', history };
    return {
      protocolVersion: 2,
      state,
      shouldContinue: false,
      stopReason: `Autonomous fix budget exhausted after ${previous.maxIterations} attempted iteration(s).`,
      nextActions: [stopAction(
        state,
        'Stop editing automatically. Report the iteration history and surviving/changed fingerprints for human review.',
        verification.evidence,
      )],
      ...(backtrack ? { rootCauseBacktrack: backtrack } : {}),
      verificationQuality: quality,
    };
  }

  if (verification.verdict === 'changed-failure') {
    if (!currentDiagnosis || !currentDiagnosis.classification.crashLikely) {
      const state: AutonomousAgentState = { ...previous, status: 'blocked', history };
      return {
        protocolVersion: 2,
        state,
        shouldContinue: false,
        stopReason: 'The failure changed but no trustworthy replacement crash diagnosis is available for re-baselining.',
        nextActions: [stopAction(
          state,
          'Stop the loop and report the changed failure. Do not guess a new source fix without source-backed crash evidence.',
          verification.evidence,
        )],
        verificationQuality: quality,
      };
    }

    const nextBaseline = currentDiagnosis.verificationBaseline;
    const nextFingerprint = baselineFingerprint(nextBaseline);
    const nextIteration = previous.iteration + 1;
    const ready = evidenceReady(currentDiagnosis);
    const state: AutonomousAgentState = {
      ...previous,
      iteration: nextIteration,
      status: ready ? 'changed-failure' : 'needs-evidence',
      activeBaseline: nextBaseline,
      activeFingerprint: nextFingerprint,
      history,
    };
    return {
      protocolVersion: 2,
      state,
      shouldContinue: true,
      nextActions: ready
        ? fixActions(currentDiagnosis, state)
        : evidenceActions(currentDiagnosis, state.iteration),
      rootCauseBacktrack: buildRootCauseBacktrack(currentDiagnosis),
      verificationQuality: quality,
    };
  }

  if (!currentDiagnosis) {
    const state: AutonomousAgentState = { ...previous, status: 'blocked', history };
    return {
      protocolVersion: 2,
      state,
      shouldContinue: false,
      stopReason: 'The crash reproduced but no stopped-state diagnosis is available for selecting the next evidence-backed fix.',
      nextActions: [stopAction(
        state,
        'Stop automatic editing and report the reproduced failure plus missing stopped-state evidence.',
        verification.evidence,
      )],
      verificationQuality: quality,
    };
  }

  const nextIteration = previous.iteration + 1;
  const nextBaseline = currentDiagnosis.verificationBaseline;
  const nextFingerprint = baselineFingerprint(nextBaseline);
  const interimState: AutonomousAgentState = {
    ...previous,
    iteration: nextIteration,
    status: evidenceReady(currentDiagnosis) ? 'retry-fix' : 'needs-evidence',
    activeBaseline: nextBaseline,
    activeFingerprint: nextFingerprint,
    history,
  };

  if (!evidenceReady(currentDiagnosis)) {
    return {
      protocolVersion: 2,
      state: interimState,
      shouldContinue: true,
      nextActions: evidenceActions(currentDiagnosis, interimState.iteration),
      rootCauseBacktrack: buildRootCauseBacktrack(currentDiagnosis),
      verificationQuality: quality,
    };
  }

  const broaden = sameFailedFingerprintCount({ ...interimState, history }) >= 2;
  return {
    protocolVersion: 2,
    state: interimState,
    shouldContinue: true,
    nextActions: fixActions(currentDiagnosis, interimState, broaden),
    rootCauseBacktrack: buildRootCauseBacktrack(currentDiagnosis),
    verificationQuality: quality,
  };
}
