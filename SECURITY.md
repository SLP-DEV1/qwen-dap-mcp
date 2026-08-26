# Security Policy

## Supported versions

Security fixes are applied to the latest release and the current `main` branch.

## Reporting a vulnerability

Please do **not** publish exploit details, sensitive crash dumps, credentials, private source code, or other confidential target data in a public issue.

If GitHub private vulnerability reporting is enabled for this repository, use **Security → Report a vulnerability**. Otherwise, open a minimal public issue that only states that you have a security-sensitive report and asks the maintainer for a private contact path.

Useful non-sensitive context includes:

- affected `qwen-dap-mcp` version,
- operating system and architecture,
- DAP adapter and version,
- whether the issue affects live debugging, dump debugging, MCP transport, packaging, or path validation,
- high-level impact without weaponized reproduction details.

## Security boundaries

`qwen-dap-mcp` is intentionally designed around local, authorized debugging workflows:

- MCP transport is local stdio,
- there is no built-in remote HTTP debugger service,
- there is no arbitrary shell/source-writing MCP primitive,
- there is no unrestricted memory-write MCP primitive,
- live attach is intended only for authorized local targets,
- postmortem dump sessions are read-only for execution-control operations,
- autonomous fix attempts are bounded and evidence-gated.

These boundaries are security properties. Changes that weaken them should receive explicit review and regression coverage.

## DAP request policy boundary

Outgoing DAP requests pass through an enforceable transport policy in `DapConnection.sendRequest()` before sequence allocation, pending-request state, or the adapter transport write occurs. A denied request therefore cannot reach the debug adapter through the normal request path.

The default `standard` policy preserves normal live-debugging behavior. For inspection-only agents, start the server with:

```text
QWEN_DAP_MCP_DAP_POLICY=inspect-only
```

`read-only` and `readonly` are accepted aliases. This mode only permits an explicit allowlist of inspection requests such as `threads`, `stackTrace`, `scopes`, `variables`, `modules`, `readMemory`, `disassemble`, and `exceptionInfo`. Requests such as `evaluate`, `launch`, execution control, writes, breakpoint mutation, and unknown DAP commands are denied by default.

Hosts that need a richer policy engine can install a custom `DapRequestPolicy` on `DapConnection`. Policy exceptions fail closed: if the policy throws, the DAP request is rejected before any transport side effect.

This policy controls outgoing DAP requests. Starting the debugger adapter process itself is a separate local process boundary handled by `DapConnection.start()` and should be governed independently by the host when adapter executable selection is security-sensitive.
