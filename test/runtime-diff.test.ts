import assert from 'node:assert/strict';
import test from 'node:test';

import type { DebugProtocol } from '@vscode/debugprotocol';

import { compareRuntimeSnapshots } from '../src/diagnostics/runtime-diff.js';
import type { RuntimeSnapshot } from '../src/dap/session.js';

function variable(name: string, value: string, type = 'int'): DebugProtocol.Variable {
  return { name, value, type, variablesReference: 0 };
}

function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  const frame: DebugProtocol.StackFrame = {
    id: 1,
    name: 'Parser::load',
    line: 42,
    column: 1,
    source: { path: 'C:\\repo\\parser.cpp' },
    instructionPointerReference: '0x7ff612341000',
  };
  return {
    thread: { id: 1, name: 'main' },
    stack: [frame],
    frame,
    scopes: [],
    locals: [variable('count', '42'), variable('buffer', '0x7ff612345678', 'char *')],
    registers: [variable('rax', '0x7ff612345678', 'register')],
    symbolHealth: {
      status: 'good',
      summary: 'Symbols are healthy.',
      stack: {
        totalFrames: 1,
        namedFrames: 1,
        sourceMappedFrames: 1,
        topFrameNamed: true,
        topFrameSourceMapped: true,
      },
      modules: {
        collected: true,
        totalModules: 1,
        withExplicitStatus: 0,
        symbolsAvailable: 0,
        symbolsMissing: 0,
        symbolsUnknown: 1,
      },
      limitations: [],
    },
    modules: [{ id: 1, name: 'app.exe', path: 'C:\\repo\\app.exe' }],
    ...overrides,
  };
}

test('runtime diff treats non-null raw address changes as unstable rather than meaningful', () => {
  const baseline = snapshot();
  const candidate = snapshot({
    locals: [variable('count', '42'), variable('buffer', '0x7ff699999999', 'char *')],
    registers: [variable('rax', '0x7ff699999999', 'register')],
  });

  const diff = compareRuntimeSnapshots(baseline, candidate);
  assert.equal(diff.summary.meaningfulDifferences, 0);
  assert.equal(diff.summary.unstableValues, 2);
  assert.equal(diff.locals.find((item) => item.name === 'buffer')?.status, 'unstable');
  assert.equal(diff.firstMeaningfulDifference, undefined);
});

test('runtime diff promotes nullability changes as meaningful local evidence', () => {
  const baseline = snapshot();
  const candidate = snapshot({
    locals: [variable('count', '42'), variable('buffer', '0x0', 'char *')],
  });

  const diff = compareRuntimeSnapshots(baseline, candidate);
  assert.equal(diff.summary.changedLocals, 1);
  assert.equal(diff.firstMeaningfulDifference?.category, 'local');
  assert.equal(diff.firstMeaningfulDifference?.key, 'buffer\u0000char *');
  assert.match(String(diff.firstMeaningfulDifference?.reason), /Nullability changed/);
});

test('runtime diff canonicalizes Windows source path case and separators', () => {
  const baseline = snapshot();
  const candidateFrame: DebugProtocol.StackFrame = {
    ...baseline.frame,
    source: { path: 'c:/REPO/parser.cpp' },
  };
  const candidate = snapshot({ stack: [candidateFrame], frame: candidateFrame });

  const diff = compareRuntimeSnapshots(baseline, candidate);
  assert.equal(diff.stack.status, 'same');
  assert.equal(diff.summary.stackChanges, 0);
});

test('runtime diff reports exception and module changes after local evidence', () => {
  const baseline = snapshot({ exception: { exceptionId: 'breakpoint', breakMode: 'always' } });
  const candidate = snapshot({
    exception: { exceptionId: 'SIGSEGV', breakMode: 'always' },
    modules: [
      { id: 1, name: 'app.exe', path: 'C:\\repo\\app.exe' },
      { id: 2, name: 'plugin.dll', path: 'C:\\repo\\plugin.dll' },
    ],
  });

  const diff = compareRuntimeSnapshots(baseline, candidate);
  assert.equal(diff.exception.status, 'changed');
  assert.equal(diff.modules.added.length, 1);
  assert.equal(diff.firstMeaningfulDifference?.category, 'exception');
});
