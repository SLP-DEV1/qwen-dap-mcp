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
  workflow={stage:"diagnose"}
)
```

The bridge discovers and starts `lldb-dap`, launches the authorized target, waits for a stop/exit/termination, collects bounded DAP evidence, and runs the same diagnosis and verification pipeline used by the other adapters.

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

Upstream `lldb-dap` can inspect a frozen core file:

```text
debug_this_crash(
  mode="dump",
  dumpAdapter="lldb-dap",
  dumpPath="/path/to/core",
  program="/path/to/app",
  sourceMap={"/build/src":"/workspace/src"},
  analysis={projectRoots:["/workspace/src"]}
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

A postmortem session is read-only. Continue, step, pause, and data-breakpoint/value-trace operations are rejected because a core file contains frozen process state.

## Manual tools

The default `agent` toolset stays intentionally compact. Set:

```text
QWEN_DAP_MCP_TOOLSET=full
```

when you intentionally need the manual `lldb-dap` lifecycle surface:

- `debug_lldb_dap_info` — discover the adapter,
- `debug_start_lldb_dap` — start and initialize the adapter,
- `debug_launch_lldb_dap` — launch an authorized local program,
- `debug_attach_lldb_dap` — attach to an authorized local PID,
- `debug_attach_lldb_dap_remote` — attach to an explicitly authorized `lldb-server gdbserver` TCP endpoint.

The generic DAP tools remain available in `full` mode as well.

## Hardened lldb-server remote attach

The remote helper accepts structured `host` + `port` and an optional matching local program image:

```text
debug_sessions(action="create", sessionId="remote-lldb")
debug_start_lldb_dap(sessionId="remote-lldb")
debug_attach_lldb_dap_remote(
  sessionId="remote-lldb",
  host="127.0.0.1",
  port=1235,
  program="/local/symbols/app"
)
```

Loopback is allowed by default; exact non-loopback hosts must be present in `QWEN_DAP_MCP_REMOTE_DEBUG_HOSTS`. Prefer SSH/VPN tunneling instead of exposing a native debug server directly.

Older lldb-dap releases such as Ubuntu 24.04's lldb-dap 18 do not honor the newer native gdb-remote host/port fields. For compatibility, qwen-dap-mcp generates exactly one internal:

```text
gdb-remote host:port
```

from the already validated endpoint. MCP users cannot supply arbitrary `attachCommands` or free-form LLDB commands, and this path does not expose `lldb-server platform` as a general remote-command channel.

See [remote-debugging.md](remote-debugging.md) for the complete trust model.

## Differential and causal debugging

Two independent stopped lldb-dap sessions can be compared with v0.17 `debug_compare_runs` just like other DAP sessions. The comparison is read-only and uses explicit `baselineSessionId` / `candidateSessionId`.

When a suspicious debugger-visible value is identified and the live target is safe to resume, `debug_trace_value(sessionId=...)` can collect a bounded writer timeline. It is a state-changing workflow and is therefore subject to normal DAP policy/HOL Guard enforcement.

## Crash signals

Upstream LLDB can surface synchronous POSIX crash signals such as `SIGSEGV` through the DAP exception surface with `breakMode="always"`. `qwen-dap-mcp` recognizes explicit fatal signal families as crash-likely while keeping generic configured or first-chance exception stops conservative.

`crashLikely` is still a diagnostic classification, not proof that a fix succeeded. A fix is verified only by completing the intended reproduction and comparing the resulting runtime evidence.

## Validation

The repository has real Linux workflows that install distribution LLDB, auto-discover the actual `lldb-dap` binary, compile native C++ fixtures, and exercise:

- direct DAP launch / breakpoint / stack / variables / registers / modules / disassembly collection,
- high-level `debug_this_crash(mode="lldb-dap")` crash diagnosis,
- real `lldb-server gdbserver` remote attach,
- concurrent remote multi-session isolation with GDB.

The compatibility layer does not require one hard-coded LLVM major version; versioned distro binaries and common toolchain layouts are discovered explicitly.

## Safety

The same project safety boundaries apply to `lldb-dap` as to CodeLLDB:

- adapter processes are spawned directly without a shell,
- MCP transport is local stdio,
- live launch/attach/control is intended only for authorized targets,
- remote attach is restricted to validated/authorized TCP endpoints,
- there is no arbitrary shell or source-writing MCP primitive,
- there is no unrestricted memory-write primitive,
- postmortem targets cannot be resumed.

For upstream adapter configuration details, see the official LLVM `lldb-dap` documentation.
