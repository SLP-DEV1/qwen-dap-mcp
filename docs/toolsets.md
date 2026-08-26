# MCP toolsets

qwen-dap-mcp exposes two MCP tool surfaces. The debugger implementation underneath is the same; the toolset only controls which tool schemas the MCP client sees.

## `agent` — default

`agent` is optimized for coding agents. It keeps the MCP schema/context surface small and exposes the high-level workflows that normally contain enough evidence for crash diagnosis, hang triage, runtime provenance, verification, and multi-session management:

- `debug_this_crash` — high-level crash diagnosis / verification / bounded autonomous workflow
- `debug_this_hang` — bounded all-thread hang/deadlock triage with wait heuristics and Pointer-Provenance v2
- `debug_diagnose_stop` — intelligent analysis of an already stopped crash
- `debug_source_disassembly` — source/instruction/register correlation
- `debug_find_writer` — temporary data-breakpoint/watchpoint workflow for suspicious values
- `debug_run_to_stop` — lower-level launch/attach until the next stop or exit
- `debug_open_dump` — read-only core/minidump inspection
- `debug_snapshot` — bounded raw stopped-state evidence
- `debug_status` — current debugger/session status
- `debug_continue` — resume an authorized live target
- `debug_disconnect` — tear down the routed debugger session
- `debug_sessions` — list, create, or close isolated DAP sessions

Every `debug_*` tool except `debug_sessions` accepts an optional `sessionId`. Omitting it routes the request to the backwards-compatible `default` session. Non-default sessions must be created first with `debug_sessions(action="create", sessionId=...)`.

Session selection is request-local. qwen-dap-mcp uses an async request context rather than a process-global "selected session", so concurrent MCP calls can safely target different sessions. Each real session has its own DAP connection, lifecycle guard, postmortem state, event history, breakpoint/watchpoint state, timeout state, and HOL Guard context. A session with an active routed request cannot be closed out from under that request.

No environment variable is required:

```bash
npx -y @slp-dev1/qwen-dap-mcp
```

Or set it explicitly:

```bash
QWEN_DAP_MCP_TOOLSET=agent npx -y @slp-dev1/qwen-dap-mcp
```

PowerShell:

```powershell
$env:QWEN_DAP_MCP_TOOLSET = 'agent'
npx -y @slp-dev1/qwen-dap-mcp
```

## `full` — manual debugger surface

Use `full` when the client or user intentionally needs low-level DAP operations such as manual breakpoint/watchpoint management, stepping, expression evaluation, direct memory reads, module inspection, raw thread/stack/scope traversal, or explicit remote-debug attach helpers.

```bash
QWEN_DAP_MCP_TOOLSET=full npx -y @slp-dev1/qwen-dap-mcp
```

PowerShell:

```powershell
$env:QWEN_DAP_MCP_TOOLSET = 'full'
npx -y @slp-dev1/qwen-dap-mcp
```

The full toolset remains backwards compatible with the pre-v0.12 public tool surface. v0.16 adds hardened remote attach helpers such as `debug_attach_gdb_remote` and `debug_attach_lldb_dap_remote`; these remain hidden from the compact `agent` schema surface.

## Remote debugging safety

Remote debug servers are powerful process-control endpoints and generally should not be exposed directly to untrusted networks. qwen-dap-mcp therefore treats remote targets as structured TCP endpoints rather than arbitrary debugger command strings.

Loopback hosts are allowed by default. Non-loopback hosts are denied unless the exact hostname or IP is present in `QWEN_DAP_MCP_REMOTE_DEBUG_HOSTS`, for example:

```bash
export QWEN_DAP_MCP_REMOTE_DEBUG_HOSTS=debugbox.internal,10.20.30.40
```

Prefer SSH/VPN tunneling so the MCP still connects to `127.0.0.1` or `localhost`. The GDB path does not accept arbitrary `target` syntax, and the lldb-dap compatibility path generates exactly one `gdb-remote host:port` command from the already validated endpoint instead of exposing free-form LLDB commands.

See [remote-debugging.md](remote-debugging.md) for the supported gdbserver/lldb-server workflow and threat model.

## Hang workflow safety

`debug_this_hang` can pause a live target and its launch/attach modes can execute or take debugger control of an authorized local process. Those DAP boundaries use the same built-in policy and optional HOL Guard enforcement as the corresponding low-level `launch`, `attach`, and `pause` operations.

All-thread wait/deadlock results are deliberately heuristic. Generic DAP has no portable lock-owner graph, so `deadlock-candidate` means the captured state is consistent with deadlock; it does not claim a proven cycle. Pointer-Provenance v2 similarly treats repeated pointer values across threads as correlation evidence, not proof of lock ownership or causality.

## Why the default changed

MCP clients usually include tool names, descriptions, and schemas in model context. Native debuggers naturally expose many small operations, but a coding agent fixing a crash or hang rarely needs every low-level schema at once. The compact toolset keeps the agent focused on evidence collection and the diagnose → fix → reproduce → verify loop while preserving the complete debugger surface as an opt-in mode.

An invalid `QWEN_DAP_MCP_TOOLSET` value falls back to the safe `agent` toolset with a warning.
