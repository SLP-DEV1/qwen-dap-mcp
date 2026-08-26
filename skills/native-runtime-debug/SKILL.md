---
name: native-runtime-debug
description: Diagnose native C/C++ crashes, hangs/deadlocks, bad runtime state, and crash dumps with qwen-dap-mcp and DAP. Use for crashes, minidumps/core dumps, processes that stop making progress, lock/wait triage, unexpected variable changes, differential good-versus-bad runtime comparison, bounded value/write tracing, breakpoint-driven investigation, and verifying native fixes with CodeLLDB or another authorized local DAP target.
---

# Native Runtime Debugging

Use `qwen-dap-mcp` to reason from structured debugger evidence instead of guessing from logs. This skill is for software, crash artifacts, and authorized local targets the user owns or is permitted to debug.

## Choose the high-level workflow first

Use `debug_this_crash` for fatal exceptions/signals, invalid memory accesses, aborts, and crash verification. Use `debug_this_hang` when the process appears stuck, deadlocked, waiting forever, or spinning without useful forward progress.

When a known-good reproduction and a failing/changed reproduction can be stopped at comparable runtime states, use `debug_compare_runs` before guessing from source. If that comparison identifies a suspicious debugger-visible value and the live target is safe to resume, use `debug_trace_value` to gather bounded temporal writer evidence.

Do not use a crash-only interpretation for a hang snapshot and do not turn a hang heuristic, static runtime difference, or observed writer into certainty.

## Differential and causal debugging

For a known-good versus failing comparison, keep the two runs in different DAP sessions:

```text
debug_sessions(action="create", sessionId="baseline")
debug_sessions(action="create", sessionId="candidate")
```

Drive each session to the same logical phase using the normal lifecycle or high-level tools, then compare the stopped states:

```text
debug_compare_runs(
  baselineSessionId="baseline",
  candidateSessionId="candidate",
  timeoutMs=30000,
  snapshot={stackLevels:20, maxVariablesPerScope:100, includeModules:true}
)
```

`debug_compare_runs` is read-only. Read its result in this order:

1. `diff.firstMeaningfulDifference`: prioritized semantic difference, not proof of causality.
2. `diff.locals`: local/argument value changes.
3. `diff.exception`: exception-state differences.
4. `diff.stack`: changed call path/frame identity.
5. `diff.registers`: lower-level register differences.
6. `diff.symbolHealth` and `diff.modules`: comparison-quality drift.
7. `evidenceBudget`: actual bounded capture limits used for both sessions.
8. `diff.limitations`: explicit interpretation limits.

Raw non-null pointer addresses frequently differ across independent processes because of ASLR, allocation, stack layout, or timing. qwen-dap-mcp therefore marks non-null address-only changes as `unstable` instead of promoting them to causal evidence. A null/non-null transition is a semantic state change and is meaningful evidence.

If a suspicious value needs temporal evidence, trace it in the live candidate session:

```text
debug_trace_value(
  sessionId="candidate",
  name="critical_ptr",
  accessType="write",
  maxStops=8,
  timeoutMs=60000,
  perStopTimeoutMs=15000
)
```

`debug_trace_value` repeatedly installs one temporary data breakpoint/watchpoint, resumes to the next confirmed writer, captures the actual stopped thread/frame and before/after visible value when available, removes only its own temporary watch, and repeats within an aggregate deadline. It stops on unrelated debugger events rather than silently continuing through them.

Use `debug_find_writer` when one immediate writer is enough. Use `debug_trace_value` when the sequence of writes matters.

A confirmed writer is temporal evidence, not automatic root-cause proof. Confirm assignment, lifetime, and ownership semantics in source. `debug_trace_value` changes execution state and must not be used for frozen dumps or targets that are unsafe to resume. Built-in DAP policy and optional HOL Guard enforcement still apply.

The v0.17 operation context propagates aggregate deadlines/cancellation into nested DAP requests and event waits. Cancelled pending requests lose authority immediately, and transport-generation isolation prevents late responses/output from a retired adapter from contaminating a later workflow.

See `docs/differential-debugging.md` in the project for the complete evidence model and real GDB regression coverage.

## Prefer `debug_this_hang` for hangs and deadlocks

For a suspected hang in an already configured session:

```text
debug_this_hang(
  mode="current",
  analysis={projectRoots:[...], projectModules:[...]}
)
```

For a bounded live reproduction:

```text
debug_this_hang(
  mode="codelldb",
  request="launch",
  program=...,
  args=[...],
  cwd=...,
  observeMs=5000,
  analysis={projectRoots:[...]}
)
```

Read the result in this order:

1. `observation`: why the capture happened. A timeout establishes only that no stop/exit/termination happened in the bounded window; it is not proof of zero forward progress.
2. `allThreadTriage`: every bounded debugger-visible thread, its top/project frame, and recognized wait state.
3. `deadlock`: global wait/deadlock classification plus limitations.
4. `pointerProvenance`: Pointer-Provenance v2 cross-thread aliases and synchronization-related addresses.
5. `nextActions`: the narrowest evidence needed to confirm ownership or investigate forward progress.

Important interpretation rules:

- `deadlock-candidate` means the capture is **consistent with deadlock**, not that a wait-for cycle is proven.
- Generic DAP has no portable lock-owner graph. Respect `cycleProven=false` / `ownershipGraphAvailable=false` unless separate adapter-specific evidence closes the ownership edges.
- Condition-variable, semaphore, event, scheduler, and timer waits are common in healthy worker pools and are not enough by themselves to call deadlock.
- Equal pointer addresses across threads are correlation/alias evidence. They do not prove ownership, object lifetime, or causality.
- A single-thread `stopped` event is not automatically an all-thread freeze. `debug_this_hang` attempts bounded pauses of remaining threads before triage when the adapter did not report `allThreadsStopped=true`.
- If no blocking primitive is recognized and a project-controlled thread appears runnable, investigate busy-loop/livelock behavior rather than forcing a deadlock diagnosis.

Launch/attach/pause can change the target's execution state. Use executable/attach modes only for authorized targets. When HOL Guard is enabled, these boundaries remain policy-gated; read-only thread/stack/scope/variable collection stays on the inspection fast path.

## Prefer `debug_this_crash` for crashes

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

- `protocolVersion`: action protocol version.
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

## Continue an autonomous crash cycle

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

Do **not** automatically revert a patch just because verification reports `changed-failure`. A changed crash can mean either a regression or that the original fix exposed a downstream defect. Preserve the patch, diagnose the changed failure, compare the causal evidence, and only use normal source-control tools to revert when the source/build evidence supports that decision.

## Read the intelligent crash diagnosis in this order

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

Autonomous crash mode is optional.

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
- `debug_trace_value`

Finish dump analysis with `debug_disconnect(terminateDebuggee=false)`.

A stale original dump cannot verify a source fix. Use a rebuilt live reproduction or a newly generated dump.

A frozen dump/core can also be fed to `debug_this_hang(mode="current")` only after the dump has already been opened in the shared session. Treat that as wait-state inspection, not proof that the original live process was hung.

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

Use `debug_find_writer` when one immediate writer is enough. Use `debug_trace_value` when repeated live writes must be observed as a bounded sequence. For the full manual surface:

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

A requested `debug_pause` on Windows can surface as `DebugBreak` / `0x80000003`. Do not classify that alone as an application crash when it immediately follows a requested pause. The same applies to a pause initiated by `debug_this_hang`: the pause exists to freeze evidence, not to manufacture a crash classification.

## Completion standard

For differential/causal debugging, record:

- baseline and candidate session/reproduction identities,
- whether the two stops represent a comparable logical execution phase,
- `evidenceBudget` used for each comparison,
- the first meaningful semantic difference and relevant alternate differences,
- which raw address differences were deliberately classified `unstable`,
- any nullability/state transition used as stronger evidence,
- the bounded `debug_trace_value` writer timeline when temporal evidence was needed,
- unrelated/terminal stop reason and operation deadline/budget,
- source-confirmed producer/ownership semantics before calling a writer causal.

For a crash, a strong final result records:

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

For a hang, record:

- how the suspected hang was established or observed,
- whether all-thread stop was confirmed or only best-effort,
- all-thread wait/runnable classification,
- deadlock classification and its explicit limitations,
- Pointer-Provenance v2 cross-thread aliases used as evidence,
- any independent lock-owner/ownership evidence,
- source change and reproduction result if a fix is attempted.

Never call a crash fixed solely because the source looks plausible or execution reached a nonfatal stop, never call a deadlock proven solely from generic stack wait heuristics, and never call a differential value or observed writer the root cause without source/temporal evidence that supports the causal link.
