# GNU GDB DAP

`qwen-dap-mcp` v0.14 adds a first-class GNU GDB path using GDB's built-in Debug Adapter Protocol interpreter.

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

Source breakpoints can therefore be reported as pending before GDB knows the executable and become resolved when `launch` loads and starts the program. The bridge handles this ordering only for the GDB adapter path while preserving the existing CodeLLDB/`lldb-dap` lifecycle. The Linux smoke workflow exercises this sequence against the distribution GDB instead of relying only on mocked protocol ordering.

## High-level crash workflow

```text
debug_this_crash(
  mode="gdb",
  program="/work/build/app",
  args=["--repro"],
  analysis={projectRoots:["/work/src"]}
)
```

The same diagnosis, verification fingerprint, and bounded autonomous workflow used by CodeLLDB and `lldb-dap` are applied after GDB produces a stopped-state snapshot.

## Manual full-toolset helpers

With `QWEN_DAP_MCP_TOOLSET=full`:

- `debug_gdb_info`
- `debug_start_gdb`
- `debug_launch_gdb`
- `debug_attach_gdb`
- `debug_attach_gdb_remote`

GDB's DAP `attach` request supports a local PID, a `target remote` string, or a core file. `debug_attach_gdb_remote` only connects to an endpoint you provide; the MCP server does not start `gdbserver` or open a listener.

## Core files

```text
debug_open_dump(
  adapter="gdb",
  dumpPath="/work/crashes/core.1234",
  program="/work/build/app"
)
```

Core-file sessions are marked postmortem/read-only by the same session guard used for CodeLLDB and upstream `lldb-dap` dumps.

## Find the writer

`debug_find_writer` remains a high-level adapter-independent workflow, but GDB currently needs a compatibility path. In the real Ubuntu 24.04 smoke environment, GDB 15.1 does not advertise DAP `supportsDataBreakpoints`, even though GDB itself supports hardware watchpoints.

For adapters that advertise native DAP data breakpoints, the bridge uses `dataBreakpointInfo` and `setDataBreakpoints`. For GDB without that capability flag, the bridge uses a deliberately bounded DAP `evaluate` request in `repl` context to issue exactly one of `watch`, `rwatch`, or `awatch` for the supplied expression:

```text
debug_find_writer(
  name="player->health",
  accessType="write"
)
```

The GDB fallback does not expose a general command shell through the agent tool. The watch expression is length-bounded and rejects control characters or line breaks; conditional and hit-count watches are rejected on this fallback. The bridge parses the newly created GDB watchpoint number and later deletes only that temporary watchpoint.

After installation, the target resumes only to the first stop, exit, or termination. A confirmed data-breakpoint/watchpoint stop returns the immediate writer frame and bounded runtime evidence. An unrelated breakpoint, exception, or signal is returned without automatically continuing through it.
