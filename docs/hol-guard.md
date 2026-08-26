# HOL Guard integration

qwen-dap-mcp can optionally ask [HOL Guard](https://github.com/hashgraph-online/hol-guard) to evaluate debugger actions before they cross a side-effect boundary.

The integration is defense in depth. The built-in `QWEN_DAP_MCP_DAP_POLICY=inspect-only` policy still runs first and remains fail-closed. HOL Guard is consulted only after the built-in policy permits the action.

## What is gated

Two boundaries are protected:

1. **Outgoing DAP requests before `writeMessage()`** for actions that can execute code or change debuggee execution state, including `evaluate`, `launch`, `attach`, resume/step operations, `setVariable`, `setExpression`, `writeMemory`, and termination.
2. **DAP adapter start before `DapConnection.start()` can spawn the adapter process.** This closes the separate process-start path that does not flow through `sendRequest()`.

Inspection requests such as `variables`, `stackTrace`, `scopes`, `threads`, `modules`, `readMemory`, and disassembly remain on the read-only fast path and do not invoke the HOL Guard bridge.

## Enable

Install HOL Guard 2.2 or newer, then enable the bridge:

```bash
pipx install hol-guard
hol-guard init
```

```bash
QWEN_DAP_MCP_HOL_GUARD=1
```

On Windows PowerShell:

```powershell
$env:QWEN_DAP_MCP_HOL_GUARD = "1"
```

qwen-dap-mcp tries to locate `hol-guard` on `PATH` and, for normal pipx installs, uses the Python interpreter beside the resolved HOL Guard executable. If discovery is not possible, point qwen-dap-mcp at the interpreter that has HOL Guard installed:

```powershell
$env:QWEN_DAP_MCP_HOL_GUARD_PYTHON = "C:\path\to\hol-guard\Scripts\python.exe"
```

Optional policy-process timeout (100-60000 ms, default 5000):

```powershell
$env:QWEN_DAP_MCP_HOL_GUARD_TIMEOUT_MS = "5000"
```

## Decision behavior

The bundled bridge converts each protected debugger action into a local HOL Guard runtime MCP tool-call artifact, then uses HOL Guard's local policy pipeline:

`build_tool_call_artifact -> build_tool_call_hash -> evaluate_tool_call -> resolve_tool_call_policy_action`

HOL Guard `allow` and `warn` decisions proceed. In HOL Guard `observe` mode, actions are observed but not blocked. `review`, `require-reapproval`, `sandbox-required`, and `block` do **not** cross the DAP boundary.

The first integration deliberately fails closed instead of implementing a second approval UI inside qwen-dap-mcp. Interactive approval/receipt workflows remain HOL Guard's responsibility; an upstream HOL Guard MCP proxy can provide that user-facing flow. Saved HOL Guard policy decisions can still participate in the local evaluation performed by the bridge.

## Failure behavior

When HOL Guard integration is enabled, these conditions block the protected action instead of falling back to unguarded execution:

- HOL Guard cannot be imported from the selected Python environment
- the bridge process fails or times out
- the bridge returns malformed JSON
- HOL Guard returns a non-executable policy action

When `QWEN_DAP_MCP_HOL_GUARD` is unset or disabled, qwen-dap-mcp behaves as before and uses only its built-in DAP request policy.

## Recommended hardened mode

For agents that only need crash/postmortem inspection, combine both layers:

```powershell
$env:QWEN_DAP_MCP_DAP_POLICY = "inspect-only"
$env:QWEN_DAP_MCP_HOL_GUARD = "1"
```

`inspect-only` remains the authoritative local allowlist. HOL Guard then protects the separate adapter-start boundary and any executable DAP operations allowed by a less restrictive future/custom local policy.
