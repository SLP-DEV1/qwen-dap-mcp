import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_TOOL_NAMES,
  FORENSICS_TOOL_NAMES,
  filterToolRegistrar,
  resolveToolsetMode,
  toolsetAllows,
} from '../src/toolset.js';

test('agent is default, forensics is high-level opt-in, and full remains raw-DAP opt-in', () => {
  assert.equal(resolveToolsetMode(undefined), 'agent');
  assert.equal(resolveToolsetMode(''), 'agent');
  assert.equal(resolveToolsetMode(' AGENT '), 'agent');
  assert.equal(resolveToolsetMode('FORENSICS'), 'forensics');
  assert.equal(resolveToolsetMode('FULL'), 'full');
  assert.equal(resolveToolsetMode('tiny'), 'agent');
});

test('agent stays compact while forensics exposes specialized workflows', () => {
  assert.equal(AGENT_TOOL_NAMES.size, 18);
  assert.equal(FORENSICS_TOOL_NAMES.size, 32);
  assert.ok(AGENT_TOOL_NAMES.has('debug_this_crash'));
  assert.ok(AGENT_TOOL_NAMES.has('debug_runtime_report'));
  assert.ok(AGENT_TOOL_NAMES.has('debug_adapter_doctor'));
  assert.equal(AGENT_TOOL_NAMES.has('debug_time_travel'), false);
  assert.equal(AGENT_TOOL_NAMES.has('debug_symbol_doctor'), false);

  assert.equal(toolsetAllows('agent', 'debug_this_crash'), true);
  assert.equal(toolsetAllows('agent', 'debug_time_travel'), false);
  assert.equal(toolsetAllows('forensics', 'debug_time_travel'), true);
  assert.equal(toolsetAllows('forensics', 'debug_adopt_child'), true);
  assert.equal(toolsetAllows('forensics', 'debug_read_memory'), false);
  assert.equal(toolsetAllows('full', 'debug_read_memory'), true);
});

test('registration filter suppresses tools outside the selected surface', () => {
  const registered: string[] = [];
  const registrar = {
    registerTool(name: string, ..._args: unknown[]) {
      registered.push(name);
      return { name };
    },
  };

  const agent = filterToolRegistrar(registrar, 'agent');
  const allowed = agent.registerTool('debug_this_hang', {}, () => undefined);
  const hiddenForensic = agent.registerTool('debug_time_travel', {}, () => undefined);
  assert.deepEqual(registered, ['debug_this_hang']);
  assert.deepEqual(allowed, { name: 'debug_this_hang' });
  assert.equal(typeof hiddenForensic.disable, 'function');

  const forensicRegistered: string[] = [];
  const forensicRegistrar = {
    registerTool(name: string) {
      forensicRegistered.push(name);
      return { name };
    },
  };
  const forensics = filterToolRegistrar(forensicRegistrar, 'forensics');
  forensics.registerTool('debug_time_travel');
  const hiddenRaw = forensics.registerTool('debug_evaluate');
  assert.deepEqual(forensicRegistered, ['debug_time_travel']);
  assert.equal(typeof hiddenRaw.remove, 'function');

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
