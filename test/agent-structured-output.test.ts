import assert from 'node:assert/strict';
import test from 'node:test';

import { DapSessionRegistry } from '../src/dap/session-registry.js';
import { registerAgentDiagnosticTools } from '../src/tools/agent-diagnostics.js';
import { AGENT_OUTPUT_SCHEMAS, structuredResult } from '../src/tools/agent-output.js';
import { registerFindWriterTool } from '../src/tools/find-writer.js';
import { registerHangDiagnosticTool } from '../src/tools/hang-diagnostics.js';
import { registerDebugTools } from '../src/tools/register-debug-tools.js';
import { registerDifferentialTools } from '../src/tools/register-differential-tools.js';
import { registerDumpTools } from '../src/tools/register-dump-tools.js';
import { registerRunToStopTool } from '../src/tools/run-to-stop.js';
import { registerSessionTools } from '../src/tools/register-session-tools.js';
import { registerValueTracingTool } from '../src/tools/value-tracing.js';
import { AGENT_TOOL_NAMES } from '../src/toolset.js';

function captureRegistrations() {
  const registrations = new Map<string, { config: Record<string, unknown>; handler: (...args: any[]) => unknown }>();
  const server = {
    registerTool(name: string, config: Record<string, unknown>, handler: (...args: any[]) => unknown) {
      registrations.set(name, { config, handler });
      return { disable() {}, enable() {}, update() {}, remove() {} };
    },
  };
  const status = {
    adapterRunning: false,
    initialized: false,
    configured: false,
    recentEvents: [],
    recentAdapterStderr: [],
  };
  const session = { snapshot: () => status };
  const registry = new DapSessionRegistry();

  registerSessionTools(server as never, registry);
  registerDifferentialTools(server as never, registry);
  registerAgentDiagnosticTools(server as never, session as never);
  registerHangDiagnosticTool(server as never, session as never);
  registerFindWriterTool(server as never, session as never);
  registerValueTracingTool(server as never, session as never);
  registerRunToStopTool(server as never, session as never);
  registerDumpTools(server as never, session as never);
  registerDebugTools(server as never, session as never);
  return { registrations, status };
}

test('every default agent tool declares an MCP v2 output schema', () => {
  assert.deepEqual(new Set(Object.keys(AGENT_OUTPUT_SCHEMAS)), new Set(AGENT_TOOL_NAMES));
  const { registrations } = captureRegistrations();
  for (const name of AGENT_TOOL_NAMES) {
    const registration = registrations.get(name);
    assert.ok(registration, 'missing registration for ' + name);
    assert.ok(registration.config.outputSchema, name + ' is missing outputSchema');
  }
});

test('structuredResult keeps legacy text content and emits equivalent structuredContent', () => {
  const value = { disconnected: true, nested: { omitted: undefined, value: 7 } };
  const result = structuredResult(value);
  assert.deepEqual(result.structuredContent, { disconnected: true, nested: { value: 7 } });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
});

test('debug_status returns validated structured content as well as the legacy JSON text block', async () => {
  const { registrations, status } = captureRegistrations();
  const registration = registrations.get('debug_status');
  assert.ok(registration);
  const result = await registration.handler({}) as { content: Array<{ text: string }>; structuredContent: unknown };
  assert.deepEqual(result.structuredContent, status);
  assert.deepEqual(JSON.parse(result.content[0].text), status);
  const schema = registration.config.outputSchema as { safeParse(value: unknown): { success: boolean } };
  assert.equal(schema.safeParse(result.structuredContent).success, true);
});

test('debug_sessions returns structured list/create output matching its schema', async () => {
  const { registrations } = captureRegistrations();
  const registration = registrations.get('debug_sessions');
  assert.ok(registration);
  const result = await registration.handler({ action: 'create', terminateDebuggee: true }) as {
    structuredContent: { action: string; sessionId?: string; sessions: unknown[] };
  };
  assert.equal(result.structuredContent.action, 'create');
  assert.equal(result.structuredContent.sessionId, 'session-1');
  assert.equal(result.structuredContent.sessions.length, 2);
  const schema = registration.config.outputSchema as { safeParse(value: unknown): { success: boolean } };
  assert.equal(schema.safeParse(result.structuredContent).success, true);
});
