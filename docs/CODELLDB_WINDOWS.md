# CodeLLDB on Windows

`qwen-dap-mcp` has a first-class CodeLLDB profile for native C/C++ debugging on Windows.

## Requirements

- Windows 10 or 11 x64
- Node.js 20+
- CodeLLDB 1.11.0 or newer
- A native executable built with debug information

CodeLLDB 1.11.0+ can speak DAP directly over stdin/stdout, which lets this bridge start `codelldb.exe` as a normal local process without opening a TCP listener.

## Installing CodeLLDB

The easiest route is to install the `vadimcn.vscode-lldb` extension in VS Code. The bridge searches these locations automatically:

- `%CODELLDB_PATH%` when set
- `%VSCODE_EXTENSIONS%`
- `%USERPROFILE%\.vscode\extensions`
- `%USERPROFILE%\.vscode-insiders\extensions`
- `%USERPROFILE%\.cursor\extensions`
- `%USERPROFILE%\.windsurf\extensions`
- `%USERPROFILE%\.vscode-oss\extensions`
- `codelldb.exe` on `PATH`

You can also pass an explicit `adapterPath` to `debug_codelldb_info` or `debug_start_codelldb`.

## Recommended Qwen Code workflow

After adding this MCP server to Qwen Code, the preferred v0.4 sequence is:

```text
1. debug_codelldb_info()
2. debug_start_codelldb()
3. debug_launch_codelldb(
     program="C:\\project\\build\\app.exe",
     breakpoints=[
       { source="C:\\project\\src\\main.cpp", lines=[42] }
     ]
   )
4. debug_snapshot(includeModules=true)
5. debug_evaluate(expression="someVariable", frameId=...)
6. configure conditional/function/instruction/data breakpoints if useful
7. debug_continue(threadId=...)
8. debug_snapshot()
9. debug_pause(threadId=...)
10. debug_snapshot()
11. debug_disconnect()
```

`debug_snapshot` is designed for agent use. In one bounded request it collects the current stopped reason, selected thread, stack, top frame, source location, locals, registers, disassembly around the instruction pointer, optional modules, and exception information when the current stop was caused by an exception.

## Advanced source breakpoints

Use `debug_set_source_breakpoints` when a plain line breakpoint is not enough:

```text
debug_set_source_breakpoints(
  source="C:\\project\\src\\main.cpp",
  breakpoints=[
    {
      line=42,
      condition="counter == 35",
      hitCondition=">= 1"
    }
  ]
)
```

The tool also exposes DAP `column` and `logMessage` fields. Adapter capability flags determine which features are available.

## Function and instruction breakpoints

```text
debug_set_function_breakpoints(
  breakpoints=[{ name="main" }]
)

debug_set_instruction_breakpoints(
  breakpoints=[
    { instructionReference="0x7ff612341234" }
  ]
)
```

Passing an empty `breakpoints` array clears that breakpoint class.

## Data breakpoints / hardware watchpoints

Watchpoints use a two-stage standard DAP workflow.

First resolve a data identifier from a visible variable:

```text
info = debug_data_breakpoint_info(
  name="counter",
  variablesReference=<locals scope reference>,
  frameId=<current frame id>
)
```

Then install the watchpoint using the returned `dataId`:

```text
debug_set_data_breakpoints(
  breakpoints=[
    {
      dataId=info.dataId,
      accessType="write"
    }
  ]
)
```

In the real Windows integration test CodeLLDB advertises all three standard access modes:

```text
read
write
readWrite
```

The test starts with local `counter = 35`, installs a write watchpoint, continues through `counter += delta`, and CodeLLDB stops with:

```text
reason: data breakpoint
counter: 42
```

This demonstrates an actual native data breakpoint rather than a simulated event from the mock adapter.

Clear watchpoints with:

```text
debug_set_data_breakpoints(breakpoints=[])
```

## Exception breakpoints

CodeLLDB advertises C++ exception filters such as `cpp_throw` and `cpp_catch` through its DAP initialize capabilities.

Example:

```text
debug_set_exception_breakpoints(
  filters=["cpp_throw"]
)
```

The exact filter names remain adapter-defined.

## Pause behavior on Windows

`debug_pause` sends a normal DAP `pause` request and returns:

```text
requestedAction: pause
response: ...
stopped: <raw DAP stopped body>
```

CodeLLDB/LLDB on Windows currently implements that pause via the operating system's `DebugBreak` mechanism. As a result, the raw stopped event can be:

```text
reason: exception
description: Exception 0x80000003 encountered at address ...
```

That event represents a successful requested pause in this situation, not an unexpected application crash. The bridge deliberately keeps both pieces of information: `requestedAction: "pause"` for agent intent and the untouched raw DAP stop for diagnostic accuracy.

A snapshot taken immediately after the pause can therefore include exception information and a system frame such as `NtDelayExecution` if the program was sleeping when interrupted.

## Lower-level inspection tools

The focused inspection primitives remain available when a snapshot is not enough:

```text
debug_threads()
debug_stack(threadId=...)
debug_scopes(frameId=...)
debug_variables(variablesReference=...)
debug_modules()
debug_disassemble(memoryReference=...)
debug_read_memory(memoryReference=..., count=32)
debug_exception_info(threadId=...)
```

The CodeLLDB launch helper forces `terminal: "console"`. This is intentional: the bridge does not execute DAP `runInTerminal` reverse requests, so debugger-controlled program I/O stays inside the DAP session.

## Attach workflow

For software you are authorized to debug:

```text
1. debug_start_codelldb()
2. debug_attach_codelldb(pid=12345, program="C:\\project\\build\\app.exe")
3. debug_snapshot(includeModules=true)
```

## Native inspection support

The current CodeLLDB profile exposes standard DAP requests for:

- threads and stack frames,
- scopes and variables,
- expression evaluation,
- conditional/hit-count/log source breakpoints,
- function breakpoints,
- instruction breakpoints,
- data breakpoints / hardware watchpoints,
- exception breakpoint filters,
- pause,
- loaded modules,
- disassembly,
- bounded memory reads,
- structured exception information,
- registers through CodeLLDB's standard `Registers` scope.

`debug_read_memory` is read-only and capped at 64 KiB per MCP call. The bridge does not expose a memory-write MCP tool.

## Real integration test

The repository contains `test/fixtures/native-smoke.cpp` and `test/codelldb-real-smoke.ts`.

The Windows GitHub Actions workflow:

1. installs dependencies,
2. compiles the C++ fixture with MSVC debug symbols,
3. downloads the latest CodeLLDB Windows x64 release,
4. starts the real CodeLLDB adapter over stdio,
5. sets and hits a source breakpoint,
6. verifies conditional source, function and instruction breakpoints,
7. validates thread and stack state,
8. reads local variables,
9. evaluates `counter`,
10. resolves and installs a real data breakpoint for `counter`,
11. continues until the watched write changes `counter` from 35 to 42,
12. enumerates loaded modules,
13. disassembles around the current instruction pointer,
14. reads executable memory,
15. captures and validates a combined runtime snapshot,
16. resumes the program,
17. pauses it again through DAP and validates Windows DebugBreak semantics,
18. disconnects.

A representative successful run with CodeLLDB 1.12.3 produced:

```text
local variables:               delta, counter
initial counter:               35
conditional breakpoint:        verified
function breakpoint:           verified
instruction breakpoint:        verified
watchpoint access modes:       read, write, readWrite
watchpoint stop reason:        data breakpoint
counter after watched write:   42
loaded modules:                5
disassembly:                   11 instructions
memory read:                   16 bytes
snapshot registers:            2 entries
requested pause action:        pause
raw Windows pause stop:        exception 0x80000003
```

This verifies the bridge against a real native debugger rather than only the mock DAP adapter.

## Manual smoke test

From an x64 Visual Studio Developer PowerShell / Native Tools prompt:

```powershell
npm install
npm run build
cl /nologo /EHsc /Zi /Od /std:c++17 /Fe:test\fixtures\native-smoke.exe test\fixtures\native-smoke.cpp /link /DEBUG:FULL
npx tsx test/codelldb-real-smoke.ts --program "$PWD\test\fixtures\native-smoke.exe" --source "$PWD\test\fixtures\native-smoke.cpp"
```

If automatic discovery does not find your adapter:

```powershell
$env:CODELLDB_PATH = "$env:USERPROFILE\.vscode\extensions\vadimcn.vscode-lldb-<version>\adapter\codelldb.exe"
```

or pass `--adapter` to the smoke test.
