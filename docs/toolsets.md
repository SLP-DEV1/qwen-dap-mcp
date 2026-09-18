# MCP toolsets

qwen-dap-mcp exposes three MCP tool surfaces. The debugger implementation underneath is the same; the toolset controls which schemas the MCP client places in model context.

## `agent` — default, 18 tools

`agent` is the compact coding-agent surface. It contains the workflows needed for the normal diagnose → inspect/trace → fix → reproduce → verify loop without loading specialized forensic schemas on every request:

- `debug_this_crash` — high-level crash diagnosis and bounded verification
- `debug_this_hang` — bounded all-thread hang/deadlock triage
- `debug_compare_runs` — semantic baseline/failing-session comparison
- `debug_trace_value` — bounded temporal writer tracing
- `debug_causal_trace` — consumer-to-writer producer chain
- `debug_progress_probe` — no-progress / busy-loop sampling
- `debug_runtime_report` — normalized runtime report with fingerprints and competing hypotheses
- `debug_adapter_doctor` — capability and prerequisite audit
- `debug_diagnose_stop` — diagnosis of an existing stopped state
- `debug_source_disassembly` — source/instruction/register correlation
- `debug_find_writer` — one-shot writer watchpoint workflow
- `debug_run_to_stop` — bounded launch/attach to a meaningful stop
- `debug_open_dump` — postmortem dump/core inspection
- `debug_snapshot` — bounded raw stopped-state evidence
- `debug_status` — current debugger/session state
- `debug_continue` — resume an authorized live target
- `debug_disconnect` — tear down the routed debugger session
- `debug_sessions` — create/list/close isolated sessions

No environment variable is required:

```bash
npx -y @slp-dev1/qwen-dap-mcp
```

Or set it explicitly:

```bash
QWEN_DAP_MCP_TOOLSET=agent npx -y @slp-dev1/qwen-dap-mcp
```

## `forensics` — 32 high-level tools

Use `forensics` when a debugging task needs specialized runtime evidence but should still avoid exposing the raw manual DAP catalog.

It contains every `agent` tool plus:

- `debug_reverse_execution` — capability-gated reverseContinue / stepBack
- `debug_cluster_crashes` — normalized crash clustering
- `debug_regression_oracle` — original/changed/inconclusive reproduction classification
- `debug_child_requests` — inspect captured fail-closed reverse child requests
- `debug_adopt_child` — explicitly adopt one validated child request when `QWEN_DAP_MCP_CHILD_DEBUG=1`
- `debug_time_travel` — rr record, replay plan/start/status/stop, optional hardened GDB attach, and reverse execution
- `debug_trace_lifetime` — object/pointer lifetime provenance
- `debug_thread_timeline` — multi-thread timeline and conservative lock-owner graph
- `debug_symbol_doctor` — binary/symbol identity and local resolver analysis
- `debug_dump_batch` — bounded postmortem batch triage
- `debug_adaptive_evidence` — progressive evidence budgets
- `debug_crash_families` — exact/semantic/family crash comparison
- `debug_cpp_object` — bounded object/vtable inspection
- `debug_evidence_bundle` — JSON/Markdown/SARIF evidence handoff

Enable it with:

```bash
QWEN_DAP_MCP_TOOLSET=forensics npx -y @slp-dev1/qwen-dap-mcp
```

The `advanced` security profile selects `forensics` by default. It does **not** expose raw DAP tools.

## `full` — manual debugger surface

Use `full` only when the client intentionally needs low-level DAP operations such as manual breakpoint/watchpoint management, stepping, expression evaluation, direct memory reads, module inspection, raw thread/stack/scope traversal, or explicit adapter-specific helpers.

```bash
QWEN_DAP_MCP_TOOLSET=full npx -y @slp-dev1/qwen-dap-mcp
```

The full surface remains backwards compatible with the historical low-level MCP API.

## Session routing

Most routed `debug_*` tools accept an optional `sessionId`. Omitting it targets the backwards-compatible `default` session. Non-default sessions must first be created with `debug_sessions(action="create", sessionId=...)`.

Two important exceptions remain:

- `debug_sessions` manages the registry rather than one routed session.
- `debug_compare_runs` explicitly reads `baselineSessionId` and `candidateSessionId`.

Session selection is request-local through `AsyncLocalStorage`, not a process-global selector.

## Differential, causal, and forensic workflows

`debug_compare_runs` is inspection-only and normalizes unstable raw address changes. `debug_trace_value`, `debug_causal_trace`, `debug_trace_lifetime`, `debug_thread_timeline`, reverse execution, and rr workflows can resume or otherwise control an authorized target and therefore remain subject to the DAP policy and optional HOL Guard enforcement.

Child reverse requests remain transport-rejected by default. `debug_adopt_child` is a separate explicit operation: it requires `QWEN_DAP_MCP_CHILD_DEBUG=1`, copies only a small validated launch/attach subset, creates a separate session, and never forwards arbitrary adapter commands.

See [differential-debugging.md](differential-debugging.md), [advanced-runtime-debugging.md](advanced-runtime-debugging.md), and [runtime-debugging-v2.md](runtime-debugging-v2.md).

## Remote debugging safety

Loopback debugger endpoints are allowed by default. Non-loopback hosts require exact entries in `QWEN_DAP_MCP_REMOTE_DEBUG_HOSTS`. Prefer SSH/VPN tunnels to loopback. GDB remote attach rejects arbitrary target syntax, and the lldb-dap compatibility path generates a fixed `gdb-remote host:port` command from the validated endpoint.

## Why the compact default matters

MCP clients commonly place tool names, descriptions, and schemas directly in model context. Native debuggers naturally expose many operations; exposing all of them on every turn increases context cost and tool-selection ambiguity. The 18-tool `agent` surface keeps routine coding-agent work focused, `forensics` adds specialist workflows only when needed, and `full` is reserved for deliberate manual DAP control.

An invalid `QWEN_DAP_MCP_TOOLSET` value falls back to `agent` with a warning.
