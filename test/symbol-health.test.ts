import assert from 'node:assert/strict';
import test from 'node:test';
import type { DebugProtocol } from '@vscode/debugprotocol';

import { assessSymbolHealth } from '../src/dap/symbol-health.js';

function frame(name: string, source?: string, line = 0): DebugProtocol.StackFrame {
  return {
    id: 1,
    name,
    line,
    column: 1,
    ...(source ? { source: { name: source, path: source } } : {}),
  };
}

test('symbol health reports good from named/source-mapped frames without missing module evidence', () => {
  const health = assessSymbolHealth(
    [frame('crash_here', '/work/main.cpp', 42), frame('main', '/work/main.cpp', 60)],
    [{ id: 1, name: 'app', symbolStatus: 'Symbols loaded.', symbolFilePath: '/work/app.debug' }],
  );
  assert.equal(health.status, 'good');
  assert.equal(health.stack.namedFrames, 2);
  assert.equal(health.stack.sourceMappedFrames, 2);
  assert.equal(health.modules.symbolsAvailable, 1);
});

test('symbol health reports partial when function names exist but source mapping is absent', () => {
  const health = assessSymbolHealth([frame('worker')]);
  assert.equal(health.status, 'partial');
  assert.ok(health.limitations.some((item) => /source file and line/i.test(item)));
  assert.ok(health.limitations.some((item) => /module symbol status/i.test(item)));
});

test('symbol health reports poor when stack and module evidence are unresolved', () => {
  const health = assessSymbolHealth(
    [frame('??')],
    [{ id: 1, name: 'app', symbolStatus: 'Symbols not found.' }],
  );
  assert.equal(health.status, 'poor');
  assert.equal(health.modules.symbolsMissing, 1);
});

test('symbol health remains unknown when no evidence exists', () => {
  const health = assessSymbolHealth([], undefined);
  assert.equal(health.status, 'unknown');
  assert.equal(health.stack.totalFrames, 0);
});
