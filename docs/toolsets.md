# MCP toolsets

qwen-dap-mcp exposes three MCP schema surfaces. The debugger implementation underneath is the same; the toolset only controls which tool schemas the MCP client sees.

## `agent` — default, 18 core tools

`agent` is optimized for coding agents and keeps the MCP context surface intentionally small:

- `debug_this_crash`
- `debug_this_hang`
- `debug_compare_runs`
- `debug_trace_value`
- `debug_causal_trace`
- `debug_progress_probe`
- `debug_runtime_report`
- `debug_trace_lifetime`
- `debug_adaptive_evidence`
- `debug_diagnose_stop`
- `debug_source_disassembly`
- `debug_find_writer`
- `debug_run_to_stop`
- `debug_open_dump`
- `debug_snapshot`
- `debug_status`
- `debug_disconnect`
- `debug_sessions`

No environment variable is required:

```bash
npx -y @slp-dev1/qwen-dap-mcp
```

Or set it explicitly with `QWEN_DAP_MCP_TOOLSET=agent`.

## `forensics` — high-level deep-debugging surface

Use `forensics` when the investigation needs specialized workflows but not raw manual DAP commands. It includes every `agent` tool plus:

- `debug_reverse_execution`
- `debug_cluster_crashes`
- `debug_regression_oracle`
- `debug_child_requests`
- `debug_time_travel`
- `debug_thread_timeline`
- `debug_symbol_doctor`
- `debug_dump_batch`
- `debug_crash_families`
- `debug_cpp_object`
- `debug_evidence_bundle`
- `debug_adapter_doctor`

```bash
QWEN_DAP_MCP_TOOLSET=forensics npx -y @slp-dev1/qwen-dap-mcp
```

The `advanced` security profile defaults to this surface. It does **not** automatically expose raw `evaluate`, breakpoint mutation, stepping, memory inspection, or adapter lifecycle commands.

## `full` — manual debugger surface

Use `full` only when the client or user intentionally needs low-level DAP operations such as manual breakpoint/watchpoint management, stepping, expression evaluation, direct memory reads, module inspection, raw thread/stack/scope traversal, or explicit remote-debug attach helpers.

```bash
QWEN_DAP_MCP_TOOLSET=full npx -y @slp-dev1/qwen-dap-mcp
```

The full toolset remains backwards compatible with the legacy manual surface. Hardened remote helpers remain hidden from `agent` and `forensics` unless a high-level workflow uses them internally.

Most routed `debug_*` tools accept an optional `sessionId`. Omitting it targets the backwards-compatible `default` session. `debug_sessions` manages the registry itself, while `debug_compare_runs` intentionally reads two explicit sessions through `baselineSessionId` and `candidateSessionId`.

Session selection is request-local via `AsyncLocalStorage`, so concurrent MCP calls can safely target different debugger sessions without a process-global selected-session variable.

## Differential and causal debugging

`debug_compare_runs` is inspection-only. It compares two already-stopped sessions, normalizes unstable address-only differences, and reports prioritized semantic differences plus the explicit `evidenceBudget` used for capture.

`debug_trace_value` is different: it installs a temporary data breakpoint/watchpoint and resumes the target to collect a bounded writer timeline. It is therefore target-control behavior, is invalid for frozen postmortem sessions, and remains subject to the normal DAP policy and optional HOL Guard checks.

See [differential-debugging.md](differential-debugging.md), [advanced-runtime-debugging.md](advanced-runtime-debugging.md), and [runtime-debugging-v2.md](runtime-debugging-v2.md) for the high-level evidence workflows.

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
