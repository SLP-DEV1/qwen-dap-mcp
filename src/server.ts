import { McpServer } from '@modelcontextprotocol/server';

import { GuardedDapSession } from './dap/guarded-session.js';
import { registerAgentDiagnosticTools } from './tools/agent-diagnostics.js';
import { registerDebugTools } from './tools/register-debug-tools.js';
import { registerDumpTools } from './tools/register-dump-tools.js';
import { registerRunToStopTool } from './tools/run-to-stop.js';
import { packageVersion } from './version.js';

export function createServer(): McpServer {
  const session = new GuardedDapSession();
  const server = new McpServer(
    {
      name: 'qwen-dap-mcp',
      version: packageVersion,
    },
    {
      instructions:
        'Use debug_this_crash as the highest-level workflow. For agentic crash fixing, prefer workflow.stage="autonomous": protocolVersion=2 returns serialized autonomousAgent state, ordered dependency-aware nextActions, rootCauseBacktrack runtime provenance, verificationQuality, crash fingerprints, bounded iteration history, and deterministic stop conditions. Honor each action.requires dependency before executing it. The normal chain is inspect-source -> propose-fix -> apply-fix -> build -> reproduce -> verify using normal authorized coding/build tools; qwen-dap-mcp intentionally remains a debugger bridge, not a general shell/source-writing executor. Pass workflow.autonomousAgent.state back unchanged on the next reproduction. A changed-failure is re-baselined for diagnosis; do not automatically roll back a patch because the changed crash may be a downstream defect exposed by the original fix. Prefer analysis.projectRoots/projectModules so the bridge can select the first likely project-controlled frame. Keep raw faultLocation/faultCorrelation separate from projectFrame/operandAnalysis when the literal crash is in runtime code. Read classification, projectFrame, operandAnalysis, callChain, rootCauseBacktrack, fixWorkflow, verificationBaseline, verificationQuality, and autonomousAgent before making a root-cause claim. Only a complete successful terminal reproduction is strong fix evidence; breakpoint/entry/pause/step/configured first-chance exception stops are inconclusive. Verification source paths are canonicalized for Windows separator/case differences. Use debug_diagnose_stop for intelligent analysis on an existing stop, debug_source_disassembly for raw fault correlation plus selected project-frame operand context, debug_open_dump for postmortem inspection, and debug_run_to_stop for lower-level initialized DAP workflows. Keep the MCP server untrusted so the user can review debugger actions.',
    },
  );

  registerDebugTools(server, session);
  registerRunToStopTool(server, session);
  registerAgentDiagnosticTools(server, session);
  registerDumpTools(server, session);
  return server;
}
