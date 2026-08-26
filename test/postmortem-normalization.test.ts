import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeSnapshot } from '../src/dap/session.js';
import { normalizePostmortemSnapshot } from '../src/dap/postmortem-normalization.js';
import { analyzeRuntimeSnapshot } from '../src/diagnostics/analyze-snapshot.js';

function snapshotFor(exceptionId: string): RuntimeSnapshot {
  const frame = {
    id: 1,
    name: 'crash_here',
    source: { path: 'C:/repo/native-dump.cpp' },
    line: 42,
    column: 3,
    instructionPointerReference: '0x140001000',
  };
  return {
    stopped: {
      reason: 'exception',
      threadId: 1,
      allThreadsStopped: true,
      description: `Exception ${exceptionId} encountered`,
    },
    thread: { id: 1, name: 'main' },
    stack: [frame],
    frame,
    scopes: [],
    locals: [{ name: 'pointer', value: '0', type: 'int *', variablesReference: 0 }],
    registers: [],
    exception: {
      exceptionId,
      description: `Exception ${exceptionId} encountered`,
      breakMode: 'always',
    },
  };
}

test('normalizes Windows access-violation status codes for frozen dump diagnosis', () => {
  const snapshot = normalizePostmortemSnapshot(snapshotFor('0xC0000005'));
  const diagnosis = analyzeRuntimeSnapshot(snapshot);

  assert.equal(snapshot.postmortem, true);
  assert.match(snapshot.exception?.description ?? '', /access violation/i);
  assert.equal(diagnosis.classification.category, 'access-violation');
  assert.equal(diagnosis.classification.crashLikely, true);
  assert.equal(diagnosis.classification.confidence, 'high');
});

test('normalizes common Windows fatal status families without changing raw exception ids', () => {
  const cases = [
    ['0xC00000FD', /stack overflow/i, 'stack-overflow'],
    ['0xC0000094', /integer divide by zero/i, 'divide-by-zero'],
    ['0xC000001D', /illegal instruction/i, 'illegal-instruction'],
    ['0xC0000374', /heap corruption/i, 'heap-corruption'],
  ] as const;

  for (const [code, expectedText, expectedCategory] of cases) {
    const snapshot = normalizePostmortemSnapshot(snapshotFor(code));
    const diagnosis = analyzeRuntimeSnapshot(snapshot);
    assert.equal(snapshot.exception?.exceptionId, code);
    assert.match(snapshot.exception?.description ?? '', expectedText);
    assert.equal(diagnosis.classification.category, expectedCategory);
    assert.equal(diagnosis.classification.crashLikely, true);
  }
});

test('unknown postmortem exception codes remain conservative', () => {
  const snapshot = normalizePostmortemSnapshot(snapshotFor('0xE0001234'));
  const diagnosis = analyzeRuntimeSnapshot(snapshot);

  assert.equal(snapshot.postmortem, true);
  assert.doesNotMatch(snapshot.exception?.description ?? '', /access violation|stack overflow|divide by zero|illegal instruction|heap corruption/i);
  assert.equal(diagnosis.classification.category, 'exception');
  assert.equal(diagnosis.classification.crashLikely, false);
});
