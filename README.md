# qwen-dap-mcp

A debugger-agnostic **Debug Adapter Protocol (DAP) → Model Context Protocol (MCP)** bridge for agentic native runtime debugging and postmortem crash analysis.

It gives Qwen Code and other MCP clients structured debugger state without embedding a native debugger protocol into the agent itself. CodeLLDB is the first built-in debugger profile.

## v0.8: agent-first crash diagnosis

v0.8 adds a higher-level diagnosis layer on top of the raw DAP primitives.

Instead of making the model manually sequence launch → wait → stack → locals → registers → disassembly → exception info, the bridge can now do that orchestration and return an evidence-bounded diagnosis.

The main tools are:

- `debug_this_crash` — one high-level workflow for current stops, initialized live DAP sessions, automatic CodeLLDB launches, or crash dumps,
- `debug_diagnose_stop` — classify and explain the current stopped state,
- `debug_source_disassembly` — correlate source location + instruction pointer with nearby machine instructions,
- `debug_run_to_stop` — launch/attach and race-safely wait for `stopped`, `exited`, or `terminated`, returning a bounded snapshot on a stop.

The diagnosis engine can recognize evidence consistent with common native failure families such as:

- access violation / `EXC_BAD_ACCESS`,
- segmentation fault / `SIGSEGV`,
- stack overflow,
- divide-by-zero / `SIGFPE`,
- illegal instruction / `SIGILL`,
- abort/assert failures,
- heap-corruption/double-free style diagnostics,
- generic debugger exceptions/signals,
- and non-crash stops such as entry, breakpoint, pause, or step.

It also surfaces suspicious null-like pointer values and common debug-allocator poison patterns, but deliberately reports them as evidence/hypotheses rather than unconditional proof.

## Architecture

```text
Qwen Code / MCP client
        │
        │ MCP over stdio
        ▼
   qwen-dap-mcp
        │
        ├── agent diagnosis layer
        │     ├── classification / hypotheses
        │     ├── exception analysis
        │     └── source ↔ disassembly correlation
        │
        │ DAP over stdio
        ▼
 CodeLLDB / DAP adapter
        │
        ├── authorized live target
        └── crash dump / core file
```

The MCP server has no HTTP listener. The adapter is spawned locally without a shell and communicates over stdio.

## Install in Qwen Code

Install the latest GitHub Release:

```bash
qwen extensions install SLP-DEV1/qwen-dap-mcp
```

Then verify in Qwen Code:

```text
/mcp
/skills
```

You should see the `qwen-dap-mcp` MCP server and the bundled `native-runtime-debug` Skill.

The release archive is self-contained: runtime npm dependencies are bundled into `dist/index.js`, so users do not need to clone the repository or run `npm install`.

## Fastest workflow: debug this crash

### Reproduce a local native crash with CodeLLDB

When you have the executable and want the bridge to reproduce/analyze the next stop in one call:

```text
debug_this_crash(
  mode="codelldb",
  program="C:\\build\\app.exe",
  args=["--repro"],
  timeoutMs=30000
)
```

The workflow:

1. discovers CodeLLDB,
2. starts/initializes the adapter,
3. validates and launches the local program,
4. arms stop/exit listeners before launch so fast crashes cannot race past the agent,
5. waits for `stopped`, `exited`, or `terminated`,
6. captures a bounded runtime snapshot when stopped,
7. returns crash classification, exception evidence, suspicious values, source/disassembly correlation, hypotheses, confidence, and suggested checks.

Optional source breakpoints can be supplied in the same call.

### Analyze an existing crash dump

```text
debug_this_crash(
  mode="dump",
  dumpPath="C:\\crashes\\app.dmp",
  program="C:\\build\\app.exe",
  sourceMap={"D:/agent/_work/project/src":"C:/work/project/src"}
)
```

This reuses the same CodeLLDB postmortem path as `debug_open_dump`, then analyzes the recovered frozen state automatically.

### Diagnose an already stopped session

```text
debug_diagnose_stop(
  includeModules=true,
  includeDisassembly=true,
  includeExceptionInfo=true
)
```

Use this after a breakpoint, exception, pause, or after opening a dump when you want a fresh bounded diagnosis.

### Correlate source and machine code

```text
debug_source_disassembly(
  disassembleBefore=8,
  disassembleAfter=12
)
```

The result includes the selected frame/source line, `instructionPointerReference`, an exact or nearest matching instruction, and the nearby previous/next instructions.

## Diagnosis output model

A diagnosis separates raw facts from inference:

- **classification** — best current stop/crash family,
- **confidence** — strength of that classification/hypothesis,
- **exception** — adapter-provided exception id/description/details when available,
- **faultLocation** — top selected frame, source line, module and instruction pointer,
- **sourceDisassembly** — source ↔ machine-code correlation,
- **suspiciousValues** — bounded clues such as null-like pointers or poison patterns,
- **hypotheses** — likely explanations with evidence and suggested falsification/verification checks,
- **nextActions** — small debugger actions that can improve confidence.

The bridge intentionally does **not** claim that every suspicious pointer/register is the root cause. The bundled Qwen Skill instructs the agent to keep claims evidence-bounded and to distinguish “consistent with” from “proven”.

## Raw bounded snapshot

`debug_snapshot` remains the preferred low-level stop-state primitive. It can include:

- selected thread,
- stack frames,
- current frame/source location,
- locals / arguments,
- registers,
- disassembly around the instruction pointer,
- optional loaded modules,
- structured exception information when supported.

Bounds are intentional so an agent does not pull an unbounded debugger state tree into context.

## Crash-dump / minidump analysis

`debug_open_dump` remains available when raw postmortem evidence is preferred over the high-level diagnosis workflow.

It:

1. discovers/starts CodeLLDB,
2. opens an LLDB-supported core/minidump,
3. attaches no live process,
4. captures an initial bounded snapshot,
5. marks the shared session as postmortem/frozen.

A crash dump is read-only state. The session guard rejects live operations such as:

- `debug_continue`,
- `debug_step`,
- `debug_pause`,
- live data-breakpoint/watchpoint setup.

Inspection remains available through stack, variables, modules, memory, disassembly, snapshots, and the v0.8 diagnostic tools.

Finish a dump session with:

```text
debug_disconnect(terminateDebuggee=false)
```

An old dump can establish the cause of that captured crash, but it cannot prove that a later source change fixed the bug. Verification still requires rebuilding/reproducing or analyzing a newly generated dump.

## Real Windows validation

The repository contains dedicated Windows CodeLLDB smoke workflows.

The dump smoke test:

1. compiles a small MSVC C++ target with PDB symbols,
2. intentionally dereferences a null pointer,
3. writes a real `.dmp` using `MiniDumpWriteDump`,
4. downloads/starts real CodeLLDB,
5. opens the dump through DAP,
6. verifies thread/stack/source/register/module/disassembly recovery.

This exercises real native postmortem behavior rather than only mocks.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `debug_this_crash` | High-level current/live/CodeLLDB/dump diagnosis workflow |
| `debug_diagnose_stop` | Analyze the current stopped state and return likely causes/evidence |
| `debug_source_disassembly` | Correlate source frame/IP with nearby instructions |
| `debug_run_to_stop` | Launch/attach and wait race-safely for stop/exit/termination |
| `debug_open_dump` | Open a native core/minidump for read-only postmortem inspection |
| `debug_snapshot` | Capture a bounded raw runtime snapshot |
| `debug_codelldb_info` | Discover CodeLLDB |
| `debug_start_codelldb` | Start and initialize CodeLLDB |
| `debug_launch_codelldb` | Launch a local native target using the CodeLLDB profile |
| `debug_attach_codelldb` | Attach to an authorized local process |
| `debug_start` | Start a generic local DAP adapter |
| `debug_launch` | Launch using a generic DAP configuration |
| `debug_attach` | Attach using a generic DAP configuration |
| `debug_set_breakpoints` | Simple source-line breakpoints |
| `debug_set_source_breakpoints` | Conditional/hit-count/log source breakpoints |
| `debug_set_function_breakpoints` | Function breakpoints |
| `debug_set_instruction_breakpoints` | Instruction-address breakpoints |
| `debug_data_breakpoint_info` | Resolve a debugger-owned data-breakpoint id |
| `debug_set_data_breakpoints` | Set live watchpoints/data breakpoints |
| `debug_set_exception_breakpoints` | Configure adapter-defined exception filters |
| `debug_pause` | Pause a live target |
| `debug_continue` | Continue a live target and optionally wait for stop |
| `debug_step` | Step over / into / out |
| `debug_threads` | List threads |
| `debug_stack` | Read stack frames |
| `debug_scopes` | Read frame scopes |
| `debug_variables` | Expand variables |
| `debug_evaluate` | Evaluate a debugger expression |
| `debug_modules` | List loaded modules/images |
| `debug_disassemble` | Disassemble around a memory reference |
| `debug_read_memory` | Read a bounded memory range |
| `debug_exception_info` | Read structured exception information |
| `debug_status` | Inspect session state/capabilities/events |
| `debug_events` | Read recent asynchronous DAP events |
| `debug_disconnect` | Disconnect and stop the adapter |

## Lifecycle and concurrency semantics

The server owns one shared debugger session. Session-mutating operations are serialized behind a reentrant lifecycle gate.

Composite workflows such as:

```text
debug_this_crash → start → reset → launch → wait → snapshot
```

can safely call guarded operations from the same async transaction, while an unrelated competing MCP request receives a deterministic lifecycle-busy error instead of racing adapter/session state.

## Local path safety

Local CodeLLDB/dump resources are normalized and validated as actual local files/directories. Legitimate parent segments such as `dir/../app.exe` are normalized rather than rejected with a simplistic `..` ban.

Generic DAP configuration objects remain adapter-resolvable so remote/container adapters are not incorrectly forced into local filesystem semantics.

## Logging

Structured logs are written to **stderr only** so MCP stdout remains protocol-clean.

Set:

```text
QWEN_DAP_LOG_LEVEL=debug|info|warn|error|silent
```

The logger safely handles real circular references without mislabeling repeated non-circular shared object references as `[Circular]`.

## Development

Requirements:

- Node.js 20+
- npm

Run the complete project check:

```bash
npm install --ignore-scripts
npm run check
```

`npm run check` performs TypeScript build, unit/integration tests, and extension-package staging.

The CI matrix runs on Node 20 and Node 22. Additional workflows exercise real CodeLLDB on Windows, including a generated native minidump.

## Safety model

- local stdio MCP transport only,
- no built-in remote HTTP debugger service,
- no bearer-auth layer is needed while transport remains stdio-only,
- no arbitrary memory-write MCP primitive,
- live attach is intended only for authorized local targets,
- postmortem dumps are explicitly frozen against execution-control operations,
- Qwen MCP trust review is not bypassed by the extension manifest.

## License

See `LICENSE`.
