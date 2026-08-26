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
      version: '0.10.0',
    },
    {
      instructions:
        'Use debug_this_crash as the highest-level workflow. For agentic crash fixing, prefer workflow.stage="autonomous": the first run creates a serialized autonomousAgent state with a crash fingerprint, evidence gate, bounded iteration budget, history, and ordered nextActions. After using normal authorized coding/build tools for the requested inspect/edit/rebuild actions, repeat the exact debug_this_crash scenario with workflow.stage="autonomous" and pass workflow.autonomousAgent.state unchanged. The bridge verifies the active crash fingerprint and decides whether to stop as fixed, retry with a revised fix, broaden diagnosis after repeated identical failures, re-baseline a changed crash while preserving the original root fingerprint, request more reproduction evidence, or stop at the iteration budget. Prefer analysis.projectRoots/projectModules when known so the bridge can select the first likely project-controlled frame, then read projectFrame, operandAnalysis, callChain, fixWorkflow, verificationBaseline, and autonomousAgent before making a root-cause claim. Only a complete successful terminal reproduction is strong fix evidence; breakpoint/entry stops are inconclusive and must not trigger another edit. qwen-dap-mcp intentionally remains a debugger bridge, not a general shell/source-writing executor. Use debug_diagnose_stop for intelligent analysis on an existing stop, debug_source_disassembly for focused source/operand/register correlation, debug_open_dump for raw postmortem inspection, and debug_run_to_stop for lower-level initialized DAP workflows. Keep the MCP server untrusted so the user can review debugger actions.',
    },
  );

  registerDebugTools(server, session);
  registerRunToStopTool(server, session);
  registerAgentDiagnosticTools(server, session);
  registerDumpTools(server, session);
  return server;
}
