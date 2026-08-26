import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeSnapshot } from '../src/dap/session.js';
import { analyzeRuntimeSnapshot } from '../src/diagnostics/analyze-snapshot.js';

function snapshotWithException(breakMode: 'always' | 'unhandled'): RuntimeSnapshot {
  const frame = {
    id: 1,
    name: 'Widget::tick',
    source: { path: '/work/src/widget.cpp' },
    line: 21,
    column: 3,
    instructionPointerReference: '0x1000',
  };
  return {
    stopped: { reason: 'exception', threadId: 1, allThreadsStopped: true },
    thread: { id: 1, name: 'main' },
    stack: [frame],
    frame,
    scopes: [],
    locals: [{ name: 'widgetPtr', value: '0', type: 'Widget *', variablesReference: 0 }],
    registers: [],
    exception: {
      exceptionId: 'MY_EXCEPTION',
      description: 'A configured exception stop',
      breakMode,
    },
  };
}

test('configured first-chance exception stops are not treated as proven crashes', () => {
  const diagnosis = analyzeRuntimeSnapshot(snapshotWithException('always'));

  assert.equal(diagnosis.classification.category, 'exception');
  assert.equal(diagnosis.classification.crashLikely, false);
  assert.equal(diagnosis.hypotheses[0]?.kind, 'first-chance-or-configured-exception');
  assert.match(diagnosis.summary, /does not prove/i);
});

test('unhandled exception stops remain crash-likely', () => {
  const diagnosis = analyzeRuntimeSnapshot(snapshotWithException('unhandled'));

  assert.equal(diagnosis.classification.category, 'exception');
  assert.equal(diagnosis.classification.crashLikely, true);
  assert.equal(diagnosis.hypotheses[0]?.kind, 'reported-exception');
});

test('decimal zero pointer values are recognized consistently with hexadecimal nulls', () => {
  const snapshot = snapshotWithException('unhandled');
  snapshot.exception = {
    exceptionId: 'EXCEPTION_ACCESS_VIOLATION',
    description: 'Access violation reading address 0',
    breakMode: 'unhandled',
  };

  const diagnosis = analyzeRuntimeSnapshot(snapshot);

  assert.equal(diagnosis.classification.category, 'access-violation');
  assert.equal(diagnosis.suspiciousValues[0]?.name, 'widgetPtr');
  assert.equal(diagnosis.suspiciousValues[0]?.reason, 'null-like-pointer');
});
