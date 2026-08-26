import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeSnapshot } from '../src/dap/session.js';
import { analyzeRuntimeSnapshot } from '../src/diagnostics/analyze-snapshot.js';
import {
  analyzeCallChain,
  analyzeInstructionOperands,
  buildIntelligentDiagnosis,
  compareVerificationBaseline,
  createVerificationBaseline,
  selectProjectFrame,
} from '../src/diagnostics/intelligent-diagnosis.js';

function baseSnapshot(): RuntimeSnapshot {
  return {
    stopped: { reason: 'exception', threadId: 1 },
    thread: { id: 1, name: 'main' },
    stack: [
      {
        id: 1,
        name: 'crash_here',
        moduleId: 'app',
        source: { name: 'main.cpp', path: '/repo/src/main.cpp' },
        line: 42,
        column: 5,
        instructionPointerReference: '0x1000',
      },
    ],
    frame: {
      id: 1,
      name: 'crash_here',
      moduleId: 'app',
      source: { name: 'main.cpp', path: '/repo/src/main.cpp' },
      line: 42,
      column: 5,
      instructionPointerReference: '0x1000',
    },
    scopes: [],
    locals: [],
    registers: [],
    symbolHealth: {
      status: 'good',
      summary: 'fixture',
      stack: { totalFrames: 1, namedFrames: 1, sourceMappedFrames: 1, topFrameNamed: true, topFrameSourceMapped: true },
      modules: { collected: false, totalModules: 0, withExplicitStatus: 0, symbolsAvailable: 0, symbolsMissing: 0, symbolsUnknown: 0 },
      limitations: [],
    },
    disassembly: [
      { address: '0x0ffc', instruction: 'nop' },
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
  // A pointer-like local is useful evidence, but only the later operand analysis
  // can promote a null value to high confidence by proving it feeds the faulting
  // memory operand. This prevents unrelated zero values from becoming causal.
  assert.equal(diagnosis.hypotheses[0]?.confidence, 'medium');
});

test('diagnosis recognizes poison patterns as lifetime/corruption evidence', () => {
  const snapshot = baseSnapshot();
  snapshot.exception = {
    exceptionId: 'SIGSEGV',
    description: 'Segmentation fault',
    breakMode: 'unhandled',
  };
  snapshot.locals = [
    { name: 'object', value: '0xdddddddd', type: 'Widget *', variablesReference: 0 },
  ];

  const diagnosis = analyzeRuntimeSnapshot(snapshot);
  assert.equal(diagnosis.classification.category, 'segmentation-fault');
  assert.equal(diagnosis.suspiciousValues[0]?.reason, 'poison-pattern');
  assert.equal(diagnosis.hypotheses[0]?.kind, 'invalid-lifetime');
  assert.equal(diagnosis.hypotheses[0]?.confidence, 'high');
});

test('ordinary breakpoint stops are not automatically classified as crashes', () => {
  const snapshot = baseSnapshot();
  snapshot.stopped = { reason: 'breakpoint', threadId: 1 };
  snapshot.exception = undefined;
  const diagnosis = analyzeRuntimeSnapshot(snapshot);
  assert.equal(diagnosis.classification.category, 'breakpoint');
  assert.equal(diagnosis.classification.crashLikely, false);
});

test('source/disassembly correlation falls back to the nearest instruction', () => {
  const snapshot = baseSnapshot();
  snapshot.frame.instructionPointerReference = '0x1002';
  const diagnosis = analyzeRuntimeSnapshot(snapshot);
  assert.equal(diagnosis.sourceDisassembly.exactInstructionMatch, false);
  assert.equal(diagnosis.sourceDisassembly.currentInstruction?.address, '0x1000');
});

test('generic exception reports preserve adapter exception evidence', () => {
  const snapshot = baseSnapshot();
  snapshot.exception = {
    exceptionId: 'MY_EXCEPTION',
    description: 'custom failure',
    breakMode: 'unhandled',
  };
  const diagnosis = analyzeRuntimeSnapshot(snapshot);
  assert.equal(diagnosis.classification.category, 'exception');
  assert.equal(diagnosis.exception?.exceptionId, 'MY_EXCEPTION');
});

test('project-frame selection skips system/runtime frames and prefers explicit project roots', () => {
  const snapshot = baseSnapshot();
  snapshot.stack = [
    { id: 1, name: 'memcpy', moduleId: 'ucrtbase.dll', line: 0, column: 0 },
    { id: 2, name: 'dispatch', moduleId: 'kernel32.dll', line: 0, column: 0 },
    { id: 3, name: 'process_user', moduleId: 'app.exe', source: { path: '/repo/src/user.cpp' }, line: 77, column: 1 },
  ];
  const selection = selectProjectFrame(snapshot.stack, { projectRoots: ['/repo'] });
  assert.equal(selection.selected.index, 2);
  assert.equal(selection.selected.frame.name, 'process_user');
  assert.equal(selection.selected.projectControlled, true);
});

test('operand analysis binds a selected-frame memory register back to a pointer local', () => {
  const analysis = analyzeInstructionOperands({
    index: 0,
    frame: baseSnapshot().frame,
    locals: [{ name: 'user', value: '0x0', type: 'User *', variablesReference: 0 }],
    registers: [{ name: 'rax', value: '0x0', variablesReference: 0 }],
    disassembly: [{ address: '0x1000', instruction: 'mov eax, dword ptr [rax]' }],
  });
  assert.equal(analysis.likelyFaultOperand?.register, 'rax');
  assert.equal(analysis.likelyFaultOperand?.confidence, 'high');
  assert.equal(analysis.variableBindings[0]?.variable, 'user');
});

test('call-chain analysis traces distinctive poison values through project callers', () => {
  const stack = [
    { id: 1, name: 'consume', source: { path: '/repo/consume.cpp' }, line: 10, column: 1 },
    { id: 2, name: 'forward', source: { path: '/repo/forward.cpp' }, line: 20, column: 1 },
    { id: 3, name: 'produce', source: { path: '/repo/produce.cpp' }, line: 30, column: 1 },
  ];
  const selection = selectProjectFrame(stack, { projectRoots: ['/repo'] });
  const chain = analyzeCallChain(selection, stack.map((frame, index) => ({
    index,
    frame,
    locals: [{ name: `ptr${index}`, value: '0xdeadbeef', type: 'Thing *', variablesReference: 0 }],
    registers: [],
  })));
  assert.equal(chain.provenance[0]?.value, '0xdeadbeef');
  assert.equal(chain.provenance[0]?.confidence, 'high');
  assert.equal(chain.provenance[0]?.frames.length, 3);
});

test('null values repeated across callers remain low-confidence provenance', () => {
  const stack = [
    { id: 1, name: 'consume', source: { path: '/repo/consume.cpp' }, line: 10, column: 1 },
    { id: 2, name: 'caller', source: { path: '/repo/caller.cpp' }, line: 20, column: 1 },
  ];
  const selection = selectProjectFrame(stack, { projectRoots: ['/repo'] });
  const chain = analyzeCallChain(selection, stack.map((frame, index) => ({
    index,
    frame,
    locals: [{ name: `ptr${index}`, value: '0x0', type: 'Thing *', variablesReference: 0 }],
    registers: [],
  })));
  assert.equal(chain.provenance[0]?.value, '0x0');
  assert.equal(chain.provenance[0]?.confidence, 'low');
});

test('intelligent diagnosis emits a verification baseline and detects the same reproduced crash', () => {
  const snapshot = baseSnapshot();
  snapshot.exception = {
    exceptionId: 'SIGSEGV',
    description: 'Segmentation fault',
    breakMode: 'unhandled',
  };
  const base = analyzeRuntimeSnapshot(snapshot);
  const selection = selectProjectFrame(snapshot.stack, { projectRoots: ['/repo'] });
  const diagnosis = buildIntelligentDiagnosis(snapshot, base, selection, [{
    index: 0,
    frame: snapshot.frame,
    locals: [],
    registers: [],
    disassembly: snapshot.disassembly,
  }]);
  const baseline = createVerificationBaseline(diagnosis);
  const verification = compareVerificationBaseline(baseline, diagnosis);
  assert.equal(verification.verdict, 'not-fixed');
  assert.equal(verification.confidence, 'high');
});

test('verification marks a clean reproduction exit as fixed with high confidence', () => {
  const snapshot = baseSnapshot();
  const diagnosis = analyzeRuntimeSnapshot(snapshot);
  const selection = selectProjectFrame(snapshot.stack, { projectRoots: ['/repo'] });
  const intelligent = buildIntelligentDiagnosis(snapshot, diagnosis, selection, [{
    index: 0,
    frame: snapshot.frame,
    locals: [],
    registers: [],
    disassembly: snapshot.disassembly,
  }]);
  const verification = compareVerificationBaseline(intelligent.verificationBaseline, undefined, { event: 'exited', exitCode: 0 });
  assert.equal(verification.verdict, 'fixed');
  assert.equal(verification.confidence, 'high');
});

test('verification does not treat a non-crash breakpoint stop as proof of a fix', () => {
  const crashSnapshot = baseSnapshot();
  crashSnapshot.exception = {
    exceptionId: 'SIGSEGV',
    description: 'Segmentation fault',
    breakMode: 'unhandled',
  };
  const crashBase = analyzeRuntimeSnapshot(crashSnapshot);
  const crashSelection = selectProjectFrame(crashSnapshot.stack, { projectRoots: ['/repo'] });
  const crashDiagnosis = buildIntelligentDiagnosis(crashSnapshot, crashBase, crashSelection, [{
    index: 0,
    frame: crashSnapshot.frame,
    locals: [],
    registers: [],
    disassembly: crashSnapshot.disassembly,
  }]);

  const stopSnapshot = baseSnapshot();
  stopSnapshot.stopped = { reason: 'breakpoint', threadId: 1 };
  stopSnapshot.exception = undefined;
  const stopBase = analyzeRuntimeSnapshot(stopSnapshot);
  const stopSelection = selectProjectFrame(stopSnapshot.stack, { projectRoots: ['/repo'] });
  const stopDiagnosis = buildIntelligentDiagnosis(stopSnapshot, stopBase, stopSelection, [{
    index: 0,
    frame: stopSnapshot.frame,
    locals: [],
    registers: [],
    disassembly: stopSnapshot.disassembly,
  }]);
  const verification = compareVerificationBaseline(crashDiagnosis.verificationBaseline, stopDiagnosis);
  assert.equal(verification.verdict, 'inconclusive');
});
