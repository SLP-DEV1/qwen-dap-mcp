import { McpServer } from '@modelcontextprotocol/server';

import { GuardedDapSession } from './dap/guarded-session.js';
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
        'Use debug_open_dump for postmortem crash dumps. For live targets use debug_start before debug_launch/debug_attach, or debug_run_to_stop to launch/attach and capture the next stop or exit in one call. Keep the MCP server untrusted so the user can review debugger actions. Prefer debug_snapshot for bounded stop-state inspection.',
    },
  );

  registerDebugTools(server, session);
  registerRunToStopTool(server, session);
  registerDumpTools(server, session);
  return server;
}
