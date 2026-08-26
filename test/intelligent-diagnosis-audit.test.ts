import assert from 'node:assert/strict';
import test from 'node:test';
import type { DebugProtocol } from '@vscode/debugprotocol';

import type { RuntimeSnapshot } from '../src/dap/session.js';
import { analyzeRuntimeSnapshot } from '../src/diagnostics/analyze-snapshot.js';
import {
  advanceAutonomousCycle,
  baselineFingerprint,
  refreshAutonomousEvidence,
  startAutonomousCycle,
} from '../src/diagnostics/autonomous-cycle.js';
import {
  analyzeCallChain,
  analyzeInstructionOperands,
  buildIntelligentDiagnosis,
  compareVerificationBaseline,
  selectProjectFrame,
  type FrameEvidence,
  type IntelligentCrashDiagnosis,
} from '../src/diagnostics/intelligent-diagnosis.js';

function crashDiagnosis(sourcePath?: string, breakMode: 'always' | 'unhandled' = 'unhandled'): IntelligentCrashDiagnosis {
  const frame: DebugProtocol.StackFrame = {
    id: 1,
    name: 'Widget::render',
    ...(sourcePath ? { source: { name: 'widget.cpp', path: sourcePath } } : {}),
    line: 42,
    column: 3,
    instructionPointerReference: '0x1000',
    moduleId: sourcePath ? 'app' : undefined,
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
      exceptionId: breakMode === 'unhandled' ? 'EXCEPTION_ACCESS_VIOLATION' : 'MY_EXCEPTION',
      description: breakMode === 'unhandled' ? 'Access violation reading address 0' : 'configured exception stop',
      breakMode,
    },
  };
  const base = analyzeRuntimeSnapshot(snapshot);
  const selection = selectProjectFrame(snapshot.stack, sourcePath ? { projectRoots: [sourcePath.split('/').slice(0, -1).join('/') || '/'] } : {});
  const evidence: FrameEvidence[] = [{
    index: 0,
    frame,
    locals: snapshot.locals,
    registers: snapshot.registers,
    disassembly: snapshot.disassembly,
  }];
  return buildIntelligentDiagnosis(snapshot, base, selection, evidence);
}

test('POSIX path case remains significant for verification and fingerprints', () => {
  const original = crashDiagnosis('/Project/src/widget.cpp');
  const changedCase = crashDiagnosis('/project/src/widget.cpp');

  const verification = compareVerificationBaseline(original.verificationBaseline, changedCase);
  assert.equal(verification.verdict, 'changed-failure');
  assert.notEqual(
    baselineFingerprint(original.verificationBaseline),
    baselineFingerprint(changedCase.verificationBaseline),
  );
});

test('zero x86 index register is not promoted to a null-pointer fault operand', () => {
  const frame: DebugProtocol.StackFrame = {
    id: 1,
    name: 'lookup',
    line: 1,
    column: 1,
    instructionPointerReference: '0x1000',
  };
  const analysis = analyzeInstructionOperands({
    index: 0,
    frame,
    locals: [{ name: 'index', value: '0', type: 'size_t', variablesReference: 0 }],
    registers: [
      { name: 'rax', value: '0x100000', variablesReference: 0 },
      { name: 'rcx', value: '0x0', variablesReference: 0 },
    ],
    disassembly: [{ address: '0x1000', instruction: 'mov eax, dword ptr [rax + rcx*4]' }],
  });

  assert.equal(analysis.likelyFaultOperand, undefined);
});

test('zero x86 base register remains strong null-dereference evidence', () => {
  const frame: DebugProtocol.StackFrame = {
    id: 1,
    name: 'lookup',
    line: 1,
    column: 1,
    instructionPointerReference: '0x1000',
  };
  const analysis = analyzeInstructionOperands({
    index: 0,
    frame,
    locals: [{ name: 'ptr', value: '0x0', type: 'Widget *', variablesReference: 0 }],
    registers: [{ name: 'rax', value: '0x0', variablesReference: 0 }],
    disassembly: [{ address: '0x1000', instruction: 'mov eax, dword ptr [rax]' }],
  });

  assert.equal(analysis.likelyFaultOperand?.register, 'rax');
  assert.equal(analysis.referencedRegisters[0]?.memoryRole, 'base');
});

test('configured first-chance exception does not produce an edit/rebuild workflow', () => {
  const diagnosis = crashDiagnosis('/work/src/widget.cpp', 'always');

  assert.equal(diagnosis.classification.crashLikely, false);
  assert.equal(diagnosis.fixWorkflow.status, 'evidence-required');
  assert.equal(diagnosis.fixWorkflow.phases.find((item) => item.phase === 'fix')?.state, 'not-applicable');
  assert.equal(diagnosis.fixWorkflow.phases.find((item) => item.phase === 'rebuild')?.state, 'not-applicable');
});

test('unrelated poison provenance does not inflate the selected root-cause frame to high confidence', () => {
  const stack: DebugProtocol.StackFrame[] = [0, 1, 2].map((index) => ({
    id: index + 1,
    name: `frame${index}`,
    source: { path: `/work/frame${index}.cpp` },
    line: index + 1,
    column: 1,
  }));
  const selection = selectProjectFrame(stack, { projectRoots: ['/work'] });
  const evidence: FrameEvidence[] = [
    { index: 0, frame: stack[0]!, locals: [], registers: [] },
    {
      index: 1,
      frame: stack[1]!,
      locals: [{ name: 'stalePtr', value: '0xFEEEFEEE', type: 'void *', variablesReference: 0 }],
      registers: [],
    },
    {
      index: 2,
      frame: stack[2]!,
      locals: [{ name: 'otherPtr', value: '0xFEEEFEEE', type: 'void *', variablesReference: 0 }],
      registers: [],
    },
  ];
  const chain = analyzeCallChain(selection, evidence);

  assert.equal(chain.provenance[0]?.confidence, 'high');
  assert.equal(chain.rootCauseCandidate.confidence, 'medium');
});

test('evidence refresh does not consume an autonomous fix iteration', () => {
  const weak = crashDiagnosis(undefined);
  const started = startAutonomousCycle(weak, 3);
  assert.equal(started.state.status, 'needs-evidence');

  const stronger = crashDiagnosis('/work/src/widget.cpp');
  const refreshed = refreshAutonomousEvidence(started.state, stronger);

  assert.equal(refreshed.state.iteration, 1);
  assert.equal(refreshed.state.status, 'needs-fix');
  assert.equal(refreshed.state.rootFingerprint, started.state.rootFingerprint);
  assert.equal(refreshed.state.activeFingerprint, baselineFingerprint(stronger.verificationBaseline));
  assert.equal(refreshed.nextActions[0]?.type, 'inspect-source');
  assert.equal(refreshed.state.history.at(-1)?.phase, 'diagnosis');
});

test('terminal autonomous states cannot be advanced into another edit cycle', () => {
  const diagnosis = crashDiagnosis('/work/src/widget.cpp');
  const started = startAutonomousCycle(diagnosis, 3);
  const fixed = advanceAutonomousCycle(started.state, {
    verdict: 'fixed',
    confidence: 'high',
    evidence: ['clean exit'],
  });

  assert.equal(fixed.state.status, 'fixed');
  assert.throws(
    () => advanceAutonomousCycle(fixed.state, {
      verdict: 'not-fixed',
      confidence: 'high',
      evidence: ['should not be accepted'],
    }, diagnosis),
    /cannot advance terminal autonomous agent state/i,
  );
});
