import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advanceAutonomousCycle,
  baselineFingerprint,
  type AutonomousAgentState,
  validateAutonomousAgentState,
} from '../src/diagnostics/autonomous-cycle.js';
import type { VerificationBaseline } from '../src/diagnostics/intelligent-diagnosis.js';

function baseline(projectFunction = 'Widget::render'): VerificationBaseline {
  return {
    classification: 'access-violation',
    crashLikely: true,
    faultFunction: 'crash_here',
    projectFunction,
    projectSourcePath: '/work/src/widget.cpp',
    projectLine: 42,
    hypothesisKinds: ['null-dereference'],
    suspiciousNames: ['widgetPtr'],
  };
}

function state(): AutonomousAgentState {
  const rootBaseline = baseline();
  const activeBaseline = baseline();
  return {
    schemaVersion: 1,
    iteration: 1,
    maxIterations: 3,
    status: 'needs-fix',
    rootBaseline,
    activeBaseline,
    rootFingerprint: baselineFingerprint(rootBaseline),
    activeFingerprint: baselineFingerprint(activeBaseline),
    history: [],
  };
}

test('serialized autonomous state validates when baselines and fingerprints agree', () => {
  assert.doesNotThrow(() => validateAutonomousAgentState(state()));
});

test('autonomous cycle rejects a tampered active fingerprint before verification advances', () => {
  const tampered = { ...state(), activeFingerprint: '0000000000000000' };

  assert.throws(
    () => advanceAutonomousCycle(tampered, {
      verdict: 'inconclusive',
      confidence: 'low',
      evidence: ['Reproduction has not reached a terminal outcome yet.'],
    }),
    /active fingerprint mismatch/i,
  );
});

test('autonomous cycle rejects baseline mutation even when the old fingerprint is preserved', () => {
  const original = state();
  const tampered = {
    ...original,
    activeBaseline: {
      ...original.activeBaseline,
      projectFunction: 'Different::function',
    },
  };

  assert.throws(
    () => validateAutonomousAgentState(tampered),
    /active fingerprint mismatch/i,
  );
});

test('autonomous state rejects impossible iteration counters', () => {
  const invalid = { ...state(), iteration: 4, maxIterations: 3 };
  assert.throws(() => validateAutonomousAgentState(invalid), /invalid autonomous agent iteration/i);
});
