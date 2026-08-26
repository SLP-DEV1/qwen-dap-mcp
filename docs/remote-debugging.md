# Remote debugging and multi-session workflows

v0.16 introduced isolated debugger sessions plus hardened TCP attach paths for GNU `gdbserver` and LLVM `lldb-server gdbserver`. v0.17 builds on that session model with cross-session differential comparison.

The MCP server itself is still local stdio. "Remote" here means that a local GDB/lldb-dap adapter connects to a native debug-server endpoint that the user has explicitly authorized.

## Multi-session model

qwen-dap-mcp keeps a backwards-compatible session named `default`. Create additional sessions with `debug_sessions`:

```text
debug_sessions(action="create", sessionId="server-a")
debug_sessions(action="create", sessionId="server-b")
```

Most debugger tools take one optional `sessionId`:

```text
debug_start_gdb(sessionId="server-a")
debug_start_lldb_dap(sessionId="server-b")
```

Omitting `sessionId` on those routed tools always targets `default`.

Two exceptions matter:

- `debug_sessions` manages the registry and is not routed through one selected session.
- `debug_compare_runs` intentionally inspects two sessions at once and uses `baselineSessionId` plus `candidateSessionId` instead of a single `sessionId`.

Session selection for normal single-session calls is request-local rather than process-global. Concurrent calls for `server-a` and `server-b` therefore route to separate `GuardedDapSession` instances. Each session owns its own adapter connection, lifecycle serialization, capabilities, configured/postmortem state, recent events/stderr, data-breakpoint state, timeout/operation state, and HOL Guard context.

The default registry is bounded to eight sessions. Session IDs are 1-64 characters, begin with an alphanumeric character, and may otherwise contain letters, digits, `.`, `_`, or `-`.

List sessions:

```text
debug_sessions(action="list")
```

Close a non-default session:

```text
debug_sessions(action="close", sessionId="server-a", terminateDebuggee=false)
```

A session cannot be closed while a routed request is still active. Closing `default` disconnects/resets its debugger but preserves the default registry slot.

## Differential use of remote sessions

Remote and local sessions can participate in the same read-only v0.17 comparison once both are already stopped at comparable logical states:

```text
debug_compare_runs(
  baselineSessionId="server-a",
  candidateSessionId="server-b"
)
```

The comparison does not launch, attach, pause, continue, or mutate either target. Keep symbols/binaries matched to each corresponding session before interpreting source-level differences.

## Why remote endpoints are restricted

`gdbserver` and `lldb-server` expose powerful process-control/debugging capabilities and should not be treated as authenticated application protocols.

qwen-dap-mcp therefore:

- allows loopback hosts by default (`localhost`, `127.0.0.0/8`, `::1`),
- rejects non-loopback hosts unless the exact hostname/IP is allowlisted,
- requires TCP ports from 1 through 65535,
- rejects whitespace/control characters and malformed hostnames,
- rejects arbitrary GDB target syntax,
- does not expose user-supplied LLDB command strings,
- does not start a remote debug server on behalf of the MCP client,
- does not support `lldb-server platform` as a generic remote-command channel.

Allow explicitly authorized non-loopback hosts with:

```bash
export QWEN_DAP_MCP_REMOTE_DEBUG_HOSTS=debugbox.internal,10.20.30.40
```

PowerShell:

```powershell
$env:QWEN_DAP_MCP_REMOTE_DEBUG_HOSTS = "debugbox.internal,10.20.30.40"
```

Prefer an SSH or VPN tunnel and keep qwen-dap-mcp pointed at a loopback endpoint whenever possible.

## gdbserver workflow

Remote attach helpers are part of the `full` toolset:

```bash
export QWEN_DAP_MCP_TOOLSET=full
```

On the target machine, start `gdbserver` for the authorized program. A loopback-only example is:

```bash
gdbserver --once 127.0.0.1:1234 ./build/app --repro
```

If the target is another machine, normally tunnel that port first rather than exposing it directly:

```bash
ssh -L 1234:127.0.0.1:1234 user@debugbox
```

Then create and initialize an isolated GDB session:

```text
debug_sessions(action="create", sessionId="remote-gdb")
debug_start_gdb(sessionId="remote-gdb")
```

Attach through the structured host/port path:

```text
debug_attach_gdb_remote(
  sessionId="remote-gdb",
  host="127.0.0.1",
  port=1234,
  program="/local/symbols/app",
  breakpoints=[{source="/local/src/main.cpp", lines=[42]}]
)
```

`program` is optional but recommended when a matching local unstripped image is available. The local executable/debug symbols must correspond to the remote binary.

For backwards compatibility, `target="localhost:1234"` is accepted by the dedicated remote helper only when it parses as a validated TCP `host:port`. Serial devices and arbitrary `target remote` argument strings are rejected.

After attach, use the same routed inspection/control tools as a local session:

```text
debug_snapshot(sessionId="remote-gdb")
debug_diagnose_stop(sessionId="remote-gdb", analysis={projectRoots:["/local/src"]})
debug_continue(sessionId="remote-gdb", threadId=...)
```

## lldb-server workflow

Start the target through `lldb-server gdbserver`:

```bash
lldb-server gdbserver 127.0.0.1:1235 -- ./build/app --repro
```

For automated local tests, lldb-server can select an ephemeral port with `127.0.0.1:0` and report it through `--pipe`; qwen-dap-mcp CI uses that path to avoid fixed-port collisions.

Create and initialize a separate lldb-dap session:

```text
debug_sessions(action="create", sessionId="remote-lldb")
debug_start_lldb_dap(sessionId="remote-lldb")
```

Attach:

```text
debug_attach_lldb_dap_remote(
  sessionId="remote-lldb",
  host="127.0.0.1",
  port=1235,
  program="/local/symbols/app",
  breakpoints=[{source="/local/src/main.cpp", lines=[42]}]
)
```

Older lldb-dap releases such as Ubuntu 24.04's lldb-dap 18 ignore newer native gdb-remote host/port fields. For compatibility, qwen-dap-mcp builds exactly one LLDB attach command from the already validated endpoint:

```text
gdb-remote 127.0.0.1:1235
```

That command is generated internally. The MCP schema never accepts arbitrary `attachCommands` or free-form LLDB command input.

## Parallel GDB + LLDB example

Two targets can be inspected concurrently without changing a global selected debugger:

```text
debug_sessions(action="create", sessionId="linux-gdb")
debug_sessions(action="create", sessionId="service-lldb")

debug_start_gdb(sessionId="linux-gdb")
debug_start_lldb_dap(sessionId="service-lldb")

debug_attach_gdb_remote(sessionId="linux-gdb", host="127.0.0.1", port=1234, program="/symbols/a")
debug_attach_lldb_dap_remote(sessionId="service-lldb", host="127.0.0.1", port=1235, program="/symbols/b")
```

Subsequent single-session requests carry the matching `sessionId`. `AsyncLocalStorage` keeps the route bound to each individual MCP request, so interleaved operations do not overwrite a shared selector.

## CI evidence

The Linux adapter workflows contain real end-to-end remote smoke tests:

- GDB DAP starts and connects to a real `gdbserver`, sets a source breakpoint, continues, and verifies stack/variable evidence.
- lldb-dap starts and connects to a real `lldb-server gdbserver`, sets a source breakpoint, continues, and verifies stack/variable evidence.
- The LLDB smoke intentionally covers the compatibility path used by lldb-dap 18.
- A separate multi-session remote smoke runs real GDB/gdbserver and lldb-dap/lldb-server concurrently and verifies session isolation.

These are in addition to local GDB watchpoint, lldb-dap launch/crash, Differential Runtime, Crash Lab, Hang Lab, package, container, and HOL Guard coverage.

## Trust and HOL Guard

Remote attach changes target state and is never classified as read-only inspection. It remains subject to the normal guarded DAP lifecycle and, when enabled, HOL Guard policy evaluation.

The host allowlist is an additional network-boundary check, not a replacement for authorization, tunneling, firewalling, or HOL Guard. Only connect to debug servers and processes you are authorized to control.
