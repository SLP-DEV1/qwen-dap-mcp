# GNU GDB DAP

`qwen-dap-mcp` supports GNU GDB 14+ through GDB's built-in Debug Adapter Protocol interpreter.

## Requirements

- GDB 14 or newer
- a GDB build with Python/DAP support
- an authorized native target

GDB 14 introduced the built-in `dap` interpreter. The bridge starts it directly without a shell using:

```text
gdb --interpreter=dap --quiet --nx
```

`--nx` deliberately avoids user init files so unexpected startup commands do not interfere with the stdio protocol.

## Discovery

The bridge searches in this order:

1. explicit `adapterPath`
2. `GDB_DAP_PATH`
3. `GDB_PATH`
4. `GDB_HOME/bin/gdb`
5. `gdb` / common versioned GDB names on `PATH`

The executable is version-probed and GDB < 14 is rejected before a session is started.

## DAP lifecycle compatibility

Modern GDB DAP differs from CodeLLDB and `lldb-dap` in an important ordering detail. GDB can emit `initialized` immediately after the DAP `initialize` request, and its corrected launch flow expects configuration requests before `launch`:

```text
initialize -> initialized -> setBreakpoints -> configurationDone -> launch
```

Source breakpoints can therefore be reported as pending before GDB knows the executable and become resolved when `launch` loads and starts the program. The bridge handles this ordering only for the GDB adapter path while preserving the existing CodeLLDB/`lldb-dap` lifecycle. The Linux smoke workflow exercises this sequence against real distribution GDB.

## High-level workflows

Crash diagnosis:

```text
debug_this_crash(
  mode="gdb",
  program="/work/build/app",
  args=["--repro"],
  analysis={projectRoots:["/work/src"]}
)
```

Hang diagnosis uses the same adapter path through `debug_this_hang(mode="gdb", ...)`.

After separate known-good/failing GDB sessions are stopped at comparable states, v0.17 can compare them with `debug_compare_runs`. A suspicious live value can then be followed with bounded `debug_trace_value` writer evidence when it is safe to resume that target.

## Manual full-toolset helpers

With `QWEN_DAP_MCP_TOOLSET=full`:

- `debug_gdb_info`
- `debug_start_gdb`
- `debug_launch_gdb`
- `debug_attach_gdb`
- `debug_attach_gdb_remote`

`debug_attach_gdb` is the dedicated local PID helper. `debug_attach_gdb_remote` is the dedicated hardened `gdbserver` helper.

The underlying GDB DAP implementation can understand additional native GDB attach configuration shapes, but qwen-dap-mcp does **not** expose an arbitrary GDB target-string escape hatch through MCP. Remote MCP input is restricted to validated TCP endpoints.

Preferred remote form:

```text
debug_attach_gdb_remote(
  sessionId="remote-gdb",
  host="127.0.0.1",
  port=1234,
  program="/local/symbols/app"
)
```

The legacy `target` field on this dedicated helper is accepted only when it parses as a strict TCP `host:port` such as `localhost:1234` or `[::1]:1234`. Serial devices, arbitrary `target remote` syntax, injected debugger commands, and non-allowlisted network hosts are rejected. The MCP server never starts `gdbserver` itself.

See [remote-debugging.md](remote-debugging.md) for the endpoint policy and tunneling guidance.

## Core files

```text
debug_open_dump(
  adapter="gdb",
  dumpPath="/work/crashes/core.1234",
  program="/work/build/app"
)
```

Core-file sessions are marked postmortem/read-only by the same session guard used for CodeLLDB and upstream `lldb-dap` dumps.

## Find or trace a writer

`debug_find_writer` is the high-level one-shot writer workflow. GDB currently needs a compatibility path because real distribution GDB may support hardware watchpoints without advertising DAP `supportsDataBreakpoints`.

For adapters that advertise native DAP data breakpoints, the bridge uses `dataBreakpointInfo` and `setDataBreakpoints`. For GDB without that capability flag, the bridge uses a deliberately bounded DAP `evaluate` request in `repl` context to issue exactly one of `watch`, `rwatch`, or `awatch` for the supplied expression:

```text
debug_find_writer(
  name="player->health",
  accessType="write"
)
```

The fallback does not expose a general command shell through the agent tool. The watch expression is length-bounded and rejects control characters or line breaks; conditional and hit-count watches are rejected on this fallback. The bridge parses the newly created GDB watchpoint number and later deletes only that temporary watchpoint.

`debug_trace_value` reuses the same bounded writer mechanism repeatedly to construct a temporal sequence. It stops on unrelated debugger events instead of silently continuing and is invalid for frozen postmortem targets.

## Validation

The Linux workflows exercise real GDB DAP for local launch/breakpoint/stack/variable evidence, real `gdbserver` attach, watchpoint behavior, concurrent remote multi-session isolation, and the v0.17 two-session Differential Runtime smoke.
