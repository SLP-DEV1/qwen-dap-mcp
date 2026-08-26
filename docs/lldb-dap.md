# Upstream LLVM lldb-dap

`qwen-dap-mcp` supports upstream LLVM `lldb-dap` as a first-class DAP adapter alongside CodeLLDB.

Use `lldb-dap` when you want the debugger adapter shipped by LLVM itself. CodeLLDB remains supported and is still the default for existing CodeLLDB-specific workflows and Windows minidump compatibility.

## Install and discovery

Install LLDB through your operating system or LLVM toolchain. `qwen-dap-mcp` discovers `lldb-dap` in this order:

1. an explicit `adapterPath`,
2. `LLDB_DAP_PATH`,
3. canonical or versioned executables on `PATH`, such as `lldb-dap`, `lldb-dap-21`, or distro-specific versions,
4. known LLVM toolchain directories, including versioned Linux layouts and `LLVM_HOME`,
5. `xcrun --find lldb-dap` on macOS.

This matters on Linux distributions that install the adapter inside an LLVM toolchain directory instead of exposing an unversioned binary directly on `PATH`.

## High-level crash diagnosis

The preferred agent-facing entry point is `debug_this_crash`:

```text
debug_this_crash(
  mode="lldb-dap",
  program="/path/to/app",
  args=["--repro"],
  cwd="/path/to/repo",
  analysis={
    projectRoots:["/path/to/repo"],
    projectModules:["app"]
  },
  workflow={
    stage:"diagnose"
  }
)
```

The bridge discovers and starts `lldb-dap`, launches the authorized local target, waits for a stop/exit/termination, collects bounded DAP evidence, and runs the same diagnosis and verification pipeline used by the other adapters.

Use an explicit adapter binary when auto-discovery is not appropriate:

```text
debug_this_crash(
  mode="lldb-dap",
  adapterPath="/opt/llvm/bin/lldb-dap",
  program="/path/to/app"
)
```

For bounded agentic verification, `workflow.stage="autonomous"` is supported in the same way as the CodeLLDB path. `qwen-dap-mcp` does not edit source or invoke arbitrary build commands itself; those actions remain with the authorized coding agent/tooling.

## Core-file / postmortem analysis

Upstream `lldb-dap` can also inspect a frozen core file:

```text
debug_this_crash(
  mode="dump",
  dumpAdapter="lldb-dap",
  dumpPath="/path/to/core",
  program="/path/to/app",
  sourceMap={
    "/build/src":"/workspace/src"
  },
  analysis={
    projectRoots:["/workspace/src"]
  }
)
```

Or through the lower-level postmortem tool:

```text
debug_open_dump(
  adapter="lldb-dap",
  dumpPath="/path/to/core",
  program="/path/to/app"
)
```

The upstream flow uses a DAP `attach` configuration with `coreFile`. A matching program image is required by the bridge for the `lldb-dap` core-file path so symbols and module identity are deterministic. `sourceMap` values supplied to MCP are converted to the pair-array form expected by upstream `lldb-dap`.

A postmortem session is read-only. Continue, step, pause, and data-breakpoint operations are rejected because a core file contains frozen process state.

## Manual tools

The default `agent` toolset stays intentionally small. Set:

```text
QWEN_DAP_MCP_TOOLSET=full
```

when you intentionally need the manual `lldb-dap` lifecycle surface:

- `debug_lldb_dap_info` - discover the adapter,
- `debug_start_lldb_dap` - start and initialize the adapter,
- `debug_launch_lldb_dap` - launch an authorized local program,
- `debug_attach_lldb_dap` - attach to an authorized local PID.

The generic DAP tools remain available in `full` mode as well.

## Crash signals

Upstream LLDB can surface synchronous POSIX crash signals such as `SIGSEGV` through the DAP exception surface with `breakMode="always"`. `qwen-dap-mcp` recognizes explicit fatal signal families as crash-likely while keeping generic configured or first-chance exception stops conservative.

`crashLikely` is still a diagnostic classification, not proof that a fix succeeded. A fix is verified only by completing the intended reproduction and comparing the resulting runtime evidence.

## Validation

The repository has a real Linux smoke workflow that installs distribution LLDB, auto-discovers the actual `lldb-dap` binary, compiles native C++ fixtures, and exercises both:

- direct DAP launch / breakpoint / stack / variables / registers / modules / disassembly collection, and
- the high-level `debug_this_crash(mode="lldb-dap")` crash-diagnosis path against an intentional native crash.

The compatibility layer does not require one hard-coded LLVM major version; versioned distro binaries and common toolchain layouts are discovered explicitly.

## Safety

The same project safety boundaries apply to `lldb-dap` as to CodeLLDB:

- adapter processes are spawned directly without a shell,
- MCP transport is local stdio,
- live launch/attach is intended only for authorized local targets,
- there is no arbitrary shell or source-writing MCP primitive,
- there is no unrestricted memory-write primitive,
- postmortem targets cannot be resumed.

For upstream configuration details, see the official LLDB `lldb-dap` documentation.
