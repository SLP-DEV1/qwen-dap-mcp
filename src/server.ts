import { McpServer } from '@modelcontextprotocol/server';

import { GuardedDapSession } from './dap/guarded-session.js';
import { registerAgentDiagnosticTools } from './tools/agent-diagnostics.js';
import { registerDebugTools } from './tools/register-debug-tools.js';
import { registerDumpTools } from './tools/register-dump-tools.js';
import { registerRunToStopTool } from './tools/run-to-stop.js';

export function createServer(): McpServer {
  const session = new GuardedDapSession();
  const server = new McpServer(
    {
      name: 'qwen-dap-mcp',
      version: '0.7.1',
    },
    {
      instructions:
        'Use debug_this_crash for the highest-level agent workflow: diagnose the current stop, run an initialized live session, auto-start CodeLLDB for a local native program, or open a crash dump. Use debug_diagnose_stop for structured likely-cause analysis of an existing stop and debug_source_disassembly for source/instruction correlation. Use debug_open_dump for raw postmortem inspection. For lower-level live targets use debug_start before debug_launch/debug_attach, or debug_run_to_stop to capture the next stop or exit in one call. Keep the MCP server untrusted so the user can review debugger actions.',
    },
  );

  registerDebugTools(server, session);
  registerRunToStopTool(server, session);
  registerAgentDiagnosticTools(server, session);
  registerDumpTools(server, session);
  return server;
}
