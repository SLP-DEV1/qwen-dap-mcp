import { McpServer } from '@modelcontextprotocol/server';

import { DapSessionRegistry } from './dap/session-registry.js';
import { registerAgentDiagnosticTools } from './tools/agent-diagnostics.js';
import { registerDifferentialTools } from './tools/register-differential-tools.js';
import { registerHangDiagnosticTool } from './tools/hang-diagnostics.js';
import { registerDebugTools } from './tools/register-debug-tools.js';
import { registerDumpTools } from './tools/register-dump-tools.js';
import { registerFindWriterTool } from './tools/find-writer.js';
import { registerGdbDapTools } from './tools/register-gdb-dap-tools.js';
import { registerLldbDapTools } from './tools/register-lldb-dap-tools.js';
import { registerRunToStopTool } from './tools/run-to-stop.js';
import { registerSessionTools } from './tools/register-session-tools.js';
import { routeSessionToolRegistrar } from './tools/session-routing.js';
import { annotateToolRegistrar, filterToolRegistrar, resolveToolsetMode } from './toolset.js';
import { packageVersion } from './version.js';

export function createServer(): McpServer {
  const sessions = new DapSessionRegistry();
  const session = sessions.createRoutedSession();
  const toolsetMode = resolveToolsetMode();
  const server = new McpServer(
    {
      name: 'qwen-dap-mcp',
      version: packageVersion,
    },
    {
      instructions:
        `Toolset=${toolsetMode}. Multi-session routing is available: use debug_sessions to create/list/close isolated debugger sessions, then pass sessionId to any debug_* tool that should operate on a non-default session. Omitting sessionId preserves the backward-compatible default session. Session selection is request-local, not global, so concurrent MCP calls can safely target different debugger sessions. Thread the same sessionId through an entire diagnosis/reproduction workflow and never combine evidence from different session IDs unless you are intentionally using debug_compare_runs, which explicitly compares a baselineSessionId and candidateSessionId without resuming either target. For differential debugging, prefer semantic changed/added/removed values over unstable raw-address differences and treat firstMeaningfulDifference as a prioritization hint rather than proof of causality. Use debug_this_crash as the highest-level crash workflow and debug_this_hang as the highest-level hang/deadlock workflow. For agentic crash fixing, prefer workflow.stage="autonomous": protocolVersion=2 returns serialized autonomousAgent state, ordered dependency-aware nextActions, rootCauseBacktrack runtime provenance, verificationQuality, crash fingerprints, bounded iteration history, and deterministic stop conditions. Honor each action.requires dependency before executing it. The normal crash chain is inspect-source -> propose-fix -> apply-fix -> build -> reproduce -> verify using normal authorized coding/build tools; qwen-dap-mcp intentionally remains a debugger bridge, not a general shell/source-writing executor. Pass workflow.autonomousAgent.state back unchanged on the next reproduction. A changed-failure is re-baselined for diagnosis; do not automatically roll back a patch because the changed crash may be a downstream defect exposed by the original fix. For hangs, read allThreadTriage, deadlock, and pointerProvenance before making a concurrency claim. A deadlock-candidate is heuristic only: generic DAP does not provide a portable lock-owner graph, so cycleProven remains false unless independent adapter-specific evidence establishes ownership edges. Prefer analysis.projectRoots/projectModules so the bridge can distinguish runnable project-controlled work from runtime/system waits. Keep raw faultLocation/faultCorrelation separate from projectFrame/operandAnalysis when the literal crash is in runtime code. Read classification, projectFrame, operandAnalysis, callChain, rootCauseBacktrack, fixWorkflow, verificationBaseline, verificationQuality, and autonomousAgent before making a crash root-cause claim. Only a complete successful terminal reproduction is strong fix evidence; breakpoint/entry/pause/step/configured first-chance exception stops are inconclusive. Verification source paths are canonicalized for Windows separator/case differences. Use debug_diagnose_stop for intelligent analysis on an existing crash stop, debug_source_disassembly for raw fault correlation plus selected project-frame operand context, debug_find_writer after a stopped live diagnosis when a suspicious value needs a temporary data-breakpoint/watchpoint to identify its immediate runtime writer, debug_open_dump for postmortem inspection, and debug_run_to_stop for lower-level initialized DAP workflows. Never use debug_find_writer for frozen dumps or when resuming the target is unsafe. CodeLLDB, upstream LLVM lldb-dap, and GNU GDB DAP are first-class adapter paths; full toolset mode also exposes their manual discovery/start/launch/attach helpers. The default agent toolset intentionally hides manual low-level debugger schemas to reduce MCP context. Set QWEN_DAP_MCP_TOOLSET=full when manual breakpoints, watchpoints, evaluate, memory, module, or step tools are required. Keep the MCP server untrusted so the user can review debugger actions.`,
    },
  );

  const annotatedServer = annotateToolRegistrar(server);
  const routedServer = routeSessionToolRegistrar(annotatedServer, sessions);
  const registrationServer = filterToolRegistrar(routedServer, toolsetMode);
  registerSessionTools(registrationServer, sessions);
  registerDifferentialTools(registrationServer, sessions);
  registerDebugTools(registrationServer, session);
  registerLldbDapTools(registrationServer, session);
  registerGdbDapTools(registrationServer, session);
  registerRunToStopTool(registrationServer, session);
  registerAgentDiagnosticTools(registrationServer, session);
  registerHangDiagnosticTool(registrationServer, session);
  registerFindWriterTool(registrationServer, session);
  registerDumpTools(registrationServer, session);

  const closeServer = server.close.bind(server);
  server.close = async () => {
    await sessions.closeAll(false);
    await closeServer();
  };

  return server;
}
