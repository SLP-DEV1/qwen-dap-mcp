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
      version: '0.9.0',
    },
    {
      instructions:
        'Use debug_this_crash as the highest-level workflow. It can diagnose the current stop, run an initialized live session, auto-start CodeLLDB for a local native program, or open a crash dump. Prefer analysis.projectRoots/projectModules when known so the bridge can select the first likely project-controlled frame, then read projectFrame, operandAnalysis, callChain, fixWorkflow, and verificationBaseline before making a root-cause claim. After an evidence-backed source fix and rebuild with normal coding/build tools, repeat the same debug_this_crash scenario with workflow.stage="verify" and the original verificationBaseline. Only a complete successful terminal reproduction is strong fix evidence; breakpoint/entry stops are inconclusive. Use debug_diagnose_stop for the same intelligent analysis on an existing stop, debug_source_disassembly for focused source/operand/register correlation, debug_open_dump for raw postmortem inspection, and debug_run_to_stop for lower-level initialized DAP workflows. Keep the MCP server untrusted so the user can review debugger actions.',
    },
  );

  registerDebugTools(server, session);
  registerRunToStopTool(server, session);
  registerAgentDiagnosticTools(server, session);
  registerDumpTools(server, session);
  return server;
}
