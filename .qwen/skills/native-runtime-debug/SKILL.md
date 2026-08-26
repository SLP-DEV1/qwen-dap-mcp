---
name: native-runtime-debug
description: Diagnose native C/C++ runtime bugs and crash dumps with qwen-dap-mcp and DAP. Use for crashes, minidumps/core dumps, bad runtime state, unexpected variable changes, breakpoint-driven investigation, and verifying native fixes with CodeLLDB or another authorized local DAP target.
---

# Native Runtime Debugging

Use `qwen-dap-mcp` to reason from structured debugger evidence instead of guessing from logs. This skill is for software, crash artifacts, and authorized local targets the user owns or is permitted to debug.

## Prefer the v0.9 agent workflow

For crash-oriented tasks, prefer `debug_this_crash` over manually chaining low-level DAP calls.

### Reproduce a local native crash

Use:

```text
debug_this_crash(
  mode="codelldb",
  program=...,
  args=[...],
  cwd=...,
  analysis={projectRoots:[...], callerDepth:2}
)
```

The bridge discovers/starts CodeLLDB, launches the executable, waits race-safely for stop/exit, captures bounded debugger state, selects the first likely project-controlled frame, correlates instruction operands with registers/locals, traces bounded caller provenance, and returns a fix/verification plan.

### Analyze an existing dump

Use:

```text
debug_this_crash(
  mode="dump",
  dumpPath=...,
  program=...,
  sourceMap={...},
  analysis={projectRoots:[...]}
)
```

A dump is frozen postmortem state. Inspect it, form a diagnosis, patch/rebuild separately, then verify with a new live reproduction or a newly generated dump.

### Diagnose an already stopped session

Use `debug_diagnose_stop()`.

When the stack contains runtime/system frames, pass project hints when known:

```text
debug_diagnose_stop(
  analysis={
    projectRoots:["C:\\repo\\my-project"],
    projectModules:["myapp.exe"],
    callerDepth:2
  }
)
```

### Focus on source/instruction data flow

Use `debug_source_disassembly()` when the diagnosis needs a narrower machine-code view. In v0.9 it selects the first likely project frame and reports operand/register/local bindings when the values can be correlated.

## Read the v0.9 diagnosis in this order

1. `classification`
   - Best crash/stop family from raw debugger evidence.
   - Confidence is evidence strength, not proof.
2. `faultLocation`
   - Raw frame where the debugger stopped. This can legitimately be inside `ntdll`, `ucrtbase`, libc, libstdc++, or another runtime.
3. `projectFrame`
   - First likely application-controlled frame selected from the stack.
   - Read its `confidence` and `reasons` before treating it as authoritative.
4. `frameSelection`
   - Scores every bounded frame and records why runtime/system frames were skipped.
5. `operandAnalysis`
   - Current/nearest instruction for the selected frame.
   - Registers referenced by the instruction.
   - Whether a register participates in a memory operand.
   - Pointer-like locals whose numeric value matches a referenced register.
6. `callChain`
   - Runtime boundary depth.
   - Project caller frames.
   - Repeated frames that can indicate recursion/re-entry.
   - Bounded pointer-value provenance across callers.
   - A root-cause candidate with explicit confidence and rationale.
7. `hypotheses`
   - Ranked explanations from exception + variable + instruction evidence.
8. `fixWorkflow`
   - Candidate source location and evidence-backed change direction.
9. `verificationBaseline`
   - Compact failure signature to pass back after source fix/rebuild.

Never turn a heuristic into a confirmed root-cause statement. Prefer “the debugger shows”, “consistent with”, or “strong candidate” until the failing operand/data path is actually tied to the crash.

## Automatic project-frame selection

The bridge scores frames using conservative signals:

- source path under explicit `projectRoots`,
- module matching `projectModules` or the launched `program`,
- source information on otherwise non-runtime frames,
- negative weighting for known runtime/system modules and paths.

Explicit project hints are preferred. If they are absent, the bridge falls back to the first non-runtime frame with source information.

A high frame-selection confidence means “this is very likely project code”; it does not by itself mean “this frame caused the bug”. Causality still comes from operands, values, callers, exception state, and reproduction.

## Operand ↔ register ↔ variable reasoning

Use `operandAnalysis` to avoid the classic false claim “RAX is zero, therefore null dereference”.

A strong null-dereference chain looks like:

```text
exception: access violation / SIGSEGV
current instruction: memory operand uses RAX
RAX: 0x0
local User*: 0x0
local value matches RAX
```

If the selected project frame is not stack frame 0, its instruction is a project call-site/context instruction, not automatically the literal faulting machine instruction. `likelyFaultOperand.faultingFrame` distinguishes this case.

Poison/debug values such as `0xFEEEFEEE`, `0xDDDDDDDD`, `0xCDCDCDCD`, `0xCCCCCCCC`, or `0xDEADBEEF` can strengthen lifetime/uninitialized-memory hypotheses. They are still evidence, not standalone proof.

## Call-chain cause analysis

Use `callChain` to reason backwards from symptom to provenance.

- `runtimeBoundaryDepth > 0`: the raw crash occurred above project code; inspect the first project call site and arguments feeding the runtime.
- `projectCallerFrames`: bounded caller candidates that may have produced the bad value.
- `provenance`: the same pointer-like numeric value appeared in multiple project frames.
- `repeatedFunctions`: repeated frames may support stack-overflow/recursion hypotheses.

A repeated distinctive poison pointer can be strong provenance evidence. Repeated `0x0` values are intentionally low confidence because unrelated pointers can all be null.

For heap corruption, remember that the allocator/runtime crash frame can occur long after the original invalid write. Prefer ASan/PageHeap/allocator diagnostics when a live reproduction is available.

## Diagnose → Fix → Rebuild → Reproduce → Verify

`qwen-dap-mcp` provides the debugger evidence and verification baseline. It intentionally does **not** add a general shell executor or arbitrary source-writing mechanism.

Use Qwen Code's normal authorized coding/build tools for source edits and builds.

### Phase 1: Diagnose

Run `debug_this_crash(...)` and preserve:

- `classification`,
- `faultLocation`,
- `projectFrame`,
- relevant `operandAnalysis`,
- `callChain`,
- highest-confidence hypothesis,
- `verificationBaseline`.

### Phase 2: Fix

Read source around `fixWorkflow.candidateLocation`.

Apply the smallest change supported by the evidence. Prefer fixing the producer/invariant/ownership boundary rather than only hiding the final symptom.

Examples:

- null dereference: restore the pointer/reference invariant at the earliest evidenced boundary,
- lifetime bug: fix ownership or stale-reference use,
- divide-by-zero: repair the divisor invariant and validate at the correct input boundary,
- stack overflow: fix recursion termination/re-entry or excessive stack use,
- abort/assert: repair the violated invariant, not the assertion itself,
- heap corruption: find the first invalid write/free rather than patching the allocator crash site.

### Phase 3: Rebuild

Use the project's existing build system. Preserve matching debug symbols.

Do not verify a rebuilt binary against stale symbols or an old binary/dump pairing.

### Phase 4: Reproduce and verify

Run the same scenario again and pass the original baseline:

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

Interpret `workflow.verification.verdict` as follows:

- `fixed`: the reproduced scenario reached a clean successful terminal outcome, currently exit code 0.
- `not-fixed`: the same crash family and matching project failure signature reproduced.
- `changed-failure`: execution still crashed, but the failure signature changed; diagnose it as a potentially new/downstream bug.
- `inconclusive`: there was not enough evidence to claim success or failure.

A breakpoint, entry stop, pause, or other non-crash stopped state is **not proof of a fix**. Continue/reproduce the full original scenario until a successful terminal outcome or a crash signature is observed.

After debugger verification, run the project's normal automated tests too.

## Raw/live fallback tools

Use lower-level tools only when the high-level diagnosis identifies a concrete follow-up question.

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

## Targeted follow-ups

### Unexpected variable write

Use a live data breakpoint instead of repeatedly stepping:

```text
1. debug_snapshot()
2. debug_data_breakpoint_info(name=..., variablesReference=..., frameId=...)
3. debug_set_data_breakpoints([{dataId=..., accessType="write"}])
4. debug_continue(threadId=...)
5. debug_snapshot()
6. identify the write site and value transition
7. debug_set_data_breakpoints(breakpoints=[])
```

Never use watchpoints on a postmortem dump.

### Known suspicious function

Use `debug_set_function_breakpoints`, continue to the relevant stop, then clear the temporary breakpoint.

### Conditional source stop

Use `debug_set_source_breakpoints` for conditions, hit counts, columns, or log messages.

### Exact instruction stop

Use `debug_set_instruction_breakpoints` only in a live session after the instruction reference is established.

### Specific expression

Use `debug_evaluate` narrowly. Debugger expression evaluation can have side effects depending on language/debugger.

### Bounded memory

Use `debug_read_memory` only when variables, exception details, and source/disassembly do not already answer the question.

## Postmortem rules

A dump session is frozen/read-only. Never call these on a dump:

- `debug_continue`
- `debug_step`
- `debug_pause`
- `debug_data_breakpoint_info`
- `debug_set_data_breakpoints`

Valid inspection includes `debug_snapshot`, `debug_diagnose_stop`, `debug_source_disassembly`, `debug_threads`, `debug_stack`, `debug_scopes`, `debug_variables`, `debug_modules`, `debug_disassemble`, `debug_read_memory`, and `debug_exception_info` when supported.

Finish dump analysis with `debug_disconnect(terminateDebuggee=false)`.

## Windows CodeLLDB pause caveat

A requested `debug_pause` on Windows can surface as a `DebugBreak` / `0x80000003` exception-like stop. Do not classify that by itself as an application crash when it immediately follows a user-requested pause.

This caveat does not apply to an independently captured crash dump.

## Root-cause claim standard

A strong final diagnosis states:

- how the state was captured,
- raw stop/exception evidence,
- raw fault frame,
- first likely project frame and why it was selected,
- operand/register/variable evidence tied to the relevant instruction,
- caller/provenance evidence when available,
- most likely cause and confidence,
- remaining alternatives,
- exact verification result after rebuild/reproduction.

Do not call a bug fixed solely because the source looks plausible or because execution reached a breakpoint without crashing.
