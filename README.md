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

## Qwen Code extension

Starting with **v0.5**, this repository is also shaped as a native Qwen Code extension:

```text
qwen-extension.json
skills/
└─ native-runtime-debug/
   └─ SKILL.md
```

The extension manifest starts the local `qwen-dap-mcp` stdio MCP server from the extension directory. The bundled `native-runtime-debug` Skill teaches Qwen Code how to combine the tools into evidence-driven native debugging workflows.

The manifest deliberately does **not** set `trust`, so Qwen Code retains its normal extension/MCP consent and review flow.

### Local extension setup

The source repository currently expects a local build before linking:

```bash
git clone https://github.com/SLP-DEV1/qwen-dap-mcp.git
cd qwen-dap-mcp
npm install --ignore-scripts
npm run check
npm run build
qwen extensions link .
```

Restart Qwen Code if needed, then verify:

```text
/mcp
/skills
```

The Skill can be invoked explicitly with:

```text
/native-runtime-debug
```

or Qwen Code can choose it automatically when a request matches its description.

A prebuilt self-contained release archive is a later packaging step; until then, build-and-link is the supported extension-development workflow.

### Skill behavior

The bundled Skill standardizes:

- CodeLLDB discovery and startup,
- launch versus authorized local attach,
- first-stop `debug_snapshot` inspection,
- crash/exception diagnosis,
- conditional/function/instruction breakpoint selection,
- two-stage data-breakpoint/watchpoint setup,
- Windows `DebugBreak` pause interpretation,
- evidence-based root-cause claims,
- source fix → rebuild → reproduce → verify,
- cleanup and debugger disconnect.

The same Skill is also kept under `.qwen/skills/native-runtime-debug/SKILL.md` for project-local development in this repository. CI verifies that the project and extension copies remain identical.

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
| `debug_set_breakpoints` | Set simple source-line breakpoints |
| `debug_set_source_breakpoints` | Set conditional, hit-count and log source breakpoints |
| `debug_set_function_breakpoints` | Set function breakpoints |
| `debug_set_instruction_breakpoints` | Set instruction-address breakpoints |
| `debug_data_breakpoint_info` | Resolve a debugger-specific dataId for a variable/watchpoint |
| `debug_set_data_breakpoints` | Set data breakpoints / watchpoints |
| `debug_set_exception_breakpoints` | Configure adapter-defined exception filters |
| `debug_pause` | Pause a running target and preserve the raw DAP stop |
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

`debug_snapshot` is the preferred inspection primitive for an agent after a breakpoint, step, watchpoint or exception. It reduces multiple debugger round trips into one bounded MCP result.

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

## Advanced breakpoints and watchpoints

v0.4 added richer stop control using standard DAP requests.

### Conditional / hit-count / log source breakpoints

```text
debug_set_source_breakpoints(
  source="C:\\project\\src\\main.cpp",
  breakpoints=[
    {
      line=42,
      condition="counter > 10",
      hitCondition=">= 3"
    }
  ]
)
```

`logMessage` is also exposed for adapters that support DAP log points.

### Function and instruction breakpoints

```text
debug_set_function_breakpoints(
  breakpoints=[{ name="main" }]
)

debug_set_instruction_breakpoints(
  breakpoints=[{ instructionReference="0x7ff612341234" }]
)
```

### Data breakpoints / watchpoints

DAP data breakpoints use a two-step flow because the debugger owns the stable data identifier:

```text
info = debug_data_breakpoint_info(
  name="counter",
  variablesReference=...,
  frameId=...
)

debug_set_data_breakpoints(
  breakpoints=[
    { dataId=info.dataId, accessType="write" }
  ]
)
```

CodeLLDB currently advertises `read`, `write` and `readWrite` access modes for the real C++ test variable.

### Exception filters

```text
debug_set_exception_breakpoints(
  filters=["cpp_throw"]
)
```

The exact filter IDs are adapter-defined and are advertised in the DAP initialize capabilities.

### Clearing breakpoints

DAP `set*Breakpoints` requests replace the corresponding breakpoint collection. Pass an empty array to clear that class of breakpoint:

```text
debug_set_function_breakpoints(breakpoints=[])
debug_set_instruction_breakpoints(breakpoints=[])
debug_set_data_breakpoints(breakpoints=[])
```

## Pause semantics

`debug_pause` returns an explicit `requestedAction: "pause"` marker and preserves the raw DAP stopped event.

On Windows, CodeLLDB/LLDB currently implements a pause through **DebugBreak**. The raw stop can therefore look like:

```text
requestedAction: pause
stopped.reason: exception
stopped.description: Exception 0x80000003 ...
```

That is a successful requested pause, not an application crash by itself. Preserving the raw event is useful for debugging while the `requestedAction` field makes the agent's intent unambiguous.

The bundled Skill contains this interpretation explicitly so Qwen does not misclassify a user-requested pause as a native crash.

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
6. debug_set_source_breakpoints(...)
7. debug_data_breakpoint_info(...)
8. debug_set_data_breakpoints(...)
9. debug_continue(threadId=...)
10. debug_snapshot()
11. debug_pause(threadId=...)
12. debug_snapshot()
13. debug_disconnect()
```

The CodeLLDB launch helper forces `terminal: "console"`, keeping debuggee I/O inside DAP and avoiding `runInTerminal` reverse requests.

See [docs/CODELLDB_WINDOWS.md](docs/CODELLDB_WINDOWS.md) for setup and the real native smoke-test workflow.

## Real CodeLLDB validation

The Windows integration workflow builds a small C++ program with MSVC debug symbols and drives a real CodeLLDB process over DAP stdio.

The current integration test verifies all of the following against CodeLLDB 1.12.x:

- launch of an MSVC-built executable,
- verified source breakpoint,
- conditional/hit-count source breakpoint,
- function breakpoint,
- instruction breakpoint,
- exception breakpoint configuration,
- stopped event and thread selection,
- source/line mapping and instruction pointer,
- stack trace,
- locals,
- expression evaluation,
- a real data breakpoint / hardware watchpoint,
- loaded modules,
- disassembly around the instruction pointer,
- bounded memory reads,
- register scope capture,
- combined runtime snapshots,
- pause of a running Windows target, including CodeLLDB's raw DebugBreak semantics.

A representative successful CI run with CodeLLDB 1.12.3 produced:

```text
initial counter:              35
conditional source verified: true
function breakpoint verified: true
instruction breakpoint:      true
watchpoint access modes:      read / write / readWrite
watchpoint stop reason:       data breakpoint
counter after watched write:  42
loaded modules:               5
disassembly:                  11 instructions
memory read:                  16 bytes
snapshot registers:           2 entries
pause requestedAction:        pause
raw Windows pause stop:       exception 0x80000003 (DebugBreak)
```

This verifies the bridge against a real native debugger rather than only the mock DAP adapter.

## Safety posture

This is a local debugging bridge, not a remote debugger service.

- MCP is served over **stdio only**.
- DAP adapters are spawned with `shell: false`.
- DAP reverse requests such as `runInTerminal` are **rejected by default**.
- CodeLLDB launches use `terminal: "console"` so they do not depend on terminal-spawning reverse requests.
- The extension manifest does not bypass Qwen's MCP trust/consent flow.
- `debug_evaluate` may have side effects depending on the debugger/language.
- `debug_read_memory` is read-only and limited to at most 64 KiB per MCP call.
- The bridge does not expose a memory-write MCP tool.
- Use launch/attach/inspection tools only with software and processes you are authorized to debug.

## Requirements

- Node.js 20+
- A DAP adapter that can communicate over stdin/stdout
- For the built-in CodeLLDB profile: CodeLLDB 1.11.0+

## Install for development

```bash
npm install --ignore-scripts
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

## Manual MCP configuration

If you do not want to link the repository as a Qwen extension, you can still add only the MCP server after building:

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
5. configure advanced breakpoints/watchpoints as needed
6. debug_step(...) or debug_continue(...)
7. debug_snapshot()
8. debug_disconnect()
```

The lower-level thread, stack, scope, variable, module, disassembly and memory tools remain available when the agent needs targeted inspection.

## Testing

Normal CI runs the TypeScript build, CodeLLDB profile tests, the Qwen extension/Skill manifest tests, and an end-to-end mock DAP adapter test on Node 20 and 22.

The extension tests verify:

- `qwen-extension.json` and `package.json` versions match,
- the extension starts the local server through `${extensionPath}`,
- no manifest `trust` bypass is present,
- the project and bundled Skill copies stay identical,
- the Skill references the core runtime-debugging workflow tools.

A separate **CodeLLDB Windows Smoke** workflow builds a real C++ target with MSVC debug symbols, downloads the latest Windows CodeLLDB release, starts `codelldb.exe` over stdio and validates the native inspection and breakpoint-control paths. Changes to the DAP session, CodeLLDB profile, MCP tools, native smoke test or package metadata automatically trigger that workflow.

## Current limitations

- Source-repo extension use currently requires `npm install` + build before `qwen extensions link .`
- No prebuilt self-contained Qwen extension release asset yet
- No HTTP listener or remote exposure
- No `runInTerminal` reverse-request execution
- No memory-write MCP tool
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

### v0.4 — richer breakpoint and stop control ✅

- Conditional source breakpoints ✅
- Hit-count breakpoints ✅
- Log-point fields ✅
- Function breakpoints ✅
- Data breakpoints / hardware watchpoints ✅
- Instruction breakpoints ✅
- Exception breakpoint configuration ✅
- Pause support with raw-stop preservation ✅
- Real Windows assertions for conditional/function/instruction/data breakpoints and pause ✅

### v0.5 — Qwen agent workflow integration ✅

- Native Qwen extension manifest ✅
- Bundled `native-runtime-debug` Skill ✅
- Project-local Skill copy for repository development ✅
- Crash/exception diagnosis workflow ✅
- Unexpected-write/watchpoint workflow ✅
- Build → launch → diagnose → patch → rebuild → verify guidance ✅
- Windows DebugBreak pause interpretation in the Skill ✅
- Extension/Skill consistency tests ✅

### v0.6 — packaging and debugger breadth

- Prebuilt self-contained Qwen extension release assets
- Additional adapter profiles for common C/C++ setups
- Crash-dump / core-dump workflow
- Multi-session support investigation
- MCP stepping-latency and event-streaming measurements

## Development status

**Experimental, but backed by a real native integration test and a Qwen-native workflow layer.** The generic protocol framing and session orchestration are covered by a mock DAP end-to-end test, the CodeLLDB profile is exercised against a real MSVC-built C++ executable on GitHub Actions Windows runners, and the bundled Qwen Skill codifies the evidence-driven debugging flow for agent use.

## License

Apache-2.0
