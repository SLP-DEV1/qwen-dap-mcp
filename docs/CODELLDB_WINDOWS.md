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

After adding this MCP server to Qwen Code, the preferred v0.3 sequence is:

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
6. debug_step(action="next", threadId=...)
7. debug_snapshot()
8. debug_continue(threadId=...)
9. debug_disconnect()
```

`debug_snapshot` is designed for agent use. In one bounded request it collects the current stopped reason, selected thread, stack, top frame, source location, locals, registers, disassembly around the instruction pointer, optional modules, and exception information when the current stop was caused by an exception.

The lower-level tools remain useful for focused follow-up inspection:

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
6. validates thread and stack state,
7. reads local variables,
8. evaluates `counter`,
9. enumerates loaded modules,
10. disassembles around the current instruction pointer,
11. reads executable memory,
12. captures and validates a combined runtime snapshot,
13. resumes and disconnects.

A representative successful run with CodeLLDB 1.12.3 produced:

```text
local variables:    delta, counter
counter:            35
loaded modules:     5
disassembly:        11 instructions
memory read:        16 bytes
snapshot registers: 2 entries
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
