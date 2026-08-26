---
name: native-runtime-debug
description: Diagnose native C/C++ runtime bugs and crash dumps with qwen-dap-mcp and DAP. Use for crashes, minidumps/core dumps, bad runtime state, unexpected variable changes, breakpoint-driven investigation, and verifying native fixes with CodeLLDB or another authorized local DAP target.
---

# Native Runtime Debugging

Use `qwen-dap-mcp` to reason from structured debugger evidence instead of guessing from logs. This skill is for software, crash artifacts, and authorized local targets the user owns or is permitted to debug.

## Prefer the autonomous crash workflow

For crash-fixing tasks, prefer one high-level loop through `debug_this_crash` instead of manually chaining many DAP calls.

Start with:

```text
debug_this_crash(
  mode="codelldb",
  program=...,
  args=[...],
  cwd=...,
  analysis={projectRoots:[...], callerDepth:2},
  workflow={stage:"autonomous", maxIterations:3}
)
```

The first autonomous call diagnoses the failure and returns `workflow.autonomousAgent`. Read:

- `state.rootFingerprint`: immutable fingerprint of the original failure,
- `state.activeFingerprint`: failure currently being fixed,
- `state.iteration` / `maxIterations`: bounded fix-attempt budget,
- `state.history`: diagnosis/verification history,
- `state.status`: current loop state,
- `nextActions`: ordered actions assigned to either `coding-agent` or `debugger`,
- `shouldContinue`: whether the loop may continue,
- `stopReason`: why the loop ended when present.

Follow `nextActions` in order. Use Qwen Code's normal authorized file-editing and build tools for `inspect-source`, `apply-fix`, and `rebuild`. qwen-dap-mcp intentionally does not expose an arbitrary shell or source-writing executor.

After the requested edit/rebuild, reproduce the **same scenario** and pass the returned state back unchanged:

```text
debug_this_crash(
  mode="codelldb",
  program=...,
  args=[...],
  cwd=...,
  analysis={projectRoots:[...], callerDepth:2},
  workflow={
    stage:"autonomous",
    agentState:<workflow.autonomousAgent.state from previous call>
  }
)
```

Do not invent or edit the serialized state yourself. The MCP owns crash fingerprinting and loop transitions.

### Autonomous state policy

- `needs-fix`: inspect the evidence-backed source location, apply the smallest justified fix, rebuild, reproduce.
- `retry-fix`: the same crash survived; revise the fix rather than claiming success.
- `needs-evidence`: do not patch yet. Improve project hints / bounded caller evidence first.
- `needs-reproduction`: the run stopped at a breakpoint, entry, pause, or another inconclusive state. Continue the original reproduction; do **not** consume another edit attempt.
- `changed-failure`: the old active signature changed. The MCP preserves the original `rootFingerprint`, re-baselines the new source-backed crash as the active failure, and continues within the same budget.
- `fixed`: stop editing. Report the source change and verification evidence.
- `budget-exhausted`: stop automatic editing and report the iteration history.
- `blocked`: stop because the available evidence is not trustworthy enough for another autonomous patch.

After repeated identical `not-fixed` verification results, obey a `broaden-diagnosis` action before editing again. Inspect earlier caller/provenance evidence and the producer/ownership boundary rather than repeatedly adding guards at the final dereference.

## What the intelligent diagnosis means

Read the diagnosis in this order:

1. `classification`: crash/stop family and confidence.
2. `faultLocation`: raw debugger stop frame. It can be inside `ntdll`, `ucrtbase`, libc, libstdc++, an allocator, or another runtime.
3. `projectFrame`: first likely application-controlled frame.
4. `frameSelection`: scored stack-frame evidence and reasons runtime/system frames were skipped.
5. `operandAnalysis`: selected instruction, referenced registers, memory operands, and register↔local bindings.
6. `callChain`: project callers, runtime boundary, repeated frames, pointer provenance, and a root-cause candidate.
7. `hypotheses`: ranked evidence-based explanations.
8. `fixWorkflow`: candidate location and suggested change direction.
9. `verificationBaseline`: compact failure signature used by manual verification and the autonomous state machine.

A high project-frame confidence means “very likely project code”, not “proven root cause”. Do not turn a heuristic into certainty. Prefer wording such as “the debugger shows”, “consistent with”, or “strong candidate” until operand/data-flow and reproduction evidence agree.

## Automatic project-frame selection

The bridge prefers:

- source paths under explicit `analysis.projectRoots`,
- modules matching `analysis.projectModules` or the launched program,
- source-backed non-runtime frames,
- negative weights for known runtime/system modules and paths.

When the stack begins in system/runtime code, pass project hints whenever known.

For an already stopped session:

```text
debug_diagnose_stop(
  analysis={
    projectRoots:["C:\\repo\\my-project"],
    projectModules:["myapp.exe"],
    callerDepth:3
  }
)
```

Use `debug_source_disassembly()` when you need a focused machine-code view of `projectFrame` and its operand/register/local mapping.

## Operand ↔ register ↔ variable reasoning

Do not claim “RAX is zero, therefore null dereference” unless the instruction actually uses RAX in the relevant memory operand.

A stronger chain is:

```text
access violation / SIGSEGV
↓
current instruction dereferences [RAX]
↓
RAX = 0x0
↓
local Widget* = 0x0
↓
local numeric value matches RAX
```

If `projectFrame.index !== 0`, its instruction is project call-site/context evidence, not automatically the literal faulting machine instruction. Check `operandAnalysis.likelyFaultOperand.faultingFrame`.

Poison/debug patterns such as `0xFEEEFEEE`, `0xDDDDDDDD`, `0xCDCDCDCD`, `0xCCCCCCCC`, and `0xDEADBEEF` can strengthen lifetime/uninitialized-memory hypotheses, but still are not standalone proof.

## Call-chain cause analysis

Use `callChain` to reason backwards from symptom to producer:

- `runtimeBoundaryDepth > 0`: raw fault sits above project code; inspect the first project call site and arguments feeding the runtime.
- `projectCallerFrames`: bounded project callers that may have produced the bad value.
- `provenance`: same pointer-like numeric value across frames.
- `repeatedFunctions`: possible recursion/re-entry evidence.

A distinctive poison value repeated through multiple callers can be high-confidence provenance. Repeated `0x0` values are intentionally low-confidence because unrelated pointers can independently be null.

For heap corruption, allocator/runtime failure may occur well after the original invalid write/free. Prefer ASan, PageHeap, allocator diagnostics, or a targeted live data-breakpoint investigation when available.

## Manual Diagnose → Fix → Rebuild → Reproduce → Verify

Use the manual workflow when you do not want the autonomous state machine.

Diagnose with `debug_this_crash(...)`, read `fixWorkflow`, edit with normal coding tools, rebuild with matching debug symbols, then reproduce with the original baseline:

```text
debug_this_crash(
  mode="codelldb",
  program=...,
  args=[...],
  analysis={projectRoots:[...]},
  workflow={
    stage:"verify",
    baseline:<verificationBaseline from original diagnosis>
  }
)
```

Interpret `workflow.verification.verdict`:

- `fixed`: the complete reproduction reached a clean successful terminal outcome (currently a clean exit code 0).
- `not-fixed`: the same failure signature reproduced.
- `changed-failure`: execution still crashed but the failure signature changed.
- `inconclusive`: there is not enough evidence to claim success or failure.

A breakpoint, entry stop, pause, or step is not proof of a fix. Finish the original reproduction. After debugger verification, run the project's normal automated tests too.

## Crash dumps

Analyze a dump with:

```text
debug_this_crash(
  mode="dump",
  dumpPath=...,
  program=...,
  sourceMap={...},
  analysis={projectRoots:[...]}
)
```

A dump is frozen postmortem state. Never call live execution/watchpoint operations on it. Valid inspection includes `debug_snapshot`, `debug_diagnose_stop`, `debug_source_disassembly`, `debug_threads`, `debug_stack`, `debug_scopes`, `debug_variables`, `debug_modules`, `debug_disassemble`, `debug_read_memory`, and `debug_exception_info` when supported.

Never use these on a dump:

- `debug_continue`
- `debug_step`
- `debug_pause`
- `debug_data_breakpoint_info`
- `debug_set_data_breakpoints`

Finish dump analysis with `debug_disconnect(terminateDebuggee=false)`.

A dump can seed diagnosis, but verification after a source fix should use a rebuilt live reproduction or a newly generated dump, not the stale original artifact.

## Raw/live fallback tools

Use lower-level tools only for a concrete unanswered question from the high-level diagnosis.

Typical live fallback:

```text
1. debug_codelldb_info()
2. debug_start_codelldb()
3. optional debug_set_exception_breakpoints(...)
4. debug_launch_codelldb(program=..., breakpoints=[...])
5. debug_snapshot(includeModules=true, includeExceptionInfo=true)
6. debug_diagnose_stop(analysis={projectRoots:[...]})
7. targeted follow-up
8. debug_disconnect()
```

`debug_run_to_stop(...)` remains useful for an already initialized generic DAP adapter.

### Unexpected variable write

Use a live data breakpoint rather than repeatedly stepping:

```text
1. debug_snapshot()
2. debug_data_breakpoint_info(name=..., variablesReference=..., frameId=...)
3. debug_set_data_breakpoints([{dataId=..., accessType="write"}])
4. debug_continue(threadId=...)
5. debug_snapshot()
6. identify the write site/value transition
7. debug_set_data_breakpoints(breakpoints=[])
```

### Other targeted controls

- `debug_set_function_breakpoints`: known suspicious function.
- `debug_set_source_breakpoints`: conditional/hit-count/log source stop.
- `debug_set_instruction_breakpoints`: exact live instruction stop after resolving an instruction reference.
- `debug_evaluate`: narrow expression inspection; remember debugger evaluation can have side effects.
- `debug_read_memory`: bounded memory only when structured variables/disassembly do not answer the question.

## Windows CodeLLDB pause caveat

A requested `debug_pause` on Windows can surface as a `DebugBreak` / `0x80000003` exception-like stop. Do not classify that alone as an application crash when it immediately follows a requested pause.

## Root-cause / autonomous completion standard

A strong final result records:

- how state was captured,
- raw exception/stop evidence,
- raw fault frame,
- selected project frame and selection reasons,
- operand/register/variable evidence,
- caller/provenance evidence,
- most likely cause and confidence,
- source change actually made,
- rebuild result,
- autonomous iteration history or manual verification verdict,
- exact clean reproduction evidence when claiming `fixed`.

Never call a bug fixed solely because the source looks plausible or because execution reached a breakpoint without crashing.
