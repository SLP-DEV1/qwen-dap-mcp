# Hang and deadlock debugging

`debug_this_hang` is the v0.15 high-level workflow for native processes that appear stuck, deadlocked, permanently waiting, or spinning without useful forward progress.

The workflow is deliberately evidence-first. It captures a bounded view of every debugger-visible thread, classifies likely wait states, correlates pointer-like locals across threads, and reports whether the snapshot is consistent with deadlock or another wait pattern. It does **not** claim that a lock cycle is proven unless independent lock-owner evidence exists.

## What the tool collects

For each captured thread, qwen-dap-mcp collects a bounded stack and, by default, locals/arguments from:

1. the top frame, and
2. the first likely project-controlled frame when that is different.

The default bounds are:

- up to 32 threads,
- up to 24 frames per thread,
- up to 50 variables per selected frame scope,
- up to 2 variable-bearing frames per thread.

All bounds are configurable and capped by the input schema.

The resulting `allThreadTriage` records the top function, first project-controlled frame, recognized wait kind, confidence, and collection limitations for each thread.

## Wait-state heuristics

The analyzer recognizes common native wait families such as:

- mutex / critical-section acquisition,
- reader/writer locks,
- futex / low-level lock waits,
- condition variables,
- semaphores,
- operating-system event waits,
- thread joins,
- blocking I/O,
- sleep/timer waits,
- scheduler/worker parking.

A thread with a project-controlled frame and no recognized blocking primitive is treated as potentially runnable user code. This helps distinguish global waits from a process where one project thread may still be responsible for forward progress.

Function-name heuristics vary across platforms and standard libraries, so every result includes explicit limitations.

## Deadlock classifications

The global diagnosis can report:

- `deadlock-candidate` — multiple threads are blocked in strong mutex/rwlock/futex/join waits and no runnable project-controlled thread was identified,
- `lock-contention` — synchronization-related pointers are shared across threads while at least one strong lock wait is present,
- `global-wait` — all captured threads are waiting, but the evidence is not strong enough to call it deadlock,
- `io-wait` — all captured threads are in recognized blocking I/O waits,
- `mixed-wait` — some threads are waiting while others appear runnable/unknown,
- `no-deadlock-signal` — no recognized blocking state was found; investigate busy loops or livelock,
- `unknown` — insufficient evidence.

`deadlock.cycleProven` is intentionally `false` for the generic DAP path. Generic DAP has no portable lock-owner graph, therefore stacks alone cannot prove the wait-for cycle.

Condition-variable, event, semaphore, scheduler, and timer waits are **not** enough by themselves to produce `deadlock-candidate`. Healthy worker pools commonly spend most of their lifetime in those states.

## Pointer-Provenance v2

`pointerProvenance.version` is `2` for hang triage.

Pointer-Provenance v2 uses adapter-exposed locals/arguments and `memoryReference` values to group equal pointer addresses across thread/frame boundaries. Each group reports:

- normalized address,
- thread IDs,
- variable aliases,
- frame/function observations,
- whether the address appears synchronization-related,
- whether it is shared across threads,
- confidence and rationale.

This is intended to surface evidence such as two blocked threads both referring to the same mutex/lock object or the same shared state object.

Equal addresses prove that the captured values alias the same address at that instant. They do **not** prove lock ownership, object lifetime, or causality. The workflow does not perform arbitrary recursive memory dereferences to manufacture an ownership graph.

## Current-session triage

For a process that is already attached/launched through qwen-dap-mcp:

```text
debug_this_hang(
  mode="current",
  analysis={
    projectRoots:["C:\\repo\\app"],
    projectModules:["app.exe"]
  }
)
```

If the last DAP stop explicitly says `allThreadsStopped=true`, the tool captures immediately. If only one thread is known to be stopped, it sends bounded best-effort `pause` requests to the remaining threads before collecting their stacks.

A debugger stop on one thread is never silently treated as proof that every thread is frozen.

## Launch and observe

CodeLLDB example:

```text
debug_this_hang(
  mode="codelldb",
  request="launch",
  program="C:\\build\\app.exe",
  args=["--repro-hang"],
  cwd="C:\\repo\\app",
  observeMs=5000,
  analysis={projectRoots:["C:\\repo\\app"]}
)
```

The workflow arms the outcome listener before launch/attach so a fast stop or process exit cannot race past it.

During `observeMs`:

- `exited` / `terminated` => `suspectedHang=false`, no hang diagnosis,
- debugger `stopped` => collect all-thread evidence but do not claim the stop itself proves a hang,
- no stop/exit/termination => mark the observation timeout as a suspected hang, pause the target, and collect all-thread evidence.

A timeout is useful evidence that the expected terminal/stop event did not happen in the bounded window; it is not mathematical proof that the application made zero forward progress.

## Attach to an existing process

CodeLLDB/lldb-dap/GDB modes accept `request="attach"` with a positive `pid`:

```text
debug_this_hang(
  mode="gdb",
  request="attach",
  pid=12345,
  program="/path/to/app",
  observeMs=3000
)
```

Only attach to processes you are authorized to debug. Attach changes debugger control of the process and the hang workflow may pause it.

## HOL Guard interaction

When HOL Guard integration is enabled, the executable/mutating DAP boundaries used by this workflow remain protected:

- adapter process start,
- `launch`,
- `attach`,
- `pause`.

Read-only evidence collection (`threads`, `stackTrace`, `scopes`, `variables`) stays on the read-only fast path.

This means `debug_this_hang` does not bypass the policy work added in v0.14; it composes through the same guarded DAP session.

## Deterministic Hang Lab

The repository includes a native two-lock deadlock fixture:

```bash
npm run demo:hang:build -- deadlock
npm run demo:hang:repro -- deadlock
```

The fixture uses two threads that each acquire one mutex, synchronize through an atomic barrier, and then attempt to acquire the other mutex. The repro is considered successful only when the process remains blocked until the bounded timeout.

CI builds and reproduces this fixture on the Node 22 job in addition to the existing Crash Lab smoke.

## Reading the result safely

Use this order before making a concurrency/root-cause claim:

1. `observation` — why the capture happened and whether the tool itself established only a timeout or an earlier debugger stop,
2. `allThreadTriage` — which threads are blocked versus apparently runnable,
3. `deadlock` — global classification, evidence, and explicit limitations,
4. `pointerProvenance` — cross-thread pointer aliases that may connect the wait states,
5. `nextActions` — the narrowest evidence needed to confirm ownership or investigate forward progress.

Do not convert `deadlock-candidate` into “deadlock proven” in downstream agent text unless separate adapter-specific ownership evidence actually closes the wait-for cycle.
