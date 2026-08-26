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

GDB watchpoints are exposed through DAP data breakpoints, so the high-level adapter-independent workflow can be used after any stopped live session:

```text
debug_find_writer(
  name="player->health",
  accessType="write"
)
```

The bridge resolves the data breakpoint, temporarily installs it, resumes to the first stop/exit/termination, and reports the immediate writer frame when the debugger confirms a `data breakpoint`/watchpoint stop. It does not automatically continue through an unrelated stop.
