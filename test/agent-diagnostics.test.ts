import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeSnapshot } from '../src/dap/session.js';
import { analyzeRuntimeSnapshot, correlateSourceDisassembly } from '../src/diagnostics/analyze-snapshot.js';

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
