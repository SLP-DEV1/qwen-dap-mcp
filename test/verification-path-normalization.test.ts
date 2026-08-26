import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeSnapshot } from '../src/dap/session.js';
import { analyzeRuntimeSnapshot } from '../src/diagnostics/analyze-snapshot.js';
import {
  buildIntelligentDiagnosis,
  compareVerificationBaseline,
  selectProjectFrame,
  type FrameEvidence,
  type IntelligentCrashDiagnosis,
} from '../src/diagnostics/intelligent-diagnosis.js';

function diagnosis(sourcePath: string): IntelligentCrashDiagnosis {
  const frame = {
    id: 1,
    name: 'Widget::render',
    source: { name: 'widget.cpp', path: sourcePath },
    line: 42,
    column: 3,
    instructionPointerReference: '0x1000',
    moduleId: 'app.exe',
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
  const selection = selectProjectFrame(snapshot.stack, { projectModules: ['app.exe'] });
  const evidence: FrameEvidence[] = [{
    index: 0,
    frame,
    locals: snapshot.locals,
    registers: snapshot.registers,
    disassembly: snapshot.disassembly,
  }];
  return buildIntelligentDiagnosis(snapshot, base, selection, evidence);
}

test('verification treats Windows path separators and case as the same crash source', () => {
  const original = diagnosis('C:\\Work\\Project\\src\\Widget.cpp');
  const reproduced = diagnosis('c:/work/project/src/widget.cpp');

  const verification = compareVerificationBaseline(original.verificationBaseline, reproduced);

  assert.equal(verification.verdict, 'not-fixed');
  assert.equal(verification.confidence, 'high');
});
