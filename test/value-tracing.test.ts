import assert from 'node:assert/strict';
import test from 'node:test';

import type { DebugProtocol } from '@vscode/debugprotocol';

import type { RuntimeSnapshot } from '../src/dap/session.js';
import { findObservedValue } from '../src/tools/value-tracing.js';

function variable(
  name: string,
  value: string,
  evaluateName?: string,
  type = 'int',
): DebugProtocol.Variable {
  return {
    name,
    value,
    type,
    variablesReference: 0,
    ...(evaluateName ? { evaluateName } : {}),
  };
}

function snapshot(locals: DebugProtocol.Variable[], registers: DebugProtocol.Variable[] = []): RuntimeSnapshot {
  const frame: DebugProtocol.StackFrame = {
    id: 1,
    name: 'Worker::run',
    line: 18,
    column: 1,
    source: { path: '/repo/worker.cpp' },
  };
  return {
    thread: { id: 1, name: 'main' },
    stack: [frame],
    frame,
    scopes: [],
    locals,
    registers,
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
        collected: false,
        totalModules: 0,
        withExplicitStatus: 0,
        symbolsAvailable: 0,
        symbolsMissing: 0,
        symbolsUnknown: 0,
      },
      limitations: [],
    },
  };
}

test('value tracing observes an exact local name without fuzzy matching', () => {
  const state = snapshot([
    variable('health', '52'),
    variable('healthBackup', '100'),
  ]);

  assert.deepEqual(findObservedValue(state, 'health'), {
    name: 'health',
    value: '52',
    type: 'int',
  });
  assert.equal(findObservedValue(state, 'heal'), undefined);
});

test('value tracing can match a debugger evaluateName and simple this-arrow normalization', () => {
  const state = snapshot([
    variable('buffer', '0x1234', 'this->buffer', 'char *'),
  ]);

  assert.deepEqual(findObservedValue(state, 'this->buffer'), {
    name: 'buffer',
    value: '0x1234',
    type: 'char *',
    evaluateName: 'this->buffer',
  });
  assert.equal(findObservedValue(state, 'buffer')?.value, '0x1234');
});

test('value tracing can observe an exact register but does not evaluate arbitrary expressions', () => {
  const state = snapshot([], [variable('rax', '0x0', undefined, 'register')]);

  assert.equal(findObservedValue(state, 'rax')?.value, '0x0');
  assert.equal(findObservedValue(state, 'rax + 8'), undefined);
});
