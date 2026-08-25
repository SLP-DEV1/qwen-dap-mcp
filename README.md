# qwen-dap-mcp

A small, debugger-agnostic **Debug Adapter Protocol (DAP) → Model Context Protocol (MCP)** bridge for agentic runtime debugging.

The project explores whether coding agents can consume structured runtime-debugging state through an existing MCP extension surface instead of requiring a debugger protocol implementation in every agent core.

This project is inspired by the discussion around [QwenLM/qwen-code#10051](https://github.com/QwenLM/qwen-code/issues/10051).

## Architecture

```text
Qwen Code (or another MCP client)
          │
          │ MCP over stdio
          ▼
     qwen-dap-mcp
          │
          │ Debug Adapter Protocol
          ▼
  DAP adapter (CodeLLDB / cppdbg / ...)
          │
          ▼
   authorized debug target
```

The bridge is not tied to one language or debugger. It speaks standard DAP framing and exposes structured debugger operations as MCP tools.

## MCP tools

| MCP tool | Purpose |
| --- | --- |
| `debug_codelldb_info` | Discover CodeLLDB on the local machine |
| `debug_start_codelldb` | Auto-discover and initialize CodeLLDB |
| `debug_launch_codelldb` | Launch a native target with the CodeLLDB profile |
| `debug_attach_codelldb` | Attach CodeLLDB to an authorized local native process |
| `debug_start` | Spawn and initialize a generic DAP adapter |
| `debug_launch` | Launch a target and complete DAP configuration |
| `debug_attach` | Attach to an authorized target |
| `debug_set_breakpoints` | Set source breakpoints |
| `debug_continue` | Continue and optionally wait for a stop |
| `debug_step` | Step over / into / out |
| `debug_threads` | List threads |
| `debug_stack` | Read stack frames |
| `debug_scopes` | Read frame scopes |
| `debug_variables` | Expand variables |
| `debug_evaluate` | Evaluate an expression |
| `debug_modules` | List loaded executable images and libraries |
| `debug_disassemble` | Disassemble instructions around a DAP memory reference |
| `debug_read_memory` | Read a bounded memory range and return base64 + hex bytes |
| `debug_exception_info` | Read structured exception information for a stopped thread |
| `debug_snapshot` | Capture an agent-friendly runtime snapshot in one tool call |
| `debug_status` | Inspect current session state |
| `debug_events` | Read recent asynchronous DAP events |
| `debug_disconnect` | Disconnect and stop the adapter |

## `debug_snapshot`

`debug_snapshot` is the preferred inspection primitive for an agent after a breakpoint, step, or exception. It reduces multiple debugger round trips into one bounded MCP result.

By default it captures:

- the most recent stopped reason,
- the selected thread,
- a bounded stack trace,
- the current/top stack frame,
- source path, line and instruction pointer when available,
- frame scopes,
- local variables / arguments,
- registers when the adapter exposes a Registers scope,
- disassembly around the current instruction pointer,
- structured exception information when the stop reason is `exception`.

Loaded modules are optional because module lists can be large:

```text
debug_snapshot(includeModules=true, moduleCount=50)
```

The result is intentionally bounded with configurable stack, variable, module and disassembly limits so an agent does not accidentally pull an unbounded debugger state tree into context.

## CodeLLDB on Windows

CodeLLDB is the first real debugger profile implemented and continuously tested by this project.

CodeLLDB **1.11.0 or newer** is required because that release added direct stdio DAP support. The bridge can locate `codelldb.exe` from:

- an explicit `adapterPath`,
- `CODELLDB_PATH`,
- common VS Code / VS Code Insiders / Cursor / Windsurf / VS Code OSS extension directories,
- or `PATH`.

Typical agent workflow:

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
5. debug_evaluate(expression="value", frameId=...)
6. debug_step(action="next", threadId=...)
7. debug_snapshot()
8. debug_continue(threadId=...)
9. debug_disconnect()
```

The CodeLLDB launch helper forces `terminal: "console"`, keeping debuggee I/O inside DAP and avoiding `runInTerminal` reverse requests.

See [docs/CODELLDB_WINDOWS.md](docs/CODELLDB_WINDOWS.md) for setup and the real native smoke-test workflow.

## Real CodeLLDB validation

The Windows integration workflow builds a small C++ program with MSVC debug symbols and drives a real CodeLLDB process over DAP stdio.

The current v0.3 integration test verifies all of the following against CodeLLDB 1.12.x:

- launch of an MSVC-built executable,
- verified source breakpoint,
- stopped event and thread selection,
- source/line mapping and instruction pointer,
- stack trace,
- locals,
- expression evaluation,
- loaded modules,
- disassembly around the instruction pointer,
- bounded memory reads,
- register scope capture,
- combined runtime snapshots.

A representative CI run captured 5 modules, 11 disassembled instructions, 16 bytes of executable memory, local variables `delta` and `counter`, and register state in a single snapshot workflow.

## Safety posture

This is a local debugging bridge, not a remote debugger service.

- MCP is served over **stdio only**.
- DAP adapters are spawned with `shell: false`.
- DAP reverse requests such as `runInTerminal` are **rejected by default**.
- CodeLLDB launches use `terminal: "console"` so they do not depend on terminal-spawning reverse requests.
- Keep the Qwen Code MCP entry **untrusted** (`trust: false`) so debugger tool calls remain reviewable.
- `debug_evaluate` may have side effects depending on the debugger/language.
- `debug_read_memory` is read-only and limited to at most 64 KiB per MCP call.
- Use launch/attach/inspection tools only with software and processes you are authorized to debug.

## Requirements

- Node.js 20+
- A DAP adapter that can communicate over stdin/stdout
- For the built-in CodeLLDB profile: CodeLLDB 1.11.0+

## Install for development

```bash
npm install
npm run check
npm run build
```

Run the MCP server directly:

```bash
npm start
```

For development without building:

```bash
npm run dev
```

## Connect it to Qwen Code

After building this repository, add a project-scoped stdio MCP server from the project where you want to debug:

```bash
qwen mcp add --scope project qwen-dap-mcp node /absolute/path/to/qwen-dap-mcp/dist/index.js
```

Or add it to `.qwen/settings.json`:

```json
{
  "mcpServers": {
    "qwen-dap-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/qwen-dap-mcp/dist/index.js"],
      "timeout": 120000,
      "trust": false
    }
  }
}
```

Restart Qwen Code after adding the server, then use `/mcp` to verify that the tools are discovered.

## Generic DAP workflow

Exact launch configuration is adapter-specific. A generic DAP-capable agent can perform:

```text
1. debug_start(adapterCommand=..., adapterId=...)
2. debug_launch(configuration={...}, breakpoints=[...])
3. debug_snapshot()
4. debug_evaluate(...)
5. debug_step(...) or debug_continue(...)
6. debug_snapshot()
7. debug_disconnect()
```

The lower-level `debug_threads`, `debug_stack`, `debug_scopes`, `debug_variables`, `debug_modules`, `debug_disassemble` and `debug_read_memory` tools remain available when the agent needs targeted inspection.

## Testing

Normal CI runs the TypeScript build, CodeLLDB profile tests, and an end-to-end mock DAP adapter test on Node 20 and 22.

A separate **CodeLLDB Windows Smoke** workflow builds a real C++ target with MSVC debug symbols, downloads the latest Windows CodeLLDB release, starts `codelldb.exe` over stdio and validates the native inspection path. Changes to the DAP session, CodeLLDB profile, MCP tools, native smoke test or package metadata automatically trigger that workflow.

## Current limitations

- No HTTP listener or remote exposure
- No `runInTerminal` reverse-request execution
- No memory-write MCP tool
- No conditional/function/data/instruction-breakpoint MCP tools yet
- No multi-session support yet
- No crash-dump/core-dump workflow yet
- No additional built-in debugger profile beyond CodeLLDB yet
- No Qwen-specific core patches

## Roadmap

### v0.3 — native inspection ✅

- CodeLLDB discovery and launch/attach profile ✅
- Real Windows C++ smoke test ✅
- Loaded modules ✅
- Registers through standard DAP scopes ✅
- Disassembly ✅
- Bounded memory reads ✅
- Exception information ✅
- Agent-friendly runtime snapshot ✅
- Real CI assertions for the advanced inspection path ✅

### v0.4 — richer breakpoint and stop control

- Conditional breakpoints
- Function breakpoints
- Data breakpoints / watchpoints
- Instruction breakpoints
- Exception breakpoint configuration
- Pause support

### v0.5 — agent workflow layer

- Qwen Code debugging Skill
- Crash-diagnosis workflow
- Build → launch → diagnose → patch → rebuild → verify loop
- Additional adapter profiles for common C/C++ setups
- Evidence collection for MCP latency / event-streaming limitations

## Development status

**Experimental, but backed by a real native integration test.** The generic protocol framing and session orchestration are covered by a mock DAP end-to-end test, while the CodeLLDB profile is exercised against a real MSVC-built C++ executable on GitHub Actions Windows runners.

## License

Apache-2.0
