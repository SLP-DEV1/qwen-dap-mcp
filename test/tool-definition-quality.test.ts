import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { registerAgentDiagnosticTools } from '../src/tools/agent-diagnostics.js';
import { registerDebugTools } from '../src/tools/register-debug-tools.js';
import { registerDumpTools } from '../src/tools/register-dump-tools.js';
import { registerRunToStopTool } from '../src/tools/run-to-stop.js';
import { AGENT_TOOL_NAMES, filterToolRegistrar } from '../src/toolset.js';

type ToolDefinition = {
  description?: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  inputSchema?: z.ZodTypeAny;
};

function collectToolDefinitions(): Map<string, ToolDefinition> {
  const definitions = new Map<string, ToolDefinition>();
  const server = {
    registerTool(name: string, config: ToolDefinition) {
      definitions.set(name, config);
    },
  };
  const agentServer = filterToolRegistrar(server as never, new Set<string>(AGENT_TOOL_NAMES));
  const session = {} as never;

  registerDebugTools(agentServer as never, session);
  registerDumpTools(agentServer as never, session);
  registerRunToStopTool(agentServer as never, session);
  registerAgentDiagnosticTools(agentServer as never, session);

  return definitions;
}

test('every default agent tool has complete selection and behavior metadata', () => {
  const definitions = collectToolDefinitions();

  assert.deepEqual([...definitions.keys()].sort(), [...AGENT_TOOL_NAMES].sort());

  for (const name of AGENT_TOOL_NAMES) {
    const definition = definitions.get(name);
    assert.ok(definition, `${name} must be registered`);

    const description = definition.description?.trim() ?? '';
    assert.ok(description.length >= 120, `${name} description should contain enough operational context`);
    assert.match(description, /\buse\b/i, `${name} description should explain when to use it`);
    assert.match(description, /\bdo not use\b|\binstead\b|\bonly\b/i, `${name} description should bound misuse or alternatives`);

    const annotations = definition.annotations;
    assert.ok(annotations, `${name} must advertise MCP behavior annotations`);
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
      assert.equal(typeof annotations[hint], 'boolean', `${name}.${hint} must be explicit`);
    }

    if (!definition.inputSchema) continue;
    const jsonSchema = z.toJSONSchema(definition.inputSchema) as {
      properties?: Record<string, { description?: string }>;
    };
    for (const [propertyName, property] of Object.entries(jsonSchema.properties ?? {})) {
      assert.ok(
        property.description?.trim(),
        `${name}.${propertyName} must explain parameter semantics`,
      );
    }
  }
});

test('agent tool annotations distinguish inspection from target execution', () => {
  const definitions = collectToolDefinitions();

  for (const name of [
    'debug_diagnose_stop',
    'debug_source_disassembly',
    'debug_open_dump',
    'debug_snapshot',
    'debug_status',
  ]) {
    const annotations = definitions.get(name)?.annotations;
    assert.equal(annotations?.readOnlyHint, true, `${name} should advertise read-only inspection`);
    assert.equal(annotations?.destructiveHint, false, `${name} should advertise non-destructive inspection`);
    assert.equal(annotations?.openWorldHint, false, `${name} is local-only inspection`);
  }

  for (const name of ['debug_this_crash', 'debug_run_to_stop', 'debug_continue', 'debug_disconnect']) {
    assert.equal(
      definitions.get(name)?.annotations?.readOnlyHint,
      false,
      `${name} can change live debugger/target state`,
    );
  }

  for (const name of ['debug_this_crash', 'debug_run_to_stop', 'debug_continue']) {
    assert.equal(
      definitions.get(name)?.annotations?.destructiveHint,
      true,
      `${name} can execute target code with application side effects`,
    );
    assert.equal(
      definitions.get(name)?.annotations?.openWorldHint,
      true,
      `${name} can let the debuggee interact with files, processes, or networks`,
    );
  }

  assert.equal(definitions.get('debug_disconnect')?.annotations?.destructiveHint, true);
  assert.equal(definitions.get('debug_disconnect')?.annotations?.openWorldHint, false);
});
