import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeSnapshot } from '../src/dap/session.js';
import { analyzeRuntimeSnapshot, correlateSourceDisassembly } from '../src/diagnostics/analyze-snapshot.js';
import {
  analyzeCallChain,
  analyzeInstructionOperands,
  buildIntelligentDiagnosis,
  compareVerificationBaseline,
  selectProjectFrame,
  type FrameEvidence,
} from '../src/diagnostics/intelligent-diagnosis.js';

function baseSnapshot(): RuntimeSnapshot {
  const frame = {
    id: 100,
    name: 'crash_here',
    source: { name: 'main.cpp', path: '/tmp/main.cpp' },
    line: 42,
    column: 7,
    instructionPointerReference: '0x1000',
    moduleId: 'app',
  };
  return {
    stopped: { reason: 'exception', threadId: 1, allThreadsStopped: true },
    thread: { id: 1, name: 'main' },
    stack: [frame],
    frame,
    scopes: [],
    locals: [],
    registers: [],
    disassembly: [
      { address: '0x0ffc', instruction: 'mov rax, rcx' },
      { address: '0x1000', instruction: 'mov eax, dword ptr [rax]' },
      { address: '0x1004', instruction: 'ret' },
    ],
  };
}

test('diagnosis identifies access violations and null pointer evidence', () => {
  const snapshot = baseSnapshot();
  snapshot.exception = {
    exceptionId: 'EXCEPTION_ACCESS_VIOLATION',
    description: 'Access violation reading address 0x0',
    breakMode: 'unhandled',
  };
  snapshot.locals = [
    { name: 'userPtr', value: '0x0', type: 'User *', variablesReference: 0 },
  ];

  const diagnosis = analyzeRuntimeSnapshot(snapshot);

  assert.equal(diagnosis.classification.category, 'access-violation');
  assert.equal(diagnosis.classification.crashLikely, true);
  assert.equal(diagnosis.sourceDisassembly.exactInstructionMatch, true);
  assert.equal(diagnosis.sourceDisassembly.currentInstruction?.address, '0x1000');
  assert.equal(diagnosis.suspiciousValues[0]?.name, 'userPtr');
  assert.equal(diagnosis.suspiciousValues[0]?.reason, 'null-like-pointer');
  assert.equal(diagnosis.hypotheses[0]?.kind, 'null-dereference');
  assert.equal(diagnosis.hypotheses[0]?.confidence, 'high');
});

test('diagnosis recognizes poison patterns as lifetime/corruption evidence', () => {
  const snapshot = baseSnapshot();
  snapshot.exception = {
    exceptionId: 'SIGSEGV',
    description: 'Segmentation fault',
    breakMode: 'unhandled',
  };
  snapshot.locals = [
    { name: 'widgetPtr', value: '0xFEEEFEEE', type: 'Widget *', variablesReference: 0 },
  ];

  const diagnosis = analyzeRuntimeSnapshot(snapshot);

  assert.equal(diagnosis.classification.category, 'segmentation-fault');
  assert.equal(diagnosis.suspiciousValues[0]?.reason, 'poison-pattern');
  assert.ok(diagnosis.hypotheses.some((item) => item.kind === 'invalid-lifetime'));
});

test('ordinary breakpoint stops are not automatically classified as crashes', () => {
  const snapshot = baseSnapshot();
  snapshot.stopped = { reason: 'breakpoint', threadId: 1, allThreadsStopped: true };
  snapshot.exception = undefined;

  const diagnosis = analyzeRuntimeSnapshot(snapshot);

  assert.equal(diagnosis.classification.category, 'breakpoint');
  assert.equal(diagnosis.classification.crashLikely, false);
  assert.equal(diagnosis.hypotheses.length, 0);
  assert.match(diagnosis.summary, /not automatically evidence of a crash/i);
});

test('source/disassembly correlation falls back to the nearest instruction', () => {
  const snapshot = baseSnapshot();
  snapshot.frame = { ...snapshot.frame, instructionPointerReference: '0x1002' };
  snapshot.stack = [snapshot.frame];

  const correlation = correlateSourceDisassembly(snapshot);

  assert.equal(correlation.exactInstructionMatch, false);
  assert.equal(correlation.currentInstruction?.address, '0x1000');
  assert.equal(correlation.source?.path, '/tmp/main.cpp');
  assert.equal(correlation.source?.line, 42);
});

test('generic exception reports preserve adapter exception evidence', () => {
  const snapshot = baseSnapshot();
  snapshot.exception = {
    exceptionId: 'MY_RUNTIME_EXCEPTION',
    description: 'Unhandled runtime exception',
    breakMode: 'unhandled',
    details: { message: 'bad state' },
  };

  const diagnosis = analyzeRuntimeSnapshot(snapshot);

  assert.equal(diagnosis.classification.category, 'exception');
  assert.equal(diagnosis.exception?.exceptionId, 'MY_RUNTIME_EXCEPTION');
  assert.equal(diagnosis.hypotheses[0]?.kind, 'reported-exception');
  assert.match(diagnosis.hypotheses[0]?.title ?? '', /Unhandled runtime exception/);
});

test('project-frame selection skips system/runtime frames and prefers explicit project roots', () => {
  const stack = [
    {
      id: 1,
      name: 'RtlReportFatalFailure',
      moduleId: 'ntdll.dll',
      line: 0,
      column: 0,
      instructionPointerReference: '0x7000',
    },
    {
      id: 2,
      name: 'abort',
      moduleId: 'ucrtbase.dll',
      line: 0,
      column: 0,
      instructionPointerReference: '0x6000',
    },
    {
      id: 3,
      name: 'Widget::render',
      moduleId: 'myapp.exe',
      source: { name: 'widget.cpp', path: 'C:\\work\\myapp\\src\\widget.cpp' },
      line: 88,
      column: 5,
      instructionPointerReference: '0x401000',
    },
  ];

  const selection = selectProjectFrame(stack, {
    projectRoots: ['C:\\work\\myapp'],
    program: 'C:\\work\\myapp\\build\\myapp.exe',
  });

  assert.equal(selection.selected.index, 2);
  assert.equal(selection.selected.frame.name, 'Widget::render');
  assert.equal(selection.selected.projectControlled, true);
  assert.equal(selection.selected.confidence, 'high');
  assert.equal(selection.skippedRuntimeFrames, 2);
});

test('operand analysis binds a faulting memory register back to a pointer local', () => {
  const frame = {
    id: 3,
    name: 'Widget::render',
    source: { path: 'C:\\work\\myapp\\src\\widget.cpp' },
    line: 88,
    column: 5,
    instructionPointerReference: '0x401000',
  };
  const evidence: FrameEvidence = {
    index: 2,
    frame,
    locals: [{ name: 'widgetPtr', value: '0x0', type: 'Widget *', variablesReference: 0 }],
    registers: [
      { name: 'rax', value: '0x0', variablesReference: 0 },
      { name: 'rcx', value: '0x1234', variablesReference: 0 },
    ],
    disassembly: [
      { address: '0x400ffc', instruction: 'mov rax, rcx' },
      { address: '0x401000', instruction: 'mov eax, dword ptr [rax]' },
      { address: '0x401004', instruction: 'ret' },
    ],
  };

  const analysis = analyzeInstructionOperands(evidence);

  assert.equal(analysis.mnemonic, 'mov');
  assert.equal(analysis.likelyFaultOperand?.register, 'rax');
  assert.equal(analysis.likelyFaultOperand?.value, '0x0');
  assert.equal(analysis.likelyFaultOperand?.confidence, 'high');
  assert.equal(analysis.variableBindings[0]?.variable, 'widgetPtr');
  assert.equal(analysis.variableBindings[0]?.register, 'rax');
  assert.equal(analysis.variableBindings[0]?.confidence, 'high');
});

test('call-chain analysis traces pointer-like values through project callers', () => {
  const stack = [
    {
      id: 10,
      name: 'Widget::render',
      moduleId: 'myapp.exe',
      source: { path: 'C:\\work\\myapp\\src\\widget.cpp' },
      line: 88,
      column: 5,
    },
    {
      id: 11,
      name: 'Scene::draw',
      moduleId: 'myapp.exe',
      source: { path: 'C:\\work\\myapp\\src\\scene.cpp' },
      line: 51,
      column: 3,
    },
    {
      id: 12,
      name: 'main',
      moduleId: 'myapp.exe',
      source: { path: 'C:\\work\\myapp\\src\\main.cpp' },
      line: 20,
      column: 3,
    },
  ];
  const selection = selectProjectFrame(stack, { projectRoots: ['C:\\work\\myapp'] });
  const evidence: FrameEvidence[] = [
    {
      index: 0,
      frame: stack[0]!,
      locals: [{ name: 'widget', value: '0xFEEEFEEE', type: 'Widget *', variablesReference: 0 }],
      registers: [],
    },
    {
      index: 1,
      frame: stack[1]!,
      locals: [{ name: 'selectedWidget', value: '0xFEEEFEEE', type: 'Widget *', variablesReference: 0 }],
      registers: [],
    },
  ];

  const chain = analyzeCallChain(selection, evidence);

  assert.equal(chain.firstProjectFrame.function, 'Widget::render');
  assert.equal(chain.projectCallerFrames[0]?.function, 'Scene::draw');
  assert.equal(chain.provenance[0]?.value, '0xfeeefeee');
  assert.deepEqual(chain.provenance[0]?.frames.map((frame) => frame.index), [0, 1]);
  assert.equal(chain.provenance[0]?.confidence, 'high');
});

test('intelligent diagnosis emits a verification baseline and detects the same reproduced crash', () => {
  const snapshot = baseSnapshot();
  snapshot.exception = {
    exceptionId: 'EXCEPTION_ACCESS_VIOLATION',
    description: 'Access violation reading address 0x0',
    breakMode: 'unhandled',
  };
  snapshot.locals = [{ name: 'userPtr', value: '0x0', type: 'User *', variablesReference: 0 }];
  snapshot.registers = [{ name: 'rax', value: '0x0', variablesReference: 0 }];

  const base = analyzeRuntimeSnapshot(snapshot);
  const selection = selectProjectFrame(snapshot.stack, { projectRoots: ['/tmp'] });
  const evidence: FrameEvidence[] = [{
    index: 0,
    frame: snapshot.frame,
    locals: snapshot.locals,
    registers: snapshot.registers,
    disassembly: snapshot.disassembly,
  }];
  const diagnosis = buildIntelligentDiagnosis(snapshot, base, selection, evidence);

  assert.equal(diagnosis.projectFrame.function, 'crash_here');
  assert.equal(diagnosis.operandAnalysis.likelyFaultOperand?.register, 'rax');
  assert.equal(diagnosis.fixWorkflow.status, 'proposal-only');
  assert.equal(diagnosis.fixWorkflow.phases.map((phase) => phase.phase).join(','), 'diagnose,fix,rebuild,reproduce,verify');

  const verification = compareVerificationBaseline(diagnosis.verificationBaseline, diagnosis);
  assert.equal(verification.verdict, 'not-fixed');
  assert.equal(verification.confidence, 'high');
});

test('verification marks a clean reproduction exit as fixed with high confidence', () => {
  const snapshot = baseSnapshot();
  const base = analyzeRuntimeSnapshot(snapshot);
  const selection = selectProjectFrame(snapshot.stack, { projectRoots: ['/tmp'] });
  const diagnosis = buildIntelligentDiagnosis(snapshot, base, selection, [{
    index: 0,
    frame: snapshot.frame,
    locals: snapshot.locals,
    registers: snapshot.registers,
    disassembly: snapshot.disassembly,
  }]);

  const verification = compareVerificationBaseline(
    diagnosis.verificationBaseline,
    undefined,
    { event: 'exited', exitCode: 0 },
  );

  assert.equal(verification.verdict, 'fixed');
  assert.equal(verification.confidence, 'high');
});
