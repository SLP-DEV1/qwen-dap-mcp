import assert from 'node:assert/strict';
import test from 'node:test';
import * as z from 'zod/v4';

import { GuardedDapSession } from '../src/dap/guarded-session.js';
import { DapSession } from '../src/dap/session.js';
import { registerAgentDiagnosticTools } from '../src/tools/agent-diagnostics.js';
import { registerDebugTools } from '../src/tools/register-debug-tools.js';
import { registerDumpTools } from '../src/tools/register-dump-tools.js';
import { registerRunToStopTool } from '../src/tools/run-to-stop.js';
import { AGENT_TOOL_NAMES } from '../src/toolset.js';

type ToolDefinition = {
  title?: string;
  description?: string;
  inputSchema?: z.ZodType;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

function collectToolDefinitions() {
  const definitions = new Map<string, ToolDefinition>();
  const server = {
    registerTool(name: string, definition: ToolDefinition) {
      definitions.set(name, definition);
      return { name };
    },
  };

  registerDebugTools(server as never, {} as DapSession);
  registerAgentDiagnosticTools(server as never, {} as GuardedDapSession);
  registerRunToStopTool(server as never, {} as never);
  registerDumpTools(server as never, {} as GuardedDapSession);
  return definitions;
}

function topLevelProperties(schema: z.ZodType): Record<string, { description?: string }> {
  const jsonSchema = z.toJSONSchema(schema) as {
    properties?: Record<string, { description?: string }>;
  };
  return jsonSchema.properties ?? {};
}

test('every default agent tool has complete selection and behavior metadata', () => {
  const definitions = collectToolDefinitions();

  for (const name of AGENT_TOOL_NAMES) {
    const definition = definitions.get(name);
    assert.ok(definition, `${name} must be registered`);
    assert.ok(definition.title?.trim(), `${name} must have a title`);
    assert.ok(
      (definition.description?.trim().length ?? 0) >= 180,
      `${name} description must explain purpose, selection guidance, and behavior`,
    );
    assert.match(
      definition.description ?? '',
      /\buse\b/i,
      `${name} description must explain when to use the tool`,
    );

    const annotations = definition.annotations;
    assert.ok(annotations, `${name} must declare MCP tool annotations`);
    for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
      assert.equal(typeof annotations[key], 'boolean', `${name}.${key} must be explicit`);
    }

    if (!definition.inputSchema) continue;
    const properties = topLevelProperties(definition.inputSchema);
    for (const [propertyName, property] of Object.entries(properties)) {
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
    assert.equal(annotations?.openWorldHint, false, `${name} is local-only`);
  }

  for (const name of ['debug_this_crash', 'debug_run_to_stop', 'debug_continue', 'debug_disconnect']) {
    assert.equal(
      definitions.get(name)?.annotations?.readOnlyHint,
      false,
      `${name} can change live debugger/target state`,
    );
  }

  assert.equal(definitions.get('debug_this_crash')?.annotations?.destructiveHint, true);
  assert.equal(definitions.get('debug_run_to_stop')?.annotations?.destructiveHint, true);
  assert.equal(definitions.get('debug_disconnect')?.annotations?.destructiveHint, true);
  assert.equal(definitions.get('debug_continue')?.annotations?.destructiveHint, false);
});
