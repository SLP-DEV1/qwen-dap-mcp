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
  | 'apply-fix'
  | 'rebuild'
  | 'reproduce-and-verify'
  | 'broaden-diagnosis'
  | 'stop-and-report';

export type AutonomousAgentAction = {
  type: AutonomousAgentActionType;
  owner: 'coding-agent' | 'debugger';
  instruction: string;
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

export type AutonomousAgentDecision = {
  state: AutonomousAgentState;
  shouldContinue: boolean;
  nextActions: AutonomousAgentAction[];
  stopReason?: string;
};

function normalizedPath(value: string | undefined): string | undefined {
  return value?.replace(/\\/g, '/').toLowerCase();
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

function evidenceActions(diagnosis: IntelligentCrashDiagnosis): AutonomousAgentAction[] {
  return [
    {
      type: 'collect-evidence',
      owner: 'debugger',
      instruction:
        'Do not patch yet. Re-run diagnosis with explicit analysis.projectRoots/projectModules when available, a deeper bounded stack, and enough callerDepth to resolve a source-backed project frame and at least medium-confidence causal evidence.',
      evidence: [
        `projectFrame confidence=${diagnosis.projectFrame.confidence}`,
        `project source=${diagnosis.projectFrame.sourcePath ?? 'missing'}`,
        `root-cause confidence=${diagnosis.callChain.rootCauseCandidate.confidence}`,
      ],
    },
  ];
}

function fixActions(
  diagnosis: IntelligentCrashDiagnosis,
  state: AutonomousAgentState,
  broaden = false,
): AutonomousAgentAction[] {
  const location = `${diagnosis.projectFrame.sourcePath ?? diagnosis.projectFrame.function}:${diagnosis.projectFrame.line}`;
  const evidence = [
    `active crash fingerprint=${state.activeFingerprint}`,
    `root-cause candidate=${diagnosis.callChain.rootCauseCandidate.frame.function}`,
    `root-cause confidence=${diagnosis.callChain.rootCauseCandidate.confidence}`,
    ...diagnosis.fixWorkflow.suggestedChanges.slice(0, 3),
  ];

  return [
    ...(broaden
      ? [{
          type: 'broaden-diagnosis' as const,
          owner: 'debugger' as const,
          instruction:
            'The same failure signature survived multiple fix attempts. Before editing again, broaden the evidence: inspect the earliest provenance-producing caller, increase bounded caller depth, and prefer a producer/ownership fix over another guard at the final dereference.',
          evidence,
        }]
      : []),
    {
      type: 'inspect-source',
      owner: 'coding-agent',
      instruction: `Read the source around ${location} and the earliest evidenced producer/caller before changing code. Preserve the debugger evidence as the reason for the edit.`,
      evidence,
    },
    {
      type: 'apply-fix',
      owner: 'coding-agent',
      instruction:
        'Apply the smallest source change that restores the violated invariant at the earliest evidenced producer or ownership boundary. Avoid masking the final crash site when the evidence points upstream.',
      evidence: diagnosis.fixWorkflow.suggestedChanges.slice(0, 6),
    },
    {
      type: 'rebuild',
      owner: 'coding-agent',
      instruction:
        'Rebuild with the project\'s normal authorized build workflow and matching debug symbols. Do not use qwen-dap-mcp as a general command runner.',
    },
    {
      type: 'reproduce-and-verify',
      owner: 'debugger',
      instruction:
        'Repeat the exact original debug_this_crash scenario with workflow.stage="autonomous" and pass the returned workflow.autonomousAgent.state unchanged. The MCP will compare the reproduced outcome, advance the iteration, and decide whether to stop, retry, or re-baseline a changed failure.',
    },
  ];
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
    state,
    shouldContinue: true,
    nextActions: ready ? fixActions(diagnosis, state) : evidenceActions(diagnosis),
  };
}

function sameFailedFingerprintCount(state: AutonomousAgentState): number {
  return state.history.filter((item) =>
    item.phase === 'verification'
      && item.verdict === 'not-fixed'
      && item.fingerprint === state.activeFingerprint,
  ).length;
}

export function advanceAutonomousCycle(
  previous: AutonomousAgentState,
  verification: VerificationResult,
  currentDiagnosis?: IntelligentCrashDiagnosis,
): AutonomousAgentDecision {
  if (previous.schemaVersion !== 1) {
    throw new Error(`Unsupported autonomous agent state schema version: ${previous.schemaVersion}`);
  }
  const historyEntry = verificationHistory(previous, verification, currentDiagnosis);
  const history = [...previous.history, historyEntry].slice(-24);

  if (verification.verdict === 'fixed') {
    const state: AutonomousAgentState = { ...previous, status: 'fixed', history };
    return {
      state,
      shouldContinue: false,
      stopReason: 'The original reproduction completed successfully without reproducing the active crash signature.',
      nextActions: [{
        type: 'stop-and-report',
        owner: 'coding-agent',
        instruction: 'Stop the autonomous loop. Report the debugger evidence, source change, rebuild result, and clean verification outcome.',
        evidence: verification.evidence,
      }],
    };
  }

  if (verification.verdict === 'inconclusive') {
    const state: AutonomousAgentState = { ...previous, status: 'needs-reproduction', history };
    return {
      state,
      shouldContinue: true,
      nextActions: [{
        type: 'reproduce-and-verify',
        owner: 'debugger',
        instruction:
          'Do not edit again yet. Continue or repeat the complete original reproduction until it reaches either a crash diagnosis or a clean terminal outcome, then call workflow.stage="autonomous" again with this state.',
        evidence: verification.evidence,
      }],
    };
  }

  if (previous.iteration >= previous.maxIterations) {
    const state: AutonomousAgentState = { ...previous, status: 'budget-exhausted', history };
    return {
      state,
      shouldContinue: false,
      stopReason: `Autonomous fix budget exhausted after ${previous.maxIterations} attempted iteration(s).`,
      nextActions: [{
        type: 'stop-and-report',
        owner: 'coding-agent',
        instruction:
          'Stop editing automatically. Report the iteration history and surviving/changed crash fingerprints so a human can decide whether to widen the investigation.',
        evidence: verification.evidence,
      }],
    };
  }

  if (verification.verdict === 'changed-failure') {
    if (!currentDiagnosis || !currentDiagnosis.classification.crashLikely) {
      const state: AutonomousAgentState = { ...previous, status: 'blocked', history };
      return {
        state,
        shouldContinue: false,
        stopReason: 'The failure changed but no trustworthy replacement crash diagnosis is available for re-baselining.',
        nextActions: [{
          type: 'stop-and-report',
          owner: 'coding-agent',
          instruction: 'Stop the loop and report the changed failure. Do not guess a new source fix without a source-backed crash diagnosis.',
          evidence: verification.evidence,
        }],
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
      state,
      shouldContinue: true,
      nextActions: ready
        ? fixActions(currentDiagnosis, state)
        : evidenceActions(currentDiagnosis),
    };
  }

  if (!currentDiagnosis) {
    const state: AutonomousAgentState = { ...previous, status: 'blocked', history };
    return {
      state,
      shouldContinue: false,
      stopReason: 'The crash reproduced but no stopped-state diagnosis is available for selecting the next evidence-backed fix.',
      nextActions: [{
        type: 'stop-and-report',
        owner: 'coding-agent',
        instruction: 'Stop automatic editing and report the reproduced failure plus missing stopped-state evidence.',
        evidence: verification.evidence,
      }],
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
      state: interimState,
      shouldContinue: true,
      nextActions: evidenceActions(currentDiagnosis),
    };
  }

  const broaden = sameFailedFingerprintCount({ ...interimState, history }) >= 2;
  return {
    state: interimState,
    shouldContinue: true,
    nextActions: fixActions(currentDiagnosis, interimState, broaden),
  };
}
