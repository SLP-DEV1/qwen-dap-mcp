# Differential and causal debugging

v0.17 adds a bounded workflow for comparing a known-good runtime state with a failing or changed runtime state, then following a suspicious value through real writer stops.

## Workflow

Prepare two independent DAP sessions and drive both targets to comparable stopped states:

```text
debug_sessions(action="create", sessionId="baseline")
debug_sessions(action="create", sessionId="candidate")
```

Use the normal lifecycle/high-level tools with the matching `sessionId` to reproduce the known-good and failing cases. The two stops should represent the same logical phase of execution whenever possible.

Then compare them:

```text
debug_compare_runs(
  baselineSessionId="baseline",
  candidateSessionId="candidate",
  timeoutMs=30000,
  snapshot={
    stackLevels:20,
    maxVariablesPerScope:100,
    includeModules:true,
    includeExceptionInfo:true
  }
)
```

`debug_compare_runs` is read-only. It does not launch, continue, pause, or mutate either target.

Read the result in this order:

1. `diff.firstMeaningfulDifference` - first prioritized semantic difference, not proof of causality.
2. `diff.locals` - local/argument value changes.
3. `diff.exception` - exception-state differences.
4. `diff.stack` - frame identity/call-path differences.
5. `diff.registers` - register differences after higher-level evidence.
6. `diff.symbolHealth` and `diff.modules` - symbol/module drift that can invalidate comparisons.
7. `evidenceBudget` - the actual bounded capture limits used for both sessions.
8. `diff.limitations` - explicit interpretation limits.

## Address normalization

Raw pointer addresses often differ between independent processes because of ASLR, allocator layout, stack layout, or timing. v0.17 therefore treats a non-null address-only difference as `unstable` rather than promoting it to causal evidence.

A nullability transition is different: valid/non-null versus null/`nullptr` is a semantic state change and is reported as meaningful evidence.

The same principle applies to the result as a whole: `firstMeaningfulDifference` is a prioritization hint. It does not prove that the first changed value caused the failure.

## Trace a suspicious value

If the comparison identifies a debugger-visible variable/register worth following and it is safe to resume the live candidate target, use:

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

`debug_trace_value` repeatedly uses a temporary DAP data breakpoint or the bounded GDB watchpoint fallback, resumes to the next writer, captures the actual stopped thread/frame, removes only its own temporary watch, and builds a bounded temporal timeline.

Interpret each event as an observed writer candidate. A writer stop is stronger temporal evidence than a static value difference, but it still does not prove root cause by itself. Confirm the assignment/ownership semantics in source.

The trace stops conservatively on unrelated debugger stops instead of silently continuing through exceptions, breakpoints, or other control events. It also stops on target exit/termination, missing writer snapshots, aggregate deadline exhaustion, or the configured stop budget.

Use `debug_find_writer` when one immediate writer is enough. Use `debug_trace_value` when the sequence of writes matters.

## Cancellation and stale-response isolation

v0.17 introduces a request-local DAP operation context with an aggregate deadline and `AbortSignal`. Nested DAP requests and event waiters inherit that deadline. When the operation is cancelled, pending request authority is removed immediately; a later adapter response is treated as orphaned and cannot complete the cancelled workflow.

DAP transports also carry a generation. Replacing/stopping an adapter retires the old generation so late output/errors/responses from an old child process cannot contaminate the current debugger session.

These controls bound evidence work and prevent timed-out differential/trace workflows from leaking asynchronous state into later MCP requests.

## Safety

`debug_compare_runs` is inspection-only.

`debug_trace_value` changes target execution state because it installs a temporary watch/data breakpoint and resumes execution. Only use it on authorized live targets that are safe to resume. It is invalid for frozen crash dumps/core files. Built-in DAP policy and optional HOL Guard enforcement continue to apply to its protected operations.

## Real regression coverage

The dedicated Differential Runtime Linux workflow starts two independent real GNU GDB DAP processes against the same native fixture, stops them at the same observation function through distinct known-good/failing caller paths, and invokes the actual `debug_compare_runs` MCP handler over the multi-session registry. Unit coverage separately locks down nullability semantics, ASLR/address instability handling, path canonicalization, operation cancellation, generation isolation, and value-trace behavior.
