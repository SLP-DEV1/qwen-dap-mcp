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
- whether the issue affects live debugging, remote debugging, dump debugging, MCP transport, HOL Guard integration, packaging, or path/endpoint validation,
- high-level impact without weaponized reproduction details.

## Security boundaries

`qwen-dap-mcp` is intentionally designed around local MCP transport and authorized native-debugging workflows:

- MCP transport is local stdio; the server does not expose a built-in HTTP listener,
- debugger adapters are spawned directly without a shell,
- there is no arbitrary shell/source-writing MCP primitive,
- there is no unrestricted memory-write MCP primitive,
- live launch/attach/control is intended only for targets the user is authorized to debug,
- postmortem dump/core sessions are read-only for execution-control operations,
- autonomous fix attempts are bounded and evidence-gated,
- multi-session routing is request-local rather than process-global,
- operation deadlines/cancellation remove authority from expired pending requests,
- adapter transport generations isolate late responses/output from retired debugger processes.

These boundaries are security properties. Changes that weaken them should receive explicit review and regression coverage.

## DAP request policy boundary

Outgoing DAP requests pass through an enforceable transport policy in `DapConnection.sendRequest()` before sequence allocation, pending-request state, or the adapter transport write occurs. A denied request therefore cannot reach the debug adapter through the normal request path.

The default `standard` policy preserves authorized live-debugging behavior. For inspection-only agents, start the server with:

```text
QWEN_DAP_MCP_DAP_POLICY=inspect-only
```

`read-only` and `readonly` are accepted aliases. This mode permits an explicit set of inspection requests such as `threads`, `stackTrace`, `scopes`, `variables`, `modules`, `readMemory`, `disassemble`, and `exceptionInfo`, plus only recognized frozen dump/core setup shapes needed to establish a postmortem session. Generic/live `launch`, PID attach, execution control, writes, breakpoint mutation, `evaluate`, and unknown DAP commands are denied.

Hosts that need a richer policy engine can install a custom `DapRequestPolicy` on `DapConnection`. Policy exceptions fail closed: if the policy throws, the DAP request is rejected before any normal transport side effect.

## Adapter-start and HOL Guard boundary

Starting a debugger adapter is a separate local process boundary because it occurs before normal DAP requests exist. qwen-dap-mcp can optionally integrate with HOL Guard 2.2+ to protect both this adapter-start boundary and mutating/executable DAP actions.

When `QWEN_DAP_MCP_HOL_GUARD=1` is enabled, protected adapter starts and protected DAP actions are evaluated before execution. Denied/review-required actions do not spawn the adapter or cross `writeMessage()`. Adapter identity is bound to canonical executable path, executable SHA-256, arguments, working directory, and effective environment fingerprint; the selected HOL Guard Python interpreter and bundled policy bridge are also canonicalized and hash-checked.

Read-only debugger inspection remains on the fast path after the built-in DAP policy allows it. HOL Guard is defense in depth and does not replace target authorization, OS permissions, endpoint hardening, tunneling, or firewall policy.

See [docs/hol-guard.md](docs/hol-guard.md) for the complete approval model, secret handling, identity binding, TOCTOU checks, and compatibility behavior.

## Remote-debugging boundary

The MCP server itself remains local stdio. Remote debugging means a locally spawned GDB/lldb-dap adapter connects to an explicitly authorized `gdbserver` or `lldb-server gdbserver` TCP endpoint.

qwen-dap-mcp restricts that boundary:

- loopback hosts (`localhost`, `127.0.0.0/8`, `::1`) are allowed by default,
- exact non-loopback hosts/IPs must be listed in `QWEN_DAP_MCP_REMOTE_DEBUG_HOSTS`,
- ports are validated,
- arbitrary GDB target syntax is rejected,
- user-supplied arbitrary LLDB attach commands are not exposed,
- qwen-dap-mcp does not start a remote debug server or expose `lldb-server platform` as a command channel.

A remote debug server is a privileged process-control endpoint and is not an authenticated application boundary. Prefer SSH/VPN tunneling to loopback and use network controls appropriate to the target environment. The host allowlist is an additional boundary, not a replacement for authorization or transport security.

See [docs/remote-debugging.md](docs/remote-debugging.md) for the supported workflow and trust model.

## Differential and value-trace safety

`debug_compare_runs` is read-only and only inspects two already-stopped sessions. `debug_trace_value` is not read-only: it installs a temporary data breakpoint/watchpoint and resumes a live target within bounded stop/time limits. It must not be used for frozen dumps or targets that are unsafe to resume, and its protected debugger actions remain subject to the normal DAP policy and optional HOL Guard enforcement.
