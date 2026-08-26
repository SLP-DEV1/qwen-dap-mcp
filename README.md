# qwen-dap-mcp

A debugger-agnostic **Debug Adapter Protocol (DAP) → Model Context Protocol (MCP)** bridge for agentic native runtime debugging and postmortem crash analysis.

It gives Qwen Code and other MCP clients structured debugger evidence without embedding a native debugger protocol into the agent itself. CodeLLDB is the first built-in debugger profile.

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

The MCP remains a debugger/evidence/orchestration bridge. It intentionally does **not** become a general shell, arbitrary source-writing executor, or automatic git rollback engine. Qwen Code performs requested source edits, builds, tests, and source-control operations through its normal authorized tools.

### Start an autonomous cycle

```text
debug_this_crash(
  mode="codelldb",
  program="C:\\build\\app.exe",
  args=["--repro"],
  cwd="C:\\repo\\app",
  analysis={
    projectRoots:["C:\\repo\\app"],
    projectModules:["app.exe"],
    callerDepth:2
  },
  workflow={
    stage:"autonomous",
    maxIterations:3
  }
)
```

The first call returns `workflow.autonomousAgent` with:

- `protocolVersion` — formal autonomous action protocol version (`2` in v0.11),
- `state.rootFingerprint` — immutable original failure signature,
- `state.activeFingerprint` — failure currently being fixed,
- `state.iteration` / `maxIterations` — bounded fix budget,
- `state.history` — serialized diagnosis/verification history,
- `state.status` — loop state,
- `nextActions` — dependency-aware formal actions for the coding agent/debugger,
- `rootCauseBacktrack` — bounded runtime consumer → caller → producer-candidate evidence,
- `verificationQuality` — debugger-evidence score after verification,
- `shouldContinue` — whether the autonomous loop may continue,
- optional `stopReason`.

Every `nextActions` item contains a stable action `id`, `type`, `owner`, `status`, `requires` dependency IDs, structured `input`, and an `expectedResult` with explicit success criteria. Agents should honor `requires` before executing dependent actions.

The normal fix plan is:

```text
inspect-source
→ propose-fix
→ apply-fix
→ build
→ reproduce
→ verify
```

When evidence is too weak, the MCP emits `collect-evidence` instead of a patch request. Repeated identical `not-fixed` results can prepend `broaden-diagnosis` so the agent investigates earlier producer/ownership evidence rather than repeatedly guarding the final dereference.

After Qwen Code performs the requested source edit and rebuild, repeat the **same reproduction** and pass the returned state back unchanged:

```text
debug_this_crash(
  mode="codelldb",
  program="C:\\build\\app.exe",
  args=["--repro"],
  cwd="C:\\repo\\app",
  analysis={projectRoots:["C:\\repo\\app"], callerDepth:2},
  workflow={
    stage:"autonomous",
    agentState:<workflow.autonomousAgent.state from previous call>
  }
)
```

The server itself keeps no hidden autonomous-loop memory. The state is serializable and explicit, so MCP/client restarts do not silently lose diagnosis history or baselines.

### Autonomous statuses

| Status | Meaning |
| --- | --- |
| `needs-evidence` | Do not patch yet; improve project/caller evidence first |
| `needs-fix` | Evidence is strong enough for the first bounded source fix |
| `retry-fix` | Same active crash survived; revise the fix |
| `needs-reproduction` | Verification stopped too early; continue the original repro without editing again |
| `changed-failure` | Crash changed; preserve root fingerprint and re-baseline the new active failure |
| `fixed` | Complete reproduction ended cleanly; stop the autonomous loop |
| `budget-exhausted` | Maximum automatic fix attempts reached; stop and report |
| `blocked` | Trustworthy evidence for another autonomous edit is unavailable |

### Changed failures and rollback

A changed failure is **not** automatically reverted. It can be a regression, but it can also be a downstream bug that became visible after the original failure was removed. qwen-dap-mcp therefore re-baselines and diagnoses the changed crash first. A coding agent should only revert through normal source-control tools when source/build evidence supports that decision.

## Intelligent diagnosis

The diagnosis layer separates raw debugger facts from inference and reports:

- `classification` — best current crash/stop family,
- `faultLocation` — raw debugger stop frame,
- `projectFrame` — first likely application-controlled frame,
- `frameSelection` — scored stack-frame evidence and runtime/system exclusions,
- `operandAnalysis` — selected project-frame instruction operands, referenced registers, memory operands, and register↔local bindings,
- `callChain` — project callers, runtime boundary, repeated frames, pointer provenance, and root-cause candidate,
- `hypotheses` — ranked explanations with explicit confidence,
- `fixWorkflow` — candidate source location and narrow evidence-backed fix direction,
- `verificationBaseline` — compact failure signature for manual verification or autonomous state,
- `workflow.autonomousAgent.rootCauseBacktrack` — runtime provenance toward producer candidates,
- `workflow.autonomousAgent.verificationQuality` — debugger-evidence strength after a verification run.

A high frame-selection confidence means “likely project code”, not “proven cause”. Causal claims should be tied to exception state, operands/registers/locals, caller provenance, source confirmation, and reproduction.

### Fault frame versus project frame

When a crash stops inside `ntdll`, libc, an allocator, or another runtime helper, keep two views separate:

- `faultLocation` / `faultCorrelation`: the literal stopped frame/instruction,
- `projectFrame` / `operandAnalysis`: the first likely application-controlled frame and its local instruction context.

`debug_source_disassembly` returns the raw `faultCorrelation` together with the selected `projectFrame` and `operandAnalysis`. If `projectFrame.index !== 0`, the selected project instruction is context/call-site evidence, not automatically the literal faulting instruction. Check `operandAnalysis.likelyFaultOperand.faultingFrame`.

### Runtime root-cause backtracking

`rootCauseBacktrack` follows runtime evidence only. It can bind a suspicious operand/register/local value to matching values visible in bounded caller frames and suggest producer candidates, but it does not pretend to be full static source dataflow. Exact assignments, returns, ownership transfers, and invariants must still be confirmed by reading the listed source locations.

Repeated null values are deliberately weak provenance because unrelated pointers may independently be null. Distinctive poison values visible across multiple callers are stronger evidence.

## Verification quality

`verificationQuality.score` is a 0–100 score for **debugger evidence only**. The bridge deliberately keeps these fields external/unverified until the coding/build agent reports them:

- build result,
- project tests,
- exact reproduction inputs.

A high debugger score does not substitute for compilation or automated tests.

Verification verdicts:

- `fixed` — complete reproduction reached a clean successful terminal outcome (currently exit code 0),
- `not-fixed` — same crash family/signature reproduced,
- `changed-failure` — execution still crashed but the active failure signature changed,
- `inconclusive` — insufficient evidence to claim success or failure.

Windows verification source paths are canonicalized for separator and path-case differences, so `C:\\Work\\src\\foo.cpp` and `c:/work/src/foo.cpp` do not become different crash signatures solely because of representation.

A breakpoint, entry stop, pause, step, or configured/first-chance exception stop is deliberately **not** proof of a fix.

## Manual verify mode

Autonomous mode is optional. The explicit diagnose/fix/verify workflow remains available:

```text
debug_this_crash(
  mode="codelldb",
  program="C:\\build\\app.exe",
  args=["--repro"],
  workflow={
    stage:"verify",
    baseline:<verificationBaseline from original diagnosis>
  }
)
```

After debugger verification, run the project's normal automated tests too.

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

`debug_open_dump` remains available for raw postmortem inspection.

A dump session is frozen/read-only. Live execution and watchpoint operations are rejected. An old dump can establish evidence for that captured failure, but a source fix still needs a rebuilt live reproduction or a newly generated dump for verification.

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

## Install in Qwen Code

Install the latest GitHub Release:

```bash
qwen extensions install SLP-DEV1/qwen-dap-mcp
```

Then verify:

```text
/mcp
/skills
```

You should see the `qwen-dap-mcp` MCP server and bundled `native-runtime-debug` Skill.

The release archive is self-contained: runtime npm dependencies are bundled into `dist/index.js`.

## Main MCP tools

| Tool | Purpose |
| --- | --- |
| `debug_this_crash` | High-level current/live/CodeLLDB/dump diagnosis, verification, and autonomous orchestration |
| `debug_diagnose_stop` | Intelligent diagnosis of the current stopped state |
| `debug_source_disassembly` | Raw fault correlation plus selected project-frame instruction/operand/register/local context |
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

## Lifecycle and concurrency

The server owns one shared debugger session. Session-mutating operations are serialized by a reentrant lifecycle gate.

Composite operations such as:

```text
debug_this_crash → start → reset → launch → wait → snapshot → diagnose
```

may nest guarded calls within the same async transaction, while an unrelated competing MCP request gets a deterministic lifecycle-busy error instead of racing the shared adapter.

The autonomous state machine is intentionally separate from this in-process lifecycle state: it travels explicitly through the MCP request/response.

## Local path safety

Local CodeLLDB/dump resources are normalized and validated as actual local files/directories **before** starting the adapter when the high-level CodeLLDB/dump workflows can validate them locally. Legitimate parent segments such as `dir/../app.exe` are normalized rather than rejected by a simplistic `..` ban.

Generic DAP configuration objects remain adapter-defined so remote/container adapters are not incorrectly forced into local-filesystem semantics.

## DAP lifecycle hardening

The connection/session layer includes safeguards for failure paths found during review:

- launch/attach request and `initialized` waits observe each other so an early actionable failure is not hidden behind a later timeout,
- pause/continue/step event waits cannot become orphaned rejected promises after request failure,
- adapter exit/error interrupts pending event waits,
- process liveness is based on actual exit state rather than “a signal was sent”,
- shutdown escalates and waits after forced termination,
- recent DAP events/stderr are reset between adapter sessions,
- inbound DAP headers/payloads are bounded to avoid unbounded buffering.

## Logging

Structured logs are written to **stderr only** so MCP stdout remains protocol-clean.

```text
QWEN_DAP_LOG_LEVEL=debug|info|warn|error|silent
```

## Real Windows validation

The repository contains real CodeLLDB smoke workflows on Windows.

The minidump smoke test:

1. compiles an MSVC C++ crash target with PDB symbols,
2. intentionally triggers an access violation,
3. writes a real `.dmp` with `MiniDumpWriteDump`,
4. downloads/starts real CodeLLDB,
5. opens the dump through DAP,
6. verifies stack/source/register/module/disassembly recovery,
7. runs intelligent project-frame diagnosis,
8. validates that a bounded autonomous state/fingerprint/action decision can be created from the real dump.

## Development

Requirements:

- Node.js 20+
- npm

Run the complete check:

```bash
npm install --ignore-scripts
npm run check
```

`npm run check` performs TypeScript build, tests, and extension-package staging. CI runs Node 20/22. Changes under the runtime/diagnostics/tool/skill paths also trigger the real Windows CodeLLDB live/dump and extension-package smoke workflows on `main`.

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
- first-chance/configured exception stops are not automatically treated as fatal,
- Qwen MCP trust review is not bypassed by the extension manifest.

## License

See `LICENSE`.
