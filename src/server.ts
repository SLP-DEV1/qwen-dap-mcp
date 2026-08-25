import { McpServer } from '@modelcontextprotocol/server';

import { DapSession } from './dap/session.js';
import { registerDebugTools } from './tools/register-debug-tools.js';
import { registerDumpTools } from './tools/register-dump-tools.js';

export function createServer(): McpServer {
  const session = new DapSession();
  const server = new McpServer(
    {
      name: 'qwen-dap-mcp',
      version: '0.7.0',
    },
    {
      instructions:
        'Use debug_open_dump for postmortem crash dumps. For live targets use debug_start before debug_launch/debug_attach. Keep the MCP server untrusted so the user can review debugger actions. Prefer debug_snapshot for bounded stop-state inspection.',
    },
  );

  registerDebugTools(server, session);
  registerDumpTools(server, session);
  return server;
}
