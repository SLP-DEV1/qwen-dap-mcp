# qwen-dap-mcp

**Give Qwen Code a real native debugger.**

A debugger-agnostic **Debug Adapter Protocol (DAP) → Model Context Protocol (MCP)** bridge for native runtime debugging, crash analysis, and bounded autonomous fix/verify loops.

[![CI](https://github.com/SLP-DEV1/qwen-dap-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/SLP-DEV1/qwen-dap-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/SLP-DEV1/qwen-dap-mcp)](https://github.com/SLP-DEV1/qwen-dap-mcp/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

## Why this exists

Coding agents are good at reading and editing source, but native crashes often need evidence that only a debugger can provide: stack frames, registers, locals, disassembly, exception state, memory, modules, and crash dumps.

`qwen-dap-mcp` exposes that evidence through MCP so Qwen Code and other MCP clients can reason about native failures without embedding a debugger protocol inside the agent.

### What it can do

- **Autonomous crash debugging** — diagnose → inspect source → propose fix → apply fix → build → reproduce → verify.
- **Real native debugger evidence** — stack, registers, locals, exception state, modules, disassembly, memory, and source correlation.
- **CodeLLDB integration** — launch or attach to authorized local native targets through DAP.
- **Windows minidumps / postmortem debugging** — open existing `.dmp` files and recover structured evidence.
- **Runtime root-cause backtracking** — follow suspicious values through bounded caller frames toward likely project-controlled producer candidates.
- **Verification fingerprints** — distinguish fixed, same-crash, changed-failure, and inconclusive reproductions.
- **Safety boundaries** — no arbitrary shell, source-writing primitive, general memory-write primitive, or hidden autonomous state inside the MCP server.

## 30-second example

```text
You: Debug why app.exe crashes with --repro

Qwen Code
  ↓
starts CodeLLDB through qwen-dap-mcp
  ↓
finds the native failure and first project-controlled frame
  ↓
correlates instruction operands ↔ registers ↔ locals
  ↓
backtracks runtime evidence toward a likely producer
  ↓
reads the relevant source
  ↓
applies a minimal evidence-backed fix
  ↓
builds and repeats the same reproduction
  ↓
verifies the original crash fingerprint no longer reproduces
```

## Install in Qwen Code

The easiest installation path is the GitHub release:

```bash
qwen extensions install SLP-DEV1/qwen-dap-mcp
```

Then verify the extension and MCP server:

```text
/mcp
/skills
```

You should see the `qwen-dap-mcp` MCP server and bundled `native-runtime-debug` Skill.

The GitHub release archive is self-contained: runtime npm dependencies are bundled into `dist/index.js`.

### npm distribution

The project is also prepared for scoped npm distribution as `@slp-dev1/qwen-dap-mcp`. Qwen Code supports scoped npm extensions directly:

```bash
qwen extensions install @slp-dev1/qwen-dap-mcp
```

Use the GitHub installation command above until the scoped npm package has been published.

## Autonomous crash debugging

The high-level `debug_this_crash` workflow can drive a bounded autonomous debugging cycle:

```text
Diagnose
  ↓
select project frame
  ↓
operand ↔ register ↔ variable evidence
  ↓
call-chain / runtime provenance backtrack
  ↓
inspect source
  ↓
propose minimal fix
  ↓
apply fix
  ↓
build
  ↓
reproduce
  ↓
verify fingerprint + evidence quality
  ├── fixed → stop
  ├── same crash → revise fix
  ├── changed crash → re-baseline active failure
  ├── inconclusive → finish reproduction, do not edit
  └── budget exhausted / weak evidence → stop and report
```

Start an autonomous cycle:

```text
debug_this_crash(
  mode="codelldb",
  program="C:\\build\\app.exe",
  args=["--repro"],
  cwd="C:\\repo\\app",
  analysis={
    projectRoots:["C:\\repo\\app"],
    projectModules:["app.exe"],
    callerDepth:3
  },
  workflow={
    stage:"autonomous",
    maxIterations:3
  }
)
```

The first call returns `workflow.autonomousAgent` with explicit serializable state, dependency-aware `nextActions`, root and active crash fingerprints, bounded history, runtime backtracking evidence, verification quality, and stop/continue status.

The server keeps no hidden autonomous-loop memory. Qwen Code performs requested source edits, builds, tests, and source-control operations through its normal authorized tools.

### Autonomous statuses

| Status | Meaning |
| --- | --- |
| `needs-evidence` | Do not patch yet; collect stronger project/caller evidence |
| `needs-fix` | Evidence is strong enough for the first bounded source fix |
| `retry-fix` | The same active crash survived; revise the fix |
| `needs-reproduction` | Verification stopped too early; finish the original reproduction |
| `changed-failure` | A different crash appeared; preserve the root fingerprint and re-baseline |
| `fixed` | The complete reproduction ended cleanly |
| `budget-exhausted` | Maximum automatic fix attempts reached |
| `blocked` | Trustworthy evidence for another autonomous edit is unavailable |

## Intelligent diagnosis

The diagnosis layer separates raw debugger facts from inference and reports:

- `classification` — current crash/stop family,
- `faultLocation` — literal debugger stop frame,
- `projectFrame` — first likely application-controlled frame,
- `frameSelection` — scored stack-frame evidence and runtime/system exclusions,
- `operandAnalysis` — instruction operands, referenced registers, memory operands, and register↔local bindings,
- `callChain` — project callers, runtime boundaries, repeated frames, and provenance clues,
- `hypotheses` — ranked explanations with explicit confidence,
- `fixWorkflow` — candidate source location and narrow evidence-backed fix direction,
- `verificationBaseline` — compact failure signature,
- `rootCauseBacktrack` — bounded runtime provenance toward producer candidates,
- `verificationQuality` — debugger-evidence strength after verification.

A high project-frame score means “likely project code”, not “proven root cause”. Causal claims should still be tied to exception state, operands/registers/locals, caller provenance, source confirmation, and reproduction.

## Crash dumps / minidumps

Open and diagnose an existing dump in one high-level call:

```text
debug_this_crash(
  mode="dump",
  dumpPath="C:\\crashes\\app.dmp",
  program="C:\\build\\app.exe",
  sourceMap={"D:/agent/_work/project/src":"C:/work/project/src"},
  analysis={projectRoots:["C:\\repo\\app"]}
)
```

A dump session is frozen/read-only. A historical dump can establish evidence for the captured failure, but a source fix still needs a rebuilt live reproduction or a newly generated dump for verification.

## Architecture

```text
Qwen Code / MCP client
        │
        │ MCP over stdio
        ▼
   qwen-dap-mcp
        │
        ├── lifecycle/concurrency guard
        ├── bounded DAP snapshot layer
        ├── crash classification
        ├── project-frame scoring
        ├── operand/register/local correlation
        ├── call-chain provenance
        ├── runtime root-cause backtracking
        ├── verification fingerprints + quality scoring
        └── autonomous action state machine
        │
        │ DAP over stdio
        ▼
 CodeLLDB / DAP adapter
        │
        ├── authorized live target
        └── crash dump / core file
```

The MCP server has no HTTP listener. The adapter is spawned locally without a shell and communicates over stdio.

## Main MCP tools

| Tool | Purpose |
| --- | --- |
| `debug_this_crash` | High-level live/CodeLLDB/dump diagnosis, verification, and autonomous orchestration |
| `debug_diagnose_stop` | Intelligent diagnosis of the current stopped state |
| `debug_source_disassembly` | Fault correlation plus project-frame instruction/operand/register/local context |
| `debug_run_to_stop` | Launch/attach and race-safely wait for stop/exit/termination |
| `debug_open_dump` | Open a native core/minidump for read-only postmortem inspection |
| `debug_snapshot` | Capture a bounded raw runtime snapshot |
| `debug_codelldb_info` | Discover CodeLLDB |
| `debug_start_codelldb` | Start and initialize CodeLLDB |
| `debug_launch_codelldb` | Launch a local native target using CodeLLDB |
| `debug_attach_codelldb` | Attach to an authorized local process |
| `debug_start` / `debug_launch` / `debug_attach` | Generic local DAP workflows |
| `debug_set_source_breakpoints` | Conditional/hit-count/log source breakpoints |
| `debug_set_function_breakpoints` | Function breakpoints |
| `debug_set_instruction_breakpoints` | Instruction breakpoints |
| `debug_data_breakpoint_info` / `debug_set_data_breakpoints` | Live data watchpoints |
| `debug_set_exception_breakpoints` | Adapter-defined exception filters |
| `debug_pause` / `debug_continue` / `debug_step` | Live execution control |
| `debug_threads` / `debug_stack` | Thread and stack inspection |
| `debug_scopes` / `debug_variables` | Scope/variable inspection |
| `debug_evaluate` | Narrow debugger expression evaluation |
| `debug_modules` | Loaded modules/images |
| `debug_disassemble` | Bounded machine-code inspection |
| `debug_read_memory` | Bounded memory read |
| `debug_exception_info` | Structured exception information |
| `debug_status` / `debug_events` | Session status and recent DAP events |
| `debug_disconnect` | Disconnect and stop the adapter |

## Verification model

Verification deliberately separates debugger evidence from external guarantees such as build success, project tests, and exact reproduction inputs.

Verdicts:

- `fixed` — complete reproduction reached a clean successful terminal outcome,
- `not-fixed` — same crash family/signature reproduced,
- `changed-failure` — execution still crashed but the active failure signature changed,
- `inconclusive` — insufficient evidence to claim success or failure.

A breakpoint, entry stop, pause, step, or configured/first-chance exception stop is deliberately **not** proof of a fix.

## Real Windows validation

The repository contains real CodeLLDB smoke workflows on Windows. The minidump smoke path:

1. compiles an MSVC C++ crash target with PDB symbols,
2. intentionally triggers an access violation,
3. writes a real `.dmp` with `MiniDumpWriteDump`,
4. starts real CodeLLDB,
5. opens the dump through DAP,
6. verifies stack/source/register/module/disassembly recovery,
7. runs intelligent project-frame diagnosis,
8. validates autonomous state/fingerprint/action generation from the real dump.

## Development

Requirements:

- Node.js 20+
- npm

Run the complete check:

```bash
npm install --ignore-scripts
npm run check
```

`npm run check` performs TypeScript build, tests, and extension-package staging. CI runs Node 20 and 22.

## Safety model

- local stdio MCP transport only,
- no built-in remote HTTP debugger service,
- no arbitrary shell/source-writing MCP primitive,
- no arbitrary memory-write MCP primitive,
- no automatic source rollback without external evidence,
- live attach intended only for authorized local targets,
- postmortem dumps frozen against execution-control operations,
- bounded autonomous fix budget with deterministic stop conditions,
- weak/inconclusive evidence does not trigger another source edit,
- first-chance/configured exception stops are not automatically treated as fatal.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidance.

If the project is useful to you, starring the repository helps other Qwen Code and MCP users discover it.

## License

Apache License 2.0. See [LICENSE](LICENSE).
