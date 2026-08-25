# qwen-dap-mcp

A debugger-agnostic **Debug Adapter Protocol (DAP) → Model Context Protocol (MCP)** bridge for agentic native runtime debugging and postmortem crash analysis.

It lets Qwen Code and other MCP clients consume structured debugger state without embedding a native debugger protocol directly in the agent core.

## What it can do

- launch or attach to authorized native targets through DAP,
- inspect threads, stacks, scopes, locals, registers and modules,
- evaluate expressions,
- read bounded memory and disassemble around the instruction pointer,
- use source, conditional, function, instruction and data breakpoints,
- capture a bounded `debug_snapshot` in one MCP call,
- open Windows minidumps and other LLDB-supported core files for **read-only postmortem analysis**,
- expose the workflow to Qwen Code as an installable extension with a bundled `native-runtime-debug` Skill.

CodeLLDB is the first built-in debugger profile and is continuously exercised against real Windows C++ targets in CI.

## Architecture

```text
Qwen Code / MCP client
        │
        │ MCP over stdio
        ▼
   qwen-dap-mcp
        │
        │ DAP over stdio
        ▼
 CodeLLDB / DAP adapter
        │
        ├── live authorized target
        │
        └── crash dump / core file
```

The MCP server itself has no HTTP listener and does not expose a remote debugger service.

## Install in Qwen Code

Install the latest GitHub Release directly:

```bash
qwen extensions install SLP-DEV1/qwen-dap-mcp
```

Then restart Qwen Code if needed and verify:

```text
/mcp
/skills
```

You should see:

```text
Skill:       native-runtime-debug
MCP server:  qwen-dap-mcp
```

The Skill can be invoked explicitly:

```text
/native-runtime-debug
```

or Qwen Code can select it automatically for matching native-debugging tasks.

The release archive is self-contained: runtime npm dependencies are bundled into `dist/index.js`, so users do not need to clone, run `npm install`, or build the extension.

## Crash-dump / minidump analysis

Starting with **v0.7**, `debug_open_dump` opens an LLDB-supported crash artifact through CodeLLDB's postmortem target flow.

Example agent request:

```text
Analyze C:\crashes\app.dmp using C:\build\app.exe.
Find the crashing thread, project frame, source line, relevant locals/registers,
and the likely root cause. Do not guess beyond debugger evidence.
```

The MCP primitive is conceptually:

```text
debug_open_dump(
  dumpPath="C:\\crashes\\app.dmp",
  program="C:\\build\\app.exe"
)
```

Optional `sourceMap` can remap build-machine source paths to the current checkout:

```text
debug_open_dump(
  dumpPath="C:\\crashes\\app.dmp",
  program="C:\\build\\app.exe",
  sourceMap={"D:/agent/_work/project/src":"C:/work/project/src"}
)
```

`debug_open_dump` automatically:

1. discovers or starts CodeLLDB,
2. opens the core/minidump using LLDB's core-file target flow,
3. attaches **no live process**,
4. captures an initial bounded snapshot with modules enabled,
5. marks the session as postmortem/frozen.

### Postmortem safety semantics

A crash dump is frozen state. In postmortem mode the bridge rejects live execution controls:

- `debug_continue`
- `debug_step`
- `debug_pause`
- data-breakpoint/watchpoint setup

Inspection remains available:

- `debug_threads`
- `debug_stack`
- `debug_scopes`
- `debug_variables`
- `debug_snapshot`
- `debug_modules`
- `debug_disassemble`
- `debug_read_memory`
- `debug_exception_info` when recoverable from the artifact

Finish a dump session with:

```text
debug_disconnect(terminateDebuggee=false)
```

An old dump can establish the cause of a past crash, but it cannot prove a source fix worked. Verification still requires rebuilding and reproducing the scenario or analyzing a newly generated dump.

## Real Windows minidump validation

The repository includes a dedicated `CodeLLDB Windows Dump Smoke` workflow. It:

1. compiles a small MSVC C++ program with PDB symbols,
2. intentionally dereferences a null pointer,
3. writes a real Windows `.dmp` using `MiniDumpWriteDump`,
4. starts real CodeLLDB over DAP stdio,
5. opens the generated dump,
6. verifies postmortem thread/stack/source/register/module/disassembly recovery.

A representative successful v0.7 CI run recovered:

```text
exception:            0xC0000005 access violation
project frame:        int crash_here(int *)
source line:          native-dump.cpp:43
pointer:              <null>
local_marker:         77
threads:              4
modules:              18
disassembly:          9 instructions
register groups:      2
```

That test demonstrates actual postmortem root-cause evidence rather than merely checking that a dump file can be opened.

## `debug_snapshot`

`debug_snapshot` is the preferred inspection primitive after a live breakpoint/exception or while exploring a dump.

A bounded snapshot can include:

- selected thread,
- stack frames,
- top/current frame,
- source path and line,
- instruction pointer,
- locals / arguments,
- registers,
- disassembly around IP,
- optional loaded modules,
- structured exception information when the adapter exposes it.

Example:

```text
debug_snapshot(
  includeModules=true,
  stackLevels=20,
  maxVariablesPerScope=100
)
```

The bounds are intentional so an agent does not pull an unbounded debugger state tree into context.

## MCP tools

| MCP tool | Purpose |
| --- | --- |
| `debug_open_dump` | Open a native core/minidump for read-only postmortem analysis |
| `debug_codelldb_info` | Discover CodeLLDB |
| `debug_start_codelldb` | Start and initialize CodeLLDB |
| `debug_launch_codelldb` | Launch a native target using the CodeLLDB profile |
| `debug_attach_codelldb` | Attach to an authorized local native process |
| `debug_start` | Start a generic DAP adapter |
| `debug_launch` | Launch with a generic DAP configuration |
| `debug_attach` | Attach with a generic DAP configuration |
| `debug_set_breakpoints` | Set simple source-line breakpoints |
| `debug_set_source_breakpoints` | Conditional/hit-count/log source breakpoints |
| `debug_set_function_breakpoints` | Function breakpoints |
| `debug_set_instruction_breakpoints` | Instruction-address breakpoints |
| `debug_data_breakpoint_info` | Resolve a debugger-owned data-breakpoint id |
| `debug_set_data_breakpoints` | Set data breakpoints/watchpoints on live sessions |
| `debug_set_exception_breakpoints` | Configure adapter-defined exception filters |
| `debug_pause` | Pause a live target |
| `debug_continue` | Continue a live target |
| `debug_step` | Step over / into / out |
| `debug_threads` | List threads |
| `debug_stack` | Read stack frames |
| `debug_scopes` | Read frame scopes |
| `debug_variables` | Expand variables |
| `debug_evaluate` | Evaluate an expression |
| `debug_modules` | List loaded images/libraries |
| `debug_disassemble` | Disassemble around a memory reference |
| `debug_read_memory` | Read a bounded memory range |
| `debug_exception_info` | Read structured exception information |
| `debug_snapshot` | Capture an agent-friendly bounded runtime snapshot |
| `debug_status` | Inspect session state/capabilities/events |
| `debug_events` | Read recent asynchronous DAP events |
| `debug_disconnect` | Disconnect and stop the adapter |

## Typical live CodeLLDB workflow

```text
1. debug_codelldb_info()
2. debug_start_codelldb()
3. debug_launch_codelldb(program=..., breakpoints=[...])
4. debug_snapshot(includeModules=true)
5. debug_evaluate(...)
6. add a conditional/function/instruction/watchpoint only when evidence requires it
7. debug_continue(...) or debug_step(...)
8. debug_snapshot()
9. patch source
10. rebuild and reproduce
11. debug_disconnect()
```

### Data breakpoints / watchpoints

DAP data breakpoints use a two-stage flow because the debugger owns the stable identifier:

```text
info = debug_data_breakpoint_info(
  name="counter",
  variablesReference=...,
  frameId=...
)

debug_set_data_breakpoints(
  breakpoints=[{ dataId=info.dataId, accessType="write" }]
)
```

The real CodeLLDB Windows test verifies a hardware/data watchpoint that stops when a local `counter` changes from 35 to 42.

## Windows pause semantics

On Windows, CodeLLDB/LLDB may implement a requested pause through `DebugBreak`. The raw DAP stop can therefore look like:

```text
requestedAction: pause
stopped.reason: exception
stopped.description: Exception 0x80000003 ...
```

When `requestedAction` is `pause`, that raw `0x80000003` is the debugger's pause mechanism by itself, not proof that the application independently crashed.

This rule is different from a crash dump: a dump's captured exception context came from the crashed process and is treated as postmortem evidence.

## CodeLLDB requirements and discovery

CodeLLDB **1.11.0 or newer** is required for direct stdio DAP support.

The bridge searches, in order, through:

- explicit `adapterPath`,
- `CODELLDB_PATH`,
- VS Code extension directories,
- VS Code Insiders,
- Cursor,
- Windsurf,
- VS Code OSS,
- `PATH`.

For best source-level Windows results, keep the matching `.exe` and `.pdb` available for the analyzed build.

## Development setup

```bash
git clone https://github.com/SLP-DEV1/qwen-dap-mcp.git
cd qwen-dap-mcp
npm install --ignore-scripts
npm run check
```

For local extension development:

```bash
qwen extensions link .
```

Run the MCP server directly:

```bash
npm start
```

## Testing

The project currently uses several independent layers:

- **CI / Node 20 + 22**: TypeScript build, unit tests, mock-DAP integration, Skill/manifest consistency, release packaging.
- **CodeLLDB Windows Smoke**: real MSVC executable, breakpoints, watchpoints, snapshot, memory/disassembly/modules/registers/pause.
- **CodeLLDB Windows Dump Smoke**: real generated Windows minidump opened through real CodeLLDB/DAP.
- **Qwen Extension Package Smoke**: generated release archive is installed by Qwen Code.
- **Release workflow**: only publishes a self-contained archive after build/install validation.

## Safety posture

- MCP transport is **stdio only**.
- DAP adapters are spawned with `shell: false`.
- `runInTerminal` reverse requests are rejected by default.
- The extension does not bypass Qwen's MCP trust/consent flow.
- `debug_read_memory` is read-only and bounded to at most 64 KiB per call.
- No memory-write MCP tool is exposed.
- Postmortem sessions block resumable execution controls.
- Launch/attach/inspection is intended only for software, processes and crash artifacts the user is authorized to debug.

## Current limitations

- CodeLLDB is currently the only built-in debugger profile.
- No multi-session support yet.
- No automatic symbol-server downloading yet.
- Linux core-dump CI is not yet added.
- No remote HTTP MCP listener.
- No memory-write tool.
- No Qwen Code core patches are required; this remains an MCP-first extension.

## Roadmap

### v0.6 — installable extension ✅

- self-contained GitHub Release archive ✅
- direct `qwen extensions install SLP-DEV1/qwen-dap-mcp` ✅
- Qwen archive-install smoke test ✅

### v0.7 — postmortem debugging ✅

- `debug_open_dump` ✅
- matching executable + source-map support ✅
- frozen postmortem session guard ✅
- real Windows minidump generation ✅
- real CodeLLDB minidump inspection CI ✅
- Qwen Skill postmortem workflow ✅

### Next

- Linux ELF core-dump CI and adapter validation
- symbol/PDB discovery improvements
- module + RVA + source/symbol correlation helpers
- multi-session support
- MCP stepping-latency / event-streaming measurements
- native-bug benchmark suite for agent diagnosis and fix verification

## License

Apache-2.0
