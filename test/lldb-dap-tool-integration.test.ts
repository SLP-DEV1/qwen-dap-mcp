import assert from 'node:assert/strict';
import test from 'node:test';
import type { z } from 'zod';

import { registerAgentDiagnosticTools } from '../src/tools/agent-diagnostics.js';
import { registerDumpTools } from '../src/tools/register-dump-tools.js';
import { registerLldbDapTools } from '../src/tools/register-lldb-dap-tools.js';
import { AGENT_TOOL_NAMES, filterToolRegistrar } from '../src/toolset.js';

type ToolDefinition = { inputSchema?: z.ZodTypeAny };

function collector() {
  const definitions = new Map<string, ToolDefinition>();
  return {
    definitions,
    server: {
      registerTool(name: string, config: ToolDefinition) {
        definitions.set(name, config);
      },
    },
  };
}

test('debug_this_crash accepts first-class lldb-dap mode and lldb-dap dump selection', () => {
  const { definitions, server } = collector();
  registerAgentDiagnosticTools(server as never, {} as never);
  const schema = definitions.get('debug_this_crash')?.inputSchema;
  assert.ok(schema, 'debug_this_crash schema was not registered');

  const live = schema.parse({ mode: 'lldb-dap', program: '/tmp/example' }) as Record<string, unknown>;
  assert.equal(live.mode, 'lldb-dap');

  const dump = schema.parse({
    mode: 'dump',
    dumpPath: '/tmp/example.core',
    program: '/tmp/example',
    dumpAdapter: 'lldb-dap',
  }) as Record<string, unknown>;
  assert.equal(dump.dumpAdapter, 'lldb-dap');
});

test('debug_open_dump exposes lldb-dap as an opt-in adapter while preserving CodeLLDB default', () => {
  const { definitions, server } = collector();
  registerDumpTools(server as never, {} as never);
  const schema = definitions.get('debug_open_dump')?.inputSchema;
  assert.ok(schema, 'debug_open_dump schema was not registered');

  const defaulted = schema.parse({ dumpPath: '/tmp/example.core' }) as Record<string, unknown>;
  assert.equal(defaulted.adapter, 'codelldb');

  const upstream = schema.parse({
    dumpPath: '/tmp/example.core',
    program: '/tmp/example',
    adapter: 'lldb-dap',
  }) as Record<string, unknown>;
  assert.equal(upstream.adapter, 'lldb-dap');
});

test('manual lldb-dap helpers are hidden by the compact agent toolset', () => {
  const full = collector();
  registerLldbDapTools(full.server as never, {} as never);
  assert.deepEqual([...full.definitions.keys()], [
    'debug_lldb_dap_info',
    'debug_start_lldb_dap',
    'debug_launch_lldb_dap',
    'debug_attach_lldb_dap',
  ]);

  const compact = collector();
  const filtered = filterToolRegistrar(compact.server as never, new Set<string>(AGENT_TOOL_NAMES));
  registerLldbDapTools(filtered as never, {} as never);
  assert.equal(compact.definitions.size, 0);
});
