---
name: native-runtime-debug
description: Diagnose native C/C++ runtime bugs and crash dumps with qwen-dap-mcp and DAP. Use for crashes, minidumps/core dumps, bad runtime state, unexpected variable changes, breakpoint-driven investigation, and verifying native fixes with CodeLLDB or another authorized local DAP target.
---

# Native Runtime Debugging

Use `qwen-dap-mcp` to reason from structured debugger evidence instead of guessing from logs. This skill is for software, crash artifacts, and authorized local targets the user owns or is permitted to debug.

## Prefer `debug_this_crash`

For crash-fixing work, prefer the high-level workflow instead of manually chaining raw DAP calls:

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

The first autonomous call returns `workflow.autonomousAgent`. Treat it as a formal protocol, not free-form advice.

Read:

- `protocolVersion`: action protocol version. v0.11 uses version 2.
- `state.rootFingerprint`: immutable signature of the original failure.
- `state.activeFingerprint`: crash currently being fixed.
- `state.iteration` / `maxIterations`: bounded fix-attempt budget.
- `state.history`: serialized diagnosis and verification history.
- `state.status`: current autonomous loop state.
- `nextActions`: ordered formal actions.
- `rootCauseBacktrack`: runtime consumer → propagation → producer-candidate evidence.
- `verificationQuality`: debugger-evidence score and explicit external-unverified checks.
- `shouldContinue`: whether the loop may continue.
- `stopReason`: deterministic stop explanation when present.

Each `nextActions` entry contains:

- `id`
- `type`
- `owner` (`coding-agent` or `debugger`)
- `status`
- `requires` dependency IDs
- `input`
- `expectedResult.description`
- `expectedResult.successCriteria`
- optional evidence

Honor dependencies. Do not execute an action before all IDs in `requires` are satisfied.

The normal fix chain is:

```text
inspect-source
→ propose-fix
→ apply-fix
→ build
→ reproduce
→ verify
```

When evidence is weak the MCP emits `collect-evidence` instead of a patch action. After repeated identical failures it can prepend `broaden-diagnosis` so the agent investigates earlier producer/ownership evidence instead of repeatedly guarding the final dereference.

qwen-dap-mcp intentionally does not expose a general shell, arbitrary source writer, git reset, or arbitrary memory-write primitive. Use Qwen Code's normal authorized coding/build tools for source inspection, editing, builds, tests, and repository operations.

## Continue an autonomous cycle

After the requested edit/rebuild, reproduce the same scenario and pass the returned state back unchanged:

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

Do not invent, partially copy, or edit serialized state yourself. The MCP owns fingerprints and state transitions.

### Autonomous states

- `needs-evidence`: do not patch. Improve bounded source/caller evidence first.
- `needs-fix`: inspect, propose, patch, build, reproduce, verify.
- `retry-fix`: the same crash survived. Revise the hypothesis instead of claiming success.
- `needs-reproduction`: the run stopped too early. Reproduce again without consuming another edit attempt.
- `changed-failure`: the active failure changed. Preserve the original root fingerprint, re-baseline the new failure, and diagnose it before editing again.
- `fixed`: stop editing and report the evidence.
- `budget-exhausted`: stop automatic editing and report iteration history.
- `blocked`: stop because trustworthy evidence is unavailable.

### Rollback policy

Do **not** automatically revert a patch just because verification reports `changed-failure`. A changed crash can mean either a regression or that the original fix exposed a downstream defect. qwen-dap-mcp therefore does not automatically emit a rollback action. Preserve the patch, diagnose the changed failure, compare the causal evidence, and only use normal source-control tools to revert when the source/build evidence supports that decision.

## Read the intelligent diagnosis in this order

1. `classification`: crash/stop family and confidence.
2. `faultLocation`: raw debugger stop frame.
3. `projectFrame`: first likely application-controlled frame.
4. `frameSelection`: scored stack-frame evidence and reasons runtime/system frames were skipped.
5. `operandAnalysis`: selected project-frame instruction, operands, registers, and local bindings.
6. `callChain`: project callers, runtime boundary, repeated frames, pointer provenance, root-cause candidate.
7. `rootCauseBacktrack` in autonomous mode: bounded runtime provenance toward producer candidates.
8. `hypotheses`: ranked evidence-based explanations.
9. `fixWorkflow`: candidate location and suggested change direction.
10. `verificationBaseline`: compact failure signature used for verification.
11. `verificationQuality`: strength of debugger evidence after a verification run.

A high project-frame confidence means “very likely project code”, not “proven root cause”. Do not turn a heuristic into certainty.

## Fault frame versus project frame

When the raw crash is inside runtime/system code, keep these two views separate:

- `faultLocation` / `faultCorrelation`: the literal stopped instruction/frame reported by the debugger.
- `projectFrame` / `operandAnalysis`: the first likely application-controlled frame and its instruction context.

`debug_source_disassembly` intentionally returns the raw `faultCorrelation` alongside the selected `projectFrame` and its `operandAnalysis`. Do not assume the project frame is the literal machine instruction that faulted. Check `operandAnalysis.likelyFaultOperand.faultingFrame`.

## Operand → register → variable reasoning

Do not claim “RAX is zero, therefore null dereference” unless the relevant instruction actually uses RAX as a memory operand.

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

Poison/debug values such as `0xFEEEFEEE`, `0xDDDDDDDD`, `0xCDCDCDCD`, `0xCCCCCCCC`, and `0xDEADBEEF` strengthen lifetime/uninitialized-memory hypotheses but are not standalone proof.

## Root-cause backtracking

`rootCauseBacktrack` is runtime provenance, not static dataflow analysis.

Use:

- `target`: suspicious register/local/value/instruction being traced.
- `runtimeTrail`: consumer and matching values visible through bounded caller frames.
- `producerCandidates`: earlier project-controlled frames worth reading in source.
- `confidence`: strength of the runtime trail.
- `limitation`: reminder that exact assignments/returns still need source confirmation.

Prefer the earliest source-confirmed producer or ownership boundary over a defensive guard at the final crash site.

Repeated `0x0` values across frames are intentionally weak provenance because unrelated pointers may independently be null. Distinctive poison values repeated across frames are stronger.

For heap corruption, allocator/runtime failure can occur well after the original invalid write/free. Prefer ASan, PageHeap, allocator diagnostics, or targeted data breakpoints when available.

## Verification quality

`verificationQuality.score` is a 0–100 score for **debugger evidence only**.

It never fabricates external evidence. The following remain `external-unverified` until the coding/build agent actually reports them:

- build success
- project tests
- exact reproduction inputs

A strong debugger score does not replace compilation or tests.

Interpret verification verdicts:

- `fixed`: the complete reproduction reached a clean successful terminal outcome, currently exit code 0.
- `not-fixed`: the same failure signature reproduced.
- `changed-failure`: execution still crashed, but the active signature changed.
- `inconclusive`: not enough evidence to claim success or failure.

Windows source paths are compared canonically for verification, so path separator and drive/path casing differences alone must not create a false `changed-failure`.

A breakpoint, entry stop, pause, step, or configured first-chance exception is not proof of a fix. Finish the original reproduction.

## First-chance/configured exceptions

A DAP exception stop whose exception info indicates an always/configured break can be a first-chance diagnostic stop rather than an unhandled fatal crash. Do not automatically patch from that stop alone. Continue the reproduction or gather stronger fatal evidence.

## Manual diagnose → fix → rebuild → reproduce → verify

Autonomous mode is optional.

Diagnose, preserve the returned baseline, edit with normal coding tools, rebuild with matching symbols, then run:

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

After debugger verification, run the project's normal automated tests too.

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

A dump is frozen postmortem state. Never call live execution/watchpoint operations on it.

Valid inspection includes:

- `debug_snapshot`
- `debug_diagnose_stop`
- `debug_source_disassembly`
- `debug_threads`
- `debug_stack`
- `debug_scopes`
- `debug_variables`
- `debug_modules`
- `debug_disassemble`
- `debug_read_memory`
- `debug_exception_info` when supported

Never use these on a dump:

- `debug_continue`
- `debug_step`
- `debug_pause`
- `debug_data_breakpoint_info`
- `debug_set_data_breakpoints`

Finish dump analysis with `debug_disconnect(terminateDebuggee=false)`.

A stale original dump cannot verify a source fix. Use a rebuilt live reproduction or a newly generated dump.

## Raw/live fallback

Use lower-level tools only for a concrete unanswered question from the high-level diagnosis.

Typical fallback:

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

Use a live data breakpoint instead of repeatedly stepping:

```text
1. debug_snapshot()
2. debug_data_breakpoint_info(name=..., variablesReference=..., frameId=...)
3. debug_set_data_breakpoints([{dataId=..., accessType="write"}])
4. debug_continue(threadId=...)
5. debug_snapshot()
6. identify the write site/value transition
7. debug_set_data_breakpoints(breakpoints=[])
```

## Windows CodeLLDB pause caveat

A requested `debug_pause` on Windows can surface as `DebugBreak` / `0x80000003`. Do not classify that alone as an application crash when it immediately follows a requested pause.

## Completion standard

A strong final result records:

- how state was captured
- raw exception/stop evidence
- raw fault frame
- selected project frame and selection reasons
- operand/register/variable evidence
- caller/provenance/backtrack evidence
- most likely cause and confidence
- source change actually made
- rebuild result
- project test result
- autonomous iteration history or manual verification verdict
- verification quality and its external-unverified fields
- exact clean reproduction evidence when claiming `fixed`

Never call a bug fixed solely because the source looks plausible or execution reached a nonfatal stop.
