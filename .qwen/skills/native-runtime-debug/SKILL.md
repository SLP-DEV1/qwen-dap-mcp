---
name: native-runtime-debug
description: Diagnose native C/C++ runtime bugs and crash dumps with qwen-dap-mcp and DAP. Use for crashes, minidumps/core dumps, bad runtime state, unexpected variable changes, breakpoint-driven investigation, and verifying native fixes with CodeLLDB or another authorized local DAP target.
---

# Native Runtime Debugging

Use `qwen-dap-mcp` to reason from structured debugger evidence rather than guessing from logs. This skill is for software, crash artifacts, and authorized local targets the user owns or is permitted to debug.

## Prefer the v0.8 high-level tools

For crash-oriented tasks, start with the highest-level tool that matches the available evidence:

1. **Known local native executable, reproduce under CodeLLDB**
   - Use `debug_this_crash(mode="codelldb", program=..., args=[...], breakpoints=[...])`.
   - This discovers/starts CodeLLDB, launches the program, waits race-safely for stop/exit, captures a bounded snapshot, and returns a structured diagnosis in one call.
2. **Existing minidump/core file**
   - Use `debug_this_crash(mode="dump", dumpPath=..., program=..., sourceMap=...)`.
   - This opens the dump as frozen postmortem state and immediately analyzes the recovered stop.
3. **Already stopped live or postmortem session**
   - Use `debug_diagnose_stop()` for crash classification, exception evidence, suspicious values, ranked hypotheses, source/disassembly correlation, and suggested checks.
4. **Need only machine-code/source correlation**
   - Use `debug_source_disassembly()` to correlate the top source frame and instruction pointer with the current/nearest instruction and nearby instructions.
5. **Already initialized generic DAP adapter**
   - Use `debug_this_crash(mode="live", request="launch"|"attach", configuration=...)` or `debug_run_to_stop(...)`.

Use lower-level tools when the high-level report identifies a concrete follow-up question, not by default.

## How to interpret the diagnosis

The diagnosis engine is evidence-bounded. Treat these fields differently:

- `classification`: best current crash/stop family from debugger evidence.
- `confidence`: strength of that classification or hypothesis, not proof.
- `hypotheses`: likely explanations ranked from the available exception, frame, locals/registers, and instruction context.
- `suspiciousValues`: clues such as null-like pointers or common debug-allocator poison patterns. A clue is not automatically the root cause.
- `sourceDisassembly`: source line + instruction pointer + current/nearest machine instruction and surrounding instructions.
- `nextActions`: debugger checks that can strengthen or falsify the current hypothesis.

Never convert a heuristic into a confirmed root-cause statement without matching evidence. Prefer wording such as “consistent with”, “strong candidate”, or “the debugger shows” until the faulting operation/data flow is established.

Common classifications include access violation, segmentation fault, stack overflow, divide-by-zero, illegal instruction, abort/assert, heap corruption, generic exception/signal, and non-crash stops such as breakpoint/entry/pause/step.

## Core operating rules

1. Debug only user-owned or otherwise authorized local targets and crash artifacts.
2. Prefer launch over attach when the program can be started under the debugger.
3. Keep reads bounded. Do not recursively dump huge variable trees or memory ranges without a specific diagnostic reason.
4. Preserve raw evidence in the final explanation: stop reason, exception id/description, top relevant frame, source line, suspicious value/register, and relevant instruction when available.
5. Do not assume the top system/runtime frame is the original cause. Walk to the first project-controlled frame when needed.
6. Treat DAP capability flags as authoritative.
7. The bridge intentionally does not expose arbitrary memory writes.
8. After changing source, rebuild and reproduce the same scenario before claiming a fix is verified.
9. A historical dump can establish what happened in that captured state, but cannot prove a new source change fixed it.

## Live CodeLLDB: low-level fallback

If `debug_this_crash(mode="codelldb")` is not appropriate, use the explicit flow:

```text
1. debug_codelldb_info()
2. debug_start_codelldb()
3. optional debug_set_exception_breakpoints(...)
4. debug_launch_codelldb(program=..., breakpoints=[...])
5. debug_snapshot(includeModules=true, includeExceptionInfo=true)
6. debug_diagnose_stop()
7. targeted follow-up tool only when needed
8. patch source
9. rebuild and reproduce
10. debug_disconnect()
```

`debug_snapshot` remains the preferred raw bounded stop-state primitive. It can include thread, stack, top frame, source, locals/arguments, registers, disassembly, modules, and structured exception information.

## Postmortem crash dumps

For raw dump inspection, `debug_open_dump(dumpPath=..., program=..., sourceMap=...)` remains available. Prefer `debug_this_crash(mode="dump", ...)` when the user wants the likely cause rather than only raw recovered state.

A dump session is frozen/read-only. Never use these live operations in postmortem mode:

- `debug_continue`
- `debug_step`
- `debug_pause`
- `debug_data_breakpoint_info`
- `debug_set_data_breakpoints`

Inspection remains valid with `debug_snapshot`, `debug_diagnose_stop`, `debug_source_disassembly`, `debug_threads`, `debug_stack`, `debug_scopes`, `debug_variables`, `debug_modules`, `debug_disassemble`, `debug_read_memory`, and `debug_exception_info` when the adapter can recover it.

Finish dump analysis with `debug_disconnect(terminateDebuggee=false)`.

## Source ↔ disassembly reasoning

When source alone does not explain the failure, use `debug_source_disassembly()` before issuing broad memory reads.

Reason in this order:

1. identify the selected top/project frame and source line,
2. read `instructionPointerReference`,
3. inspect `currentInstruction` when the address matches exactly,
4. if symbols/instruction boundaries do not line up exactly, note that the tool selected the nearest instruction,
5. use previous/next instructions to understand the immediate machine-code context,
6. map instruction operands back to relevant locals/registers before claiming a dereference, bad jump, or arithmetic fault.

Do not claim that a zero-valued register proves a null dereference unless the faulting instruction actually uses that register/address.

## Exception and memory-lifetime analysis

For exception stops, keep the adapter-provided exception id, description, details, and break mode in the evidence chain. For access violations/SIGSEGV-like faults:

- a null pointer local/argument near the fault is strong evidence only when source/disassembly shows it participates in the failing access,
- poison patterns such as `0xFEEEFEEE`, `0xDDDDDDDD`, `0xCDCDCDCD`, `0xCCCCCCCC`, or `0xDEADBEEF` are clues for freed/uninitialized/diagnostic memory, not standalone proof,
- an invalid non-null address can still come from bounds errors, lifetime bugs, corrupted control flow, races, or mismatched binaries/symbols.

For stack overflow, inspect repeating frame patterns and recursion termination. For divide-by-zero, identify the actual divisor. For illegal instruction, inspect the control-flow target and binary/symbol match. For abort/assert, walk past runtime abort helpers to the first project frame and locate the violated invariant.

## Windows CodeLLDB pause caveat

A user-requested `debug_pause` on Windows can be implemented using `DebugBreak`, producing an exception-like `0x80000003` stop. When the stop follows a requested pause, do not classify that breakpoint exception as an application crash by itself.

This caveat does not apply to an independently produced crash dump: its captured exception context comes from the crashed process.

## Targeted follow-up tools

### Unexpected variable write

Use a live data breakpoint instead of repeatedly stepping:

```text
1. debug_snapshot()
2. debug_data_breakpoint_info(name=..., variablesReference=..., frameId=...)
3. debug_set_data_breakpoints([{dataId=..., accessType="write"}])
4. debug_continue(threadId=...)
5. debug_snapshot()
6. identify the write site and value transition
7. clear with debug_set_data_breakpoints(breakpoints=[])
```

Never use watchpoints on a postmortem dump.

### Known suspicious function

Use `debug_set_function_breakpoints` and continue to the smallest relevant stop. Remove it after the evidence is collected.

### Conditional source stop

Use `debug_set_source_breakpoints` for `condition`, `hitCondition`, `logMessage`, or `column` instead of encoding complex polling logic in the agent.

### Exact instruction stop

Use `debug_set_instruction_breakpoints` only in a live session and only after an instruction reference/address has been established.

### Specific expression

Use `debug_evaluate` for a narrow expression in an authorized live target. Remember that debugger expression evaluation may have side effects depending on language/debugger.

### Bounded memory

Use `debug_read_memory` only when variables, exception details, and source/disassembly do not already answer the question.

## Root-cause claim standard

A strong final diagnosis should state:

- how the state was captured (live stop or dump),
- the debugger stop/exception evidence,
- the first relevant project frame and source line,
- the variable/register/instruction evidence tied to the failing operation,
- the most likely cause and its confidence,
- what alternative explanation remains if confidence is not high,
- what was done to verify the fix.

Example of appropriately bounded wording:

```text
The dump shows EXCEPTION_ACCESS_VIOLATION in `crash_here` at native-dump.cpp:43. The pointer argument is null and the current instruction dereferences the register carrying that pointer, so a null dereference is the strongest explanation for this captured crash.
```

Avoid unsupported wording such as “definitely heap corruption” when only a crash address is known.

## Fix and verify

When source changes are appropriate:

1. apply the smallest fix that addresses the demonstrated cause,
2. rebuild with matching debug information,
3. start a fresh live debugger session,
4. reproduce the same input/action,
5. confirm the original crash/stop or bad value no longer occurs,
6. capture a final `debug_snapshot` or `debug_diagnose_stop` when useful,
7. run the project’s normal tests too.

For dump-only investigations, verify using a rebuilt live reproduction or a newly generated dump. Do not mark the bug fixed because an old dump can still be explained.
