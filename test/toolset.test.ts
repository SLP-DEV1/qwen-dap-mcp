import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_TOOL_NAMES,
  filterToolRegistrar,
  resolveToolsetMode,
  toolsetAllows,
} from '../src/toolset.js';

test('agent is the default toolset and full remains opt-in', () => {
  assert.equal(resolveToolsetMode(undefined), 'agent');
  assert.equal(resolveToolsetMode(''), 'agent');
  assert.equal(resolveToolsetMode(' AGENT '), 'agent');
  assert.equal(resolveToolsetMode('FULL'), 'full');
  assert.throws(
    () => resolveToolsetMode('tiny'),
    /Expected 'agent' or 'full'/,
  );
});

test('agent toolset exposes the high-level workflow surface and hides manual tools', () => {
  assert.ok(AGENT_TOOL_NAMES.has('debug_this_crash'));
  assert.ok(AGENT_TOOL_NAMES.has('debug_open_dump'));
  assert.ok(AGENT_TOOL_NAMES.has('debug_disconnect'));
  assert.equal(toolsetAllows('agent', 'debug_this_crash'), true);
  assert.equal(toolsetAllows('agent', 'debug_set_data_breakpoints'), false);
  assert.equal(toolsetAllows('agent', 'debug_read_memory'), false);
  assert.equal(toolsetAllows('full', 'debug_read_memory'), true);
});

test('registration filter suppresses hidden schemas without changing handlers', () => {
  const registered: string[] = [];
  const registrar = {
    registerTool(name: string, ..._args: unknown[]) {
      registered.push(name);
      return { name };
    },
  };

  const agent = filterToolRegistrar(registrar, 'agent');
  const allowed = agent.registerTool('debug_this_crash', {}, () => undefined);
  const hidden = agent.registerTool('debug_evaluate', {}, () => undefined);

  assert.deepEqual(registered, ['debug_this_crash']);
  assert.deepEqual(allowed, { name: 'debug_this_crash' });
  assert.equal(hidden, undefined);

  const fullRegistered: string[] = [];
  const fullRegistrar = {
    registerTool(name: string) {
      fullRegistered.push(name);
    },
  };
  const full = filterToolRegistrar(fullRegistrar, 'full');
  assert.equal(full, fullRegistrar);
  full.registerTool('debug_evaluate');
  assert.deepEqual(fullRegistered, ['debug_evaluate']);
});
