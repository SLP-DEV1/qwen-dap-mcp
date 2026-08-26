# MCP toolsets

qwen-dap-mcp exposes two MCP tool surfaces. The debugger implementation underneath is the same; the toolset only controls which tool schemas the MCP client sees.

## `agent` — default

`agent` is optimized for coding agents. It keeps the MCP schema/context surface compact and exposes fourteen high-level workflows and session-management tools:

- `debug_this_crash` — high-level crash diagnosis, verification, and bounded autonomous workflow
- `debug_this_hang` — bounded all-thread hang/deadlock triage with wait heuristics and Pointer-Provenance v2
- `debug_compare_runs` — read-only semantic comparison of two explicit stopped sessions
- `debug_trace_value` — bounded temporal writer timeline for a suspicious value in one live session
- `debug_diagnose_stop` — intelligent analysis of an already stopped crash
- `debug_source_disassembly` — source/instruction/register correlation
- `debug_find_writer` — one-shot data-breakpoint/watchpoint workflow for a suspicious value
- `debug_run_to_stop` — lower-level launch/attach until the next stop or exit
- `debug_open_dump` — read-only core/minidump inspection
- `debug_snapshot` — bounded raw stopped-state evidence
- `debug_status` — current debugger/session status
- `debug_continue` — resume an authorized live target
- `debug_disconnect` — tear down the routed debugger session
- `debug_sessions` — list, create, or close isolated DAP sessions

Most routed `debug_*` tools accept an optional `sessionId`. Omitting it targets the backwards-compatible `default` session, and non-default sessions must be created first with `debug_sessions(action="create", sessionId=...)`.

There are two important exceptions:

- `debug_sessions` manages the registry itself rather than routing through one current session.
- `debug_compare_runs` intentionally reads two sessions at once and therefore accepts `baselineSessionId` plus `candidateSessionId` instead of a single `sessionId`.

`debug_trace_value` is a normal single-session routed tool and therefore uses `sessionId`.

Session selection is request-local. qwen-dap-mcp uses `AsyncLocalStorage` rather than a process-global selected-session variable, so concurrent MCP calls can safely target different sessions. Each real session owns its own DAP connection, lifecycle guard, postmortem state, event history, breakpoint/watchpoint state, timeout state, operation state, and HOL Guard context. A session with an active routed request cannot be closed out from under that request.

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

The full toolset remains backwards compatible with the pre-v0.12 public tool surface. Hardened remote helpers such as `debug_attach_gdb_remote` and `debug_attach_lldb_dap_remote` remain hidden from the compact `agent` schema surface.

## Differential and causal debugging

`debug_compare_runs` is inspection-only. It compares two already-stopped sessions, normalizes unstable address-only differences, and reports prioritized semantic differences plus the explicit `evidenceBudget` used for capture.

`debug_trace_value` is different: it installs a temporary data breakpoint/watchpoint and resumes the target to collect a bounded writer timeline. It is therefore target-control behavior, is invalid for frozen postmortem sessions, and remains subject to the normal DAP policy and optional HOL Guard checks.

See [differential-debugging.md](differential-debugging.md) for the v0.17 workflow.

## Remote debugging safety

Remote debug servers are powerful process-control endpoints and generally should not be exposed directly to untrusted networks. qwen-dap-mcp therefore treats remote targets as structured TCP endpoints rather than arbitrary debugger command strings.

Loopback hosts are allowed by default. Non-loopback hosts are denied unless the exact hostname or IP is present in `QWEN_DAP_MCP_REMOTE_DEBUG_HOSTS`, for example:

```bash
export QWEN_DAP_MCP_REMOTE_DEBUG_HOSTS=debugbox.internal,10.20.30.40
```

Prefer SSH/VPN tunneling so the debugger adapter still connects to `127.0.0.1` or `localhost`. The GDB path does not accept arbitrary target syntax, and the lldb-dap compatibility path generates exactly one `gdb-remote host:port` command from the already validated endpoint instead of exposing free-form LLDB commands.

See [remote-debugging.md](remote-debugging.md) for the supported gdbserver/lldb-server workflow and threat model.

## Hang workflow safety

`debug_this_hang` can pause a live target and its launch/attach modes can execute or take debugger control of an authorized process. Those DAP boundaries use the same built-in policy and optional HOL Guard enforcement as the corresponding low-level `launch`, `attach`, and `pause` operations.

All-thread wait/deadlock results are deliberately heuristic. Generic DAP has no portable lock-owner graph, so `deadlock-candidate` means the captured state is consistent with deadlock; it does not claim a proven cycle. Pointer-Provenance v2 similarly treats repeated pointer values across threads as correlation evidence, not proof of lock ownership or causality.

## Why the compact default matters

MCP clients usually include tool names, descriptions, and schemas in model context. Native debuggers naturally expose many small operations, but a coding agent fixing a crash or hang rarely needs every low-level schema at once. The compact toolset keeps the agent focused on evidence collection and the diagnose → compare/trace → fix → reproduce → verify loop while preserving the complete debugger surface as an opt-in mode.

An invalid `QWEN_DAP_MCP_TOOLSET` value falls back to the safe `agent` toolset with a warning.
