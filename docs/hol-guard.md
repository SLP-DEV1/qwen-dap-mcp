# HOL Guard integration

qwen-dap-mcp can optionally ask [HOL Guard](https://github.com/hashgraph-online/hol-guard) to evaluate debugger actions before they cross a side-effect boundary.

The integration is defense in depth. The built-in `QWEN_DAP_MCP_DAP_POLICY=inspect-only` policy still runs first and remains fail-closed. HOL Guard is consulted only after the built-in policy permits the action.

## What is gated

The integration protects both execution boundaries:

1. **Mutating or executable DAP requests before sequence allocation and `writeMessage()`**. This includes `evaluate`, `launch`, `attach`, target-control requests (`continue`, stepping, pause, restart, terminate), memory/state writes (`writeMemory`, `setVariable`, `setExpression`), breakpoint mutations, and other DAP requests that can change debugger/debuggee state.
2. **DAP adapter start before `DapConnection.start()` can spawn the adapter process.** This closes the separate local process-start path that does not flow through `sendRequest()`.

Inspection requests such as `variables`, `stackTrace`, `scopes`, `threads`, `modules`, `readMemory`, `source`, `loadedSources`, `exceptionInfo`, and disassembly remain on the read-only fast path and do not invoke HOL Guard.

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

Then retry the same debugger action. HOL Guard can reuse an approval only when the exact current authority still matches.

## Exact action and adapter identity

Protected approvals are bound to more than the synthetic tool name. The approval context includes:

- effective project/debuggee workspace,
- DAP command and privacy-sanitized arguments,
- original adapter command identity,
- adapter arguments through an exact identity hash,
- canonical resolved adapter executable path,
- SHA-256 of the adapter executable file,
- SHA-256 fingerprint of the effective adapter environment,
- environment variable names,
- HOL Guard policy context and tool identity.

The adapter identity is folded into HOL Guard's supported `tool_catalog_fingerprint` capability field, so approval reuse for a later protected DAP request is invalidated when the adapter command, arguments, binary, working directory, or effective environment changes.

When HOL Guard is enabled, qwen-dap-mcp resolves the adapter executable before approval and hashes the file. After an allow decision it hashes the file again, fails closed if it changed, and starts the canonical resolved path instead of resolving the original `PATH` command a second time.

For DAP `launch`, a request-level `cwd` takes precedence over the adapter working directory so approvals are tied to the actual debuggee workspace when one is supplied.

## Secret handling

Raw adapter environment values are not included in the HOL Guard payload. qwen-dap-mcp sends a deterministic environment hash plus variable names.

Protected DAP argument objects are sanitized in Node before they reach the Python bridge. Values under environment containers such as `env` / `environment` and common credential fields such as `token`, `apiKey`, `password`, `authorization`, `clientSecret`, and `privateKey` are replaced with deterministic SHA-256 markers. The hash keeps exact-approval invalidation semantics while the original secret remains available only to the real DAP transport.

Sensitive adapter CLI forms such as `--token value`, `--api-key=value`, `TOKEN=value`, and equivalent common secret flags are handled the same way. The adapter itself still receives its original arguments after policy approval.

The HOL Guard Python subprocess also receives a restricted environment instead of inheriting the MCP server's complete `process.env`. It gets the OS/Python variables required to start plus `HOL_GUARD_*` configuration, but unrelated credentials such as cloud/API keys are not forwarded implicitly.

## Approval reuse and TOCTOU hardening

On HOL Guard versions that expose `fresh_authority_provider`, the bridge supplies one. When HOL Guard claims a saved approval, it reloads current configuration and rebuilds the artifact/hash at the execution boundary. If that authority changed, HOL Guard requires reapproval instead of silently reusing stale permission.

The integration feature-detects this API so HOL Guard 2.2 remains supported while newer releases receive the strongest available post-claim revalidation.

The adapter-start boundary has an additional local TOCTOU check: the approved executable is re-hashed immediately before the spawn-capable path is entered. A mismatch blocks the start.

## Runtime and failure behavior

HOL Guard evaluation runs in an asynchronous child process. The Node event loop is not blocked while Python evaluates policy. Only protected actions pay that process-start cost; read-only inspection stays entirely in-process.

When HOL Guard integration is enabled, these conditions fail closed instead of falling back to unguarded execution:

- HOL Guard is older than 2.2,
- HOL Guard cannot be imported from the selected Python environment,
- the adapter executable cannot be resolved after an allow decision,
- the approved adapter executable changes before spawn,
- the bridge process fails or times out,
- the bridge returns malformed JSON,
- the approval/receipt pipeline fails,
- HOL Guard returns a non-executable policy action.

When `QWEN_DAP_MCP_HOL_GUARD` is unset or disabled, qwen-dap-mcp behaves as before and uses only its built-in DAP request policy.

## Compatibility testing

The repository has multiple test layers:

1. TypeScript boundary tests prove denied protected requests produce zero DAP/process side effects and do not consume DAP sequence numbers.
2. Privacy tests prove secret values are absent from HOL Guard actions while the real DAP transport receives the untouched request/adapter arguments.
3. Adapter-identity tests verify canonical path, binary hash, environment hash, and exact spawn path behavior.
4. `HOL Guard Compatibility` CI installs real HOL Guard, verifies the imported runtime APIs, and runs the packaged Python bridge against both the minimum supported `hol-guard==2.2.0` and the latest published version. A scheduled weekly run detects upstream compatibility changes even when qwen-dap-mcp itself has not changed.

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

`inspect-only` is an authoritative local allowlist and therefore denies executable/mutating operations before HOL Guard is consulted. HOL Guard still protects the separate adapter-start process boundary.

Do not enable `inspect-only` for a workflow that must establish a live launch/attach or another denied DAP control operation; use the standard DAP policy with HOL Guard instead.

## Integration boundary

HOL Guard currently exposes the runtime primitives used here as Python modules rather than a versioned Node API. qwen-dap-mcp isolates those imports inside one bundled Python bridge, requires HOL Guard 2.2+, feature-detects newer authority APIs, and continuously tests the minimum and current published versions. If HOL Guard later provides a stable external policy endpoint, the bridge can move to that endpoint without changing the DAP-side security boundaries.
