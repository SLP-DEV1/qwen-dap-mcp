import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRootCauseBacktrack } from '../src/diagnostics/autonomous-cycle.js';
import type { IntelligentCrashDiagnosis } from '../src/diagnostics/intelligent-diagnosis.js';

test('root-cause backtrack binds the local that matches the actual fault operand register', () => {
  const diagnosis = {
    projectFrame: {
      index: 0,
      function: 'Widget::render',
      sourcePath: 'C:/work/widget.cpp',
      line: 42,
    },
    operandAnalysis: {
      rawInstruction: 'mov rax, qword ptr [rcx]',
      likelyFaultOperand: {
        register: 'rcx',
        value: '0x0',
        reason: 'rcx is the memory operand',
        confidence: 'high',
        faultingFrame: true,
      },
      variableBindings: [
        {
          variable: 'returnValue',
          variableValue: '0x1234',
          register: 'rax',
          registerValue: '0x1234',
          confidence: 'medium',
          reason: 'matches a non-memory result register',
        },
        {
          variable: 'widgetPtr',
          variableType: 'Widget *',
          variableValue: '0x0',
          register: 'rcx',
          registerValue: '0x0',
          confidence: 'high',
          reason: 'matches the memory operand register',
        },
      ],
    },
    callChain: {
      provenance: [],
      frames: [
        {
          index: 0,
          function: 'Widget::render',
          sourcePath: 'C:/work/widget.cpp',
          line: 42,
          role: 'project-fault',
          projectControlled: true,
          runtimeLikely: false,
          score: 100,
        },
      ],
    },
  } as unknown as IntelligentCrashDiagnosis;

  const backtrack = buildRootCauseBacktrack(diagnosis);

  assert.equal(backtrack.target.register, 'rcx');
  assert.equal(backtrack.target.variable, 'widgetPtr');
  assert.equal(backtrack.target.value, '0x0');
  assert.equal(backtrack.runtimeTrail[0]?.variables[0], 'widgetPtr');
});

test('root-cause backtrack does not attach an unrelated local when the fault register has no binding', () => {
  const diagnosis = {
    projectFrame: { index: 0, function: 'crash', sourcePath: '/work/crash.cpp', line: 9 },
    operandAnalysis: {
      rawInstruction: 'mov eax, dword ptr [rcx]',
      likelyFaultOperand: {
        register: 'rcx',
        value: '0x0',
        reason: 'fault operand',
        confidence: 'high',
        faultingFrame: true,
      },
      variableBindings: [
        {
          variable: 'unrelated',
          variableValue: '0x0',
          register: 'rax',
          registerValue: '0x0',
          confidence: 'medium',
          reason: 'unrelated register',
        },
      ],
    },
    callChain: {
      provenance: [],
      frames: [
        {
          index: 0,
          function: 'crash',
          sourcePath: '/work/crash.cpp',
          line: 9,
          role: 'project-fault',
          projectControlled: true,
          runtimeLikely: false,
          score: 100,
        },
      ],
    },
  } as unknown as IntelligentCrashDiagnosis;

  const backtrack = buildRootCauseBacktrack(diagnosis);

  assert.equal(backtrack.target.register, 'rcx');
  assert.equal(backtrack.target.variable, undefined);
  assert.equal(backtrack.runtimeTrail.length, 0);
});
