import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeSnapshot } from '../src/dap/session.js';
import { analyzeRuntimeSnapshot } from '../src/diagnostics/analyze-snapshot.js';
import {
  advanceAutonomousCycle,
  baselineFingerprint,
  startAutonomousCycle,
} from '../src/diagnostics/autonomous-cycle.js';
import {
  buildIntelligentDiagnosis,
  compareVerificationBaseline,
  selectProjectFrame,
  type FrameEvidence,
  type IntelligentCrashDiagnosis,
} from '../src/diagnostics/intelligent-diagnosis.js';

function crashDiagnosis(
  functionName = 'Widget::render',
  sourcePath = '/work/src/widget.cpp',
  line = 42,
): IntelligentCrashDiagnosis {
  const frame = {
    id: 100,
    name: functionName,
    source: { name: sourcePath.split('/').pop(), path: sourcePath },
    line,
    column: 7,
    instructionPointerReference: '0x1000',
    moduleId: 'myapp',
  };
  const snapshot: RuntimeSnapshot = {
    stopped: { reason: 'exception', threadId: 1, allThreadsStopped: true },
    thread: { id: 1, name: 'main' },
    stack: [frame],
    frame,
    scopes: [],
    locals: [{ name: 'widgetPtr', value: '0x0', type: 'Widget *', variablesReference: 0 }],
    registers: [{ name: 'rax', value: '0x0', variablesReference: 0 }],
    disassembly: [{ address: '0x1000', instruction: 'mov eax, dword ptr [rax]' }],
    exception: {
      exceptionId: 'EXCEPTION_ACCESS_VIOLATION',
      description: 'Access violation reading address 0x0',
      breakMode: 'unhandled',
    },
  };
  const base = analyzeRuntimeSnapshot(snapshot);
  const selection = selectProjectFrame(snapshot.stack, { projectRoots: ['/work'] });
  const evidence: FrameEvidence[] = [{
    index: 0,
    frame,
    locals: snapshot.locals,
    registers: snapshot.registers,
    disassembly: snapshot.disassembly,
  }];
  return buildIntelligentDiagnosis(snapshot, base, selection, evidence);
}

test('autonomous cycle starts with a stable fingerprint and an executable agent action queue', () => {
  const diagnosis = crashDiagnosis();
  const decision = startAutonomousCycle(diagnosis, 4);

  assert.equal(decision.state.schemaVersion, 1);
  assert.equal(decision.state.iteration, 1);
  assert.equal(decision.state.maxIterations, 4);
  assert.equal(decision.state.status, 'needs-fix');
  assert.equal(decision.state.rootFingerprint, baselineFingerprint(diagnosis.verificationBaseline));
  assert.equal(decision.state.activeFingerprint, decision.state.rootFingerprint);
  assert.equal(decision.shouldContinue, true);
  assert.deepEqual(
    decision.nextActions.map((action) => action.type),
    ['inspect-source', 'apply-fix', 'rebuild', 'reproduce-and-verify'],
  );
});

test('inconclusive verification does not consume the fix budget or request another edit', () => {
  const diagnosis = crashDiagnosis();
  const started = startAutonomousCycle(diagnosis, 3);
  const decision = advanceAutonomousCycle(started.state, {
    verdict: 'inconclusive',
    confidence: 'low',
    evidence: ['Stopped at an ordinary breakpoint before the full reproduction finished.'],
  });

  assert.equal(decision.state.iteration, 1);
  assert.equal(decision.state.status, 'needs-reproduction');
  assert.equal(decision.shouldContinue, true);
  assert.deepEqual(decision.nextActions.map((action) => action.type), ['reproduce-and-verify']);
});

test('clean verification terminates the autonomous loop as fixed', () => {
  const diagnosis = crashDiagnosis();
  const started = startAutonomousCycle(diagnosis, 3);
  const verification = compareVerificationBaseline(
    started.state.activeBaseline,
    undefined,
    { event: 'exited', exitCode: 0 },
  );
  const decision = advanceAutonomousCycle(started.state, verification);

  assert.equal(decision.state.status, 'fixed');
  assert.equal(decision.shouldContinue, false);
  assert.match(decision.stopReason ?? '', /completed successfully/i);
  assert.deepEqual(decision.nextActions.map((action) => action.type), ['stop-and-report']);
});

test('same reproduced crash advances the iteration and eventually broadens diagnosis instead of repeating the same patch strategy', () => {
  const diagnosis = crashDiagnosis();
  const started = startAutonomousCycle(diagnosis, 4);
  const verification = compareVerificationBaseline(started.state.activeBaseline, diagnosis);

  const second = advanceAutonomousCycle(started.state, verification, diagnosis);
  assert.equal(second.state.iteration, 2);
  assert.equal(second.state.status, 'retry-fix');
  assert.equal(second.nextActions.some((action) => action.type === 'broaden-diagnosis'), false);

  const third = advanceAutonomousCycle(second.state, verification, diagnosis);
  assert.equal(third.state.iteration, 3);
  assert.equal(third.state.status, 'retry-fix');
  assert.equal(third.nextActions[0]?.type, 'broaden-diagnosis');
});

test('changed failure re-baselines the active crash while preserving the original root fingerprint', () => {
  const original = crashDiagnosis('Widget::render', '/work/src/widget.cpp', 42);
  const changed = crashDiagnosis('Scene::draw', '/work/src/scene.cpp', 73);
  const started = startAutonomousCycle(original, 4);
  const verification = compareVerificationBaseline(started.state.activeBaseline, changed);

  assert.equal(verification.verdict, 'changed-failure');
  const decision = advanceAutonomousCycle(started.state, verification, changed);

  assert.equal(decision.state.iteration, 2);
  assert.equal(decision.state.status, 'changed-failure');
  assert.equal(decision.state.rootFingerprint, started.state.rootFingerprint);
  assert.notEqual(decision.state.activeFingerprint, started.state.activeFingerprint);
  assert.equal(decision.state.activeFingerprint, baselineFingerprint(changed.verificationBaseline));
  assert.equal(decision.shouldContinue, true);
});

test('autonomous cycle stops deterministically when the fix-attempt budget is exhausted', () => {
  const diagnosis = crashDiagnosis();
  const started = startAutonomousCycle(diagnosis, 1);
  const verification = compareVerificationBaseline(started.state.activeBaseline, diagnosis);
  const decision = advanceAutonomousCycle(started.state, verification, diagnosis);

  assert.equal(decision.state.status, 'budget-exhausted');
  assert.equal(decision.shouldContinue, false);
  assert.match(decision.stopReason ?? '', /budget exhausted/i);
  assert.equal(decision.nextActions[0]?.type, 'stop-and-report');
});
