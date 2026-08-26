# Multi-session and remote native debugging

Use this companion guide when the user needs more than one debugger session or an authorized `gdbserver` / `lldb-server gdbserver` target.

## Multi-session rules

- `debug_sessions(action="list")` shows all isolated DAP sessions.
- `debug_sessions(action="create", sessionId="...")` creates a non-default session.
- Most single-session `debug_*` tools accept optional `sessionId`.
- Omit `sessionId` only when the backwards-compatible `default` session is intended.
- `debug_sessions` manages the registry itself and is not a normal routed call.
- `debug_compare_runs` is intentionally cross-session: use `baselineSessionId` and `candidateSessionId`, not one `sessionId`.
- `debug_trace_value` is a normal live single-session operation and uses `sessionId`.
- Never simulate a global "current session" in agent memory. Session routing is request-local inside qwen-dap-mcp.
- Keep the same session identity on every debugger action/evidence item that belongs to one target.
- A session with an active routed request cannot be closed.
- Prefer descriptive IDs such as `remote-gdb`, `service-lldb`, `baseline`, or `candidate`.

Example:

```text
debug_sessions(action="create", sessionId="remote-gdb")
debug_start_gdb(sessionId="remote-gdb")
debug_status(sessionId="remote-gdb")
```

For a read-only known-good/failing comparison after two sessions have reached comparable stopped states:

```text
debug_compare_runs(
  baselineSessionId="baseline",
  candidateSessionId="candidate"
)
```

## Remote-debug trust boundary

Remote native debug servers provide process-control authority. Treat them as privileged endpoints, not ordinary application services.

Prefer an SSH/VPN tunnel to loopback. qwen-dap-mcp automatically permits `localhost`, `127.0.0.0/8`, and `::1`. A non-loopback host must be explicitly allowlisted with `QWEN_DAP_MCP_REMOTE_DEBUG_HOSTS`.

Do not ask qwen-dap-mcp to bypass this policy. Do not turn remote attach into arbitrary GDB target syntax or free-form LLDB commands.

The remote helpers live in the `full` toolset. Start the server with `QWEN_DAP_MCP_TOOLSET=full` when remote attach is intentionally required.

## gdbserver

For an already running authorized gdbserver endpoint:

```text
debug_sessions(action="create", sessionId="remote-gdb")
debug_start_gdb(sessionId="remote-gdb")
debug_attach_gdb_remote(
  sessionId="remote-gdb",
  host="127.0.0.1",
  port=1234,
  program="/local/symbols/app",
  breakpoints=[{source="/local/src/main.cpp", lines=[42]}]
)
```

Prefer structured `host` + `port`. The legacy `target` field on the dedicated remote helper is accepted only as a validated TCP `host:port`; arbitrary GDB target strings are rejected.

After attach, use normal evidence tools with the same session:

```text
debug_snapshot(sessionId="remote-gdb")
debug_diagnose_stop(sessionId="remote-gdb", analysis={projectRoots:["/local/src"]})
```

## lldb-server gdbserver

For an already running authorized `lldb-server gdbserver` endpoint:

```text
debug_sessions(action="create", sessionId="remote-lldb")
debug_start_lldb_dap(sessionId="remote-lldb")
debug_attach_lldb_dap_remote(
  sessionId="remote-lldb",
  host="127.0.0.1",
  port=1235,
  program="/local/symbols/app",
  breakpoints=[{source="/local/src/main.cpp", lines=[42]}]
)
```

Do not use `lldb-server platform` through this path. qwen-dap-mcp intentionally supports only the gdb-remote debug-server role.

For compatibility with older lldb-dap releases, qwen-dap-mcp may generate exactly one `gdb-remote host:port` attach command from the validated endpoint. The user cannot supply arbitrary `attachCommands`.

## Parallel targets

Independent sessions may be used concurrently:

```text
debug_sessions(action="create", sessionId="target-a")
debug_sessions(action="create", sessionId="target-b")

debug_start_gdb(sessionId="target-a")
debug_start_lldb_dap(sessionId="target-b")
```

When calls are interleaved, preserve the correct session identity; do not copy thread IDs, frame IDs, breakpoints, autonomous state, or evidence from one target into another.

## Evidence standard

Remote transport does not lower the normal diagnosis standard. Keep fault evidence, selected project frame, symbols, source mapping, registers/locals, runtime provenance, and reproduction evidence tied to the same session and matching binary.

A local symbol image used with a remote target must correspond to the remote executable. If symbols/source do not match, report that limitation instead of claiming source-level certainty.

Remote attach and `debug_trace_value` remain state-changing and must honor the normal authorization and optional HOL Guard policy boundary. `debug_compare_runs` remains read-only.
