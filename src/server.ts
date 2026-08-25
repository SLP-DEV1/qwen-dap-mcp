import { McpServer } from '@modelcontextprotocol/server';

import { DapSession } from './dap/session.js';
import { registerDebugTools } from './tools/register-debug-tools.js';

export function createServer(): McpServer {
  const session = new DapSession();
  const server = new McpServer(
    {
      name: 'qwen-dap-mcp',
      version: '0.1.0',
    },
    {
      instructions:
        'Use debug_start before debug_launch/debug_attach. Keep the MCP server untrusted so the user can review debugger actions. Prefer debug_threads -> debug_stack -> debug_scopes -> debug_variables when diagnosing a stop.',
    },
  );

  registerDebugTools(server, session);
  return server;
}
