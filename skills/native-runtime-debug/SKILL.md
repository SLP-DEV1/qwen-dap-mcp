---
name: native-runtime-debug
description: Diagnose native C/C++ runtime bugs and crash dumps with qwen-dap-mcp and DAP. Use for crashes, minidumps/core dumps, bad runtime state, unexpected variable changes, breakpoint-driven investigation, and verifying native fixes with CodeLLDB or another authorized local DAP target.
---

# Native Runtime Debugging

Use the `qwen-dap-mcp` MCP tools to diagnose runtime behavior from structured debugger state instead of guessing from logs alone.

This skill is for software, crash artifacts, and local processes the user owns or is authorized to debug.

## Prerequisites

- The `qwen-dap-mcp` MCP server is configured and visible in `/mcp`.
- For the built-in Windows C/C++ path, CodeLLDB 1.11.0+ is installed or `CODELLDB_PATH` points to `codelldb.exe`.
- The target should be built with debug information when source-level diagnosis is required.
- For postmortem analysis, keep the matching executable and symbols next to the dump when possible.

Prefer `debug_start_codelldb` / `debug_launch_codelldb` for Windows native C/C++ projects. Use `debug_open_dump` for an existing native crash dump. Use the generic `debug_start`, `debug_launch`, and `debug_attach` tools only when another DAP adapter is intentionally configured.

## Operating rules

1. Debug only user-owned or otherwise authorized local targets and crash artifacts.
2. Prefer launch over attach when the project can be started under the debugger.
3. Keep debugger operations narrow. Do not dump large variable trees or memory ranges without a concrete reason.
4. Use `debug_snapshot` as the default stop-state inspection tool before issuing many lower-level calls.
5. Treat adapter capability flags as authoritative. Do not assume a breakpoint or memory feature exists when the adapter does not advertise it.
6. Preserve raw debugger evidence in the diagnosis: stop reason or dump context, frame, source line, relevant locals, and the debugger operation that produced the evidence.
7. After changing source code, rebuild and reproduce the same scenario before claiming the bug is fixed.
8. The bridge intentionally does not expose memory writes. Do not work around that restriction with debugger expression side effects unless the user explicitly needs expression evaluation for their own authorized target.
9. A crash dump is frozen state. Never use continue, step, pause, or watchpoint workflows on a postmortem dump session.

## Phase 1: Establish the debug session

For CodeLLDB live debugging:

1. Call `debug_codelldb_info` if adapter discovery has not been verified yet.
2. Call `debug_start_codelldb`.
3. Inspect returned capabilities. Note support for modules, disassembly, memory reads, conditional/function/instruction/data breakpoints, and exception information.

Then choose one live path:

### Launch

Use `debug_launch_codelldb` with the executable and a small number of source breakpoints close to the suspected failure.

If the failure location is not known, prefer one of these strategies:

- break at the start of the suspected subsystem or function,
- configure an exception breakpoint,
- launch normally and use `debug_pause` when the bad runtime state becomes observable.

### Attach

Use `debug_attach_codelldb` only for an authorized local process when launch-under-debugger is not suitable.

After launch/attach, wait for a real stopped state before requesting stack/scopes/variables.

### Postmortem crash dump

Use `debug_open_dump` when a `.dmp`, core file, or other LLDB-supported crash artifact already exists.

Recommended arguments:

- `dumpPath`: required crash artifact.
- `program`: matching executable when available; this improves symbol and module resolution.
- `sourceMap`: map build-machine source paths to the current checkout when sources moved.
- `adapterPath`: only when normal CodeLLDB discovery is insufficient.

`debug_open_dump` starts CodeLLDB, opens the dump through LLDB's core-file target flow, attaches no live process, and immediately returns a bounded snapshot with modules enabled.

Treat the returned session as read-only postmortem state:

- inspect threads, stacks, scopes, locals, registers, modules, memory, and disassembly,
- use `debug_snapshot` for additional bounded views,
- do not call `debug_continue`, `debug_step`, `debug_pause`, or data-breakpoint tools,
- use `debug_disconnect(terminateDebuggee=false)` when finished.

## Phase 2: Capture the first useful state

At the first relevant live stop, call:

```text
debug_snapshot(includeModules=true)
```

For a dump, the initial snapshot is already returned by `debug_open_dump`; call `debug_snapshot` again only when another thread or a different bound is needed.

Read the result in this order:

1. stop/dump context and selected thread
2. top frame and source location
3. stack frames leading to the failure
4. locals / arguments
5. registers when exposed
6. disassembly around the instruction pointer
7. loaded module for the active frame
8. exception information when the adapter exposes it

Do not immediately assume the top frame is the root cause. Follow the call stack and data flow back to the first frame controlled by the project when the failure is inside a runtime or system library.

For dumps, remember that missing locals or symbols can be an artifact-quality problem. Distinguish "not present in the dump/symbols" from "the value did not exist".

## Phase 3: Choose the smallest diagnostic action

### Suspected bad branch or value

For a live session, use `debug_evaluate` for a specific expression and `debug_step` to cross the relevant statement. Capture another `debug_snapshot` after the step.

Compare before/after state and identify the exact source operation that changes behavior.

For a dump, do not step. Inspect the frozen expression/local/register state only.

### Variable changes unexpectedly

Use a data breakpoint/watchpoint rather than repeatedly stepping in a live session:

1. Get the current frame and Locals scope from `debug_snapshot` or `debug_scopes`.
2. Call `debug_data_breakpoint_info` with the variable name, its scope `variablesReference`, and the current `frameId`.
3. If a `dataId` is returned, call `debug_set_data_breakpoints` with the narrowest useful access type, usually `write`.
4. Remove unrelated source/function/instruction breakpoints if they would stop first.
5. Continue with `debug_continue`.
6. At the data-breakpoint stop, call `debug_snapshot` and identify the write site and new value.

Pass `breakpoints=[]` to `debug_set_data_breakpoints` when the watchpoint is no longer needed.

Do not attempt this flow for a crash dump.

### Known function is suspicious

Use `debug_set_function_breakpoints` to stop when the function is entered. Prefer a condition only when it materially reduces irrelevant stops.

Clear function breakpoints with an empty array after reaching the relevant state.

### Exact machine instruction is suspicious

Use the `instructionPointerReference` from a frame or an address obtained from `debug_disassemble`, then use `debug_set_instruction_breakpoints` for live debugging.

For a dump, use the instruction pointer only for disassembly/memory inspection; it cannot be resumed.

### Need a conditional source breakpoint

Use `debug_set_source_breakpoints` rather than the simple line-only tool. Available fields include:

- `condition`
- `hitCondition`
- `logMessage`
- `column`

Use conditions to reduce noise, not to encode large debugger expressions.

### C++ exception path

Inspect `exceptionBreakpointFilters` from adapter capabilities and configure only the useful filter with `debug_set_exception_breakpoints` for live debugging.

For CodeLLDB, filters commonly include `cpp_throw` and `cpp_catch`.

At the exception stop, use `debug_snapshot(includeExceptionInfo=true)` and inspect both the exception information and the first project-controlled frame in the stack.

For a dump, rely on the captured thread/frame/register state and any exception metadata the adapter can recover from the artifact.

### Need to inspect code around RIP/IP

Use `debug_disassemble` with the current frame's `instructionPointerReference`. Keep the instruction count small enough to preserve context quality.

Use `debug_read_memory` only for a specific bounded memory range that is relevant to the diagnosis. Prefer typed variables and expressions when they already expose the needed value.

## Phase 4: Interpret Windows CodeLLDB pause correctly

A user-requested `debug_pause` on Windows may be implemented by CodeLLDB/LLDB using `DebugBreak`.

The result can therefore contain:

```text
requestedAction: pause
stopped.reason: exception
stopped.description: Exception 0x80000003 ...
```

When `requestedAction` is `pause`, do not classify that raw `0x80000003` stop as an application crash by itself. Preserve the raw event, but interpret it as the debugger's pause mechanism unless other evidence shows an independent crash.

The top frame may be a Windows wait/sleep function such as `NtDelayExecution`. Walk the stack to the relevant project frame if needed.

This pause rule does not apply to an independently produced crash dump: a dump's captured exception context is evidence from the crashed process, not a pause request issued by this bridge.

## Phase 5: Form a root-cause claim

A strong diagnosis should contain all of the following:

- the exact reproducible action or dump artifact,
- the debugger stop reason or postmortem crash context,
- the project frame/source line where the problematic state becomes visible,
- the relevant variable/register/memory evidence,
- the call-stack relationship to the failure,
- why the evidence supports the proposed root cause rather than merely correlating with it.

Prefer a narrow live-debugging claim such as:

```text
`counter` changes from 35 to 42 at main.cpp:8. A write data breakpoint stops on that instruction, so this statement is the first observed write that produces the unexpected value.
```

Prefer a narrow dump claim such as:

```text
The minidump resolves the crashing thread to `crash_here` in native-dump.cpp. The top project frame has an instruction pointer inside that function and the pointer argument is null, so the access violation is consistent with a null dereference at the captured instruction.
```

Avoid unsupported statements such as "this must be a memory corruption bug" when the debugger evidence does not establish that.

## Phase 6: Fix and verify

When source changes are appropriate:

1. Apply the smallest code fix that addresses the demonstrated cause.
2. Rebuild the target with the same debug configuration.
3. For live debugging, start a fresh debugger session rather than relying on stale module/symbol state.
4. Recreate the same breakpoints/watchpoints or exception filters when relevant.
5. Reproduce the original scenario.
6. Confirm the bad stop/value or crash no longer occurs.
7. Capture a final `debug_snapshot` at the corresponding live state when useful.
8. Run the project's normal tests in addition to debugger verification.

For a dump-only investigation, verification requires reproducing the original crash scenario with the rebuilt binary or analyzing a newly generated dump. An old dump cannot prove that a source fix worked.

Do not mark the issue fixed solely because the program survived one run.

## Cleanup

Before finishing:

- clear temporary data/function/instruction/source breakpoints when useful,
- call `debug_disconnect`; use `terminateDebuggee=false` for dump sessions,
- summarize the debugger evidence and verification performed.

## Compact live crash-diagnosis sequence

For a native crash with a known executable and no known line:

```text
1. debug_start_codelldb()
2. debug_set_exception_breakpoints(filters=[...]) when appropriate
3. debug_launch_codelldb(program=...)
4. wait for the relevant stop
5. debug_snapshot(includeModules=true, includeExceptionInfo=true)
6. inspect project frames and relevant locals
7. debug_disassemble(...) only when source-level evidence is insufficient
8. patch source
9. rebuild
10. restart debugger and reproduce
11. debug_snapshot(...)
12. debug_disconnect()
```

## Compact crash-dump sequence

```text
1. debug_open_dump(dumpPath=..., program=..., sourceMap=...)
2. inspect the returned thread, stack, top project frame, registers and modules
3. debug_snapshot(threadId=..., includeModules=true) if another thread needs inspection
4. debug_disassemble(...) around the captured instruction pointer when useful
5. debug_read_memory(...) only for a narrow address range needed by the diagnosis
6. form an evidence-bounded root-cause claim
7. patch source
8. rebuild and reproduce the scenario to verify; generate a new dump if it still crashes
9. debug_disconnect(terminateDebuggee=false)
```

## Compact unexpected-write sequence

```text
1. stop where the variable is in scope
2. debug_snapshot()
3. debug_data_breakpoint_info(name=..., variablesReference=..., frameId=...)
4. debug_set_data_breakpoints([{dataId=..., accessType="write"}])
5. debug_continue(threadId=...)
6. debug_snapshot()
7. identify the write site and new value
8. clear the data breakpoint
```
