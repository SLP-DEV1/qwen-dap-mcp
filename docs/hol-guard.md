# HOL Guard integration

qwen-dap-mcp can optionally ask [HOL Guard](https://github.com/hashgraph-online/hol-guard) to evaluate debugger actions before they cross a side-effect boundary.

The integration is defense in depth. The built-in `QWEN_DAP_MCP_DAP_POLICY=inspect-only` policy still runs first and remains fail-closed. HOL Guard is consulted only after the built-in policy permits the action.

## What is gated

The integration protects the two execution boundaries originally identified by the HOL Guard maintainer:

1. **DAP `evaluate` and `launch` before `writeMessage()`**. `evaluate` can execute code in the debuggee; `launch` can start the wrong target process.
2. **DAP adapter start before `DapConnection.start()` can spawn the adapter process.** This closes the separate local process-start path that does not flow through `sendRequest()`.

Inspection requests such as `variables`, `stackTrace`, `scopes`, `threads`, `modules`, `readMemory`, and disassembly remain on the read-only fast path and do not invoke HOL Guard.

## Enable

Install HOL Guard 2.2 or newer, initialize it, then enable the bridge:

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

## Approval flow

The bundled bridge converts each protected debugger action into a local HOL Guard runtime MCP tool-call artifact and evaluates it through HOL Guard's own policy pipeline:

`build_tool_call_artifact -> build_tool_call_hash -> evaluate_tool_call -> resolve_tool_call_policy_action`

Decision handling is:

- `allow` / `warn`: the debugger action proceeds and qwen-dap-mcp records the HOL Guard runtime receipt/event.
- `observe` mode: the evaluated action is recorded but does not block execution.
- `review` / `require-reapproval`: qwen-dap-mcp queues a real HOL Guard approval request, records that the action did not execute, and returns the approval command/request ID without sending the DAP request or spawning the adapter.
- `sandbox-required` / `block`: the action remains blocked and HOL Guard records the non-execution receipt/event.

A typical first attempt in HOL Guard's prompt mode looks like:

```text
qwen-dap-mcp -> HOL Guard -> review
                         -> Approval Center request
                         -> no DAP write / no process spawn
```

Approve the request with HOL Guard's Approval Center or the command returned in the error, for example:

```bash
hol-guard approvals approve <request-id>
```

Then retry the same debugger action. HOL Guard can reuse the exact saved approval only when its current authority still matches.

## Exact action identity

Protected approvals are bound to more than the synthetic tool name. The approval context includes:

- effective project/debuggee workspace,
- DAP command and arguments,
- adapter command and arguments,
- a SHA-256 fingerprint of the effective adapter environment,
- environment variable names (but **not their values**),
- HOL Guard policy context and tool identity.

Raw environment values remain inside the Node process. qwen-dap-mcp sends HOL Guard only a deterministic environment hash and key names, so changing the adapter's effective environment invalidates exact approval reuse without leaking secrets into the bridge payload.

For DAP `launch`, a request-level `cwd` takes precedence over the adapter working directory so approvals are tied to the actual debuggee workspace when one is supplied.

## Approval reuse and TOCTOU hardening

On HOL Guard versions that expose `fresh_authority_provider`, the bridge supplies one. When HOL Guard claims a saved approval, it can reload the current configuration and rebuild the artifact/hash immediately at the execution boundary. If that authority changed, HOL Guard requires reapproval instead of silently reusing stale permission.

The integration feature-detects this API so HOL Guard 2.2 remains supported while newer releases receive the strongest available post-claim revalidation.

## Runtime and failure behavior

HOL Guard evaluation runs in an asynchronous child process. The Node event loop is not blocked while Python evaluates policy. Only protected actions pay that process-start cost; read-only inspection stays entirely in-process.

When HOL Guard integration is enabled, these conditions fail closed instead of falling back to unguarded execution:

- HOL Guard is older than 2.2,
- HOL Guard cannot be imported from the selected Python environment,
- the bridge process fails or times out,
- the bridge returns malformed JSON,
- the approval/receipt pipeline fails,
- HOL Guard returns a non-executable policy action.

When `QWEN_DAP_MCP_HOL_GUARD` is unset or disabled, qwen-dap-mcp behaves as before and uses only its built-in DAP request policy.

## Compatibility testing

The repository has two layers of tests:

1. TypeScript boundary tests use a fake evaluator to prove denied `evaluate`, `launch`, and adapter-start actions produce zero DAP/process side effects and do not consume DAP sequence numbers.
2. `HOL Guard Compatibility` CI installs real HOL Guard, verifies the imported runtime APIs, and runs the packaged Python bridge against both the minimum supported `hol-guard==2.2.0` and the latest published version. A scheduled weekly run detects upstream compatibility changes even when qwen-dap-mcp itself has not changed.

You can run the real smoke locally after installing HOL Guard:

```bash
npm run test:hol-guard:real
```

## Built-in inspect-only mode

For workflows that never need target-control requests, the strongest local posture is:

```powershell
$env:QWEN_DAP_MCP_DAP_POLICY = "inspect-only"
$env:QWEN_DAP_MCP_HOL_GUARD = "1"
```

`inspect-only` is an authoritative local allowlist and therefore denies `evaluate`, `launch`, attach/control operations, breakpoints, and other requests outside its inspection list before HOL Guard is consulted. HOL Guard still protects the separate adapter-start process boundary.

Do not enable `inspect-only` for a workflow that must establish a live launch/attach or another denied DAP control operation; use the standard DAP policy with HOL Guard instead.

## Integration boundary

HOL Guard currently exposes the runtime primitives used here as Python modules rather than a versioned Node API. qwen-dap-mcp isolates those imports inside one bundled Python bridge, requires HOL Guard 2.2+, feature-detects newer authority APIs, and continuously tests the minimum and current published versions. If HOL Guard later provides a stable external policy endpoint, the bridge can move to that endpoint without changing the DAP-side security boundaries.
