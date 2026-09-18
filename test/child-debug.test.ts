import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeStartConfiguration } from '../src/tools/child-debug.js';

test('child startDebugging sanitizer forwards only the bounded local launch subset', () => {
  const result = sanitizeStartConfiguration(
    {
      arguments: {
        configuration: {
          type: 'anything-from-adapter',
          request: 'launch',
          program: '/tmp/app',
          args: ['--child'],
          cwd: '/tmp',
          env: { MODE: 'test' },
          stopOnEntry: true,
          attachCommands: ['shell arbitrary-command'],
          terminal: 'integrated',
          target: '10.0.0.1:1234',
          custom: { dangerous: true },
        },
      },
    },
    {},
  );

  assert.deepEqual(result, {
    request: 'launch',
    program: '/tmp/app',
    cwd: '/tmp',
    args: ['--child'],
    env: { MODE: 'test' },
    stopOnEntry: true,
  });
  assert.equal('attachCommands' in result, false);
  assert.equal('target' in result, false);
  assert.equal('terminal' in result, false);
  assert.equal('type' in result, false);
});

test('child sanitizer requires explicit local launch/attach shapes', () => {
  assert.throws(
    () => sanitizeStartConfiguration(
      { arguments: { configuration: { request: 'custom', program: '/tmp/app' } } },
      {},
    ),
    /launch.*attach/i,
  );

  assert.throws(
    () => sanitizeStartConfiguration(
      { arguments: { configuration: { request: 'launch' } } },
      {},
    ),
    /requires an explicit program/i,
  );

  assert.throws(
    () => sanitizeStartConfiguration(
      { arguments: { configuration: { request: 'attach', pid: '123' } } },
      {},
    ),
    /positive numeric pid/i,
  );
});

test('explicit child program override wins over adapter-supplied program', () => {
  const result = sanitizeStartConfiguration(
    {
      arguments: {
        configuration: {
          request: 'launch',
          program: '/tmp/adapter-program',
        },
      },
    },
    { program: '/tmp/reviewed-program' },
  );
  assert.equal(result.program, '/tmp/reviewed-program');
});
