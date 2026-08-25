# qwen-dap-mcp

A small, debugger-agnostic **Debug Adapter Protocol (DAP) → Model Context Protocol (MCP)** bridge for agentic runtime debugging.

The initial goal is deliberately narrow: prove that Qwen Code can consume structured runtime-debugging state through its existing first-class MCP extension surface before proposing a larger native DAP integration in Qwen Code core.

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
  DAP adapter (cppdbg / LLDB / GDB bridge / ...)
          │
          ▼
   authorized debug target
```

The bridge is not tied to one language or debugger. It speaks standard DAP framing and forwards structured debugger operations as MCP tools.

## MVP tools

| MCP tool | Purpose |
| --- | --- |
| `debug_start` | Spawn and initialize a DAP adapter |
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
| `debug_status` | Inspect current session state |
| `debug_events` | Read recent asynchronous DAP events |
| `debug_disconnect` | Disconnect and stop the adapter |

## Safety posture of the MVP

This is a local debugging bridge, not a remote debugger service.

- MCP is served over **stdio only**.
- The DAP adapter is spawned with `shell: false`.
- DAP reverse requests such as `runInTerminal` are **rejected by default** in v0.1.
- Keep the Qwen Code MCP entry **untrusted** (`trust: false`) so debugger tool calls remain reviewable.
- `debug_evaluate` may have side effects depending on the debugger/language. Use it only with software and processes you are authorized to debug.

## Requirements

- Node.js 20+
- A DAP adapter that can communicate over stdin/stdout

The bridge does not bundle a debugger. Adapter-specific setup belongs in small adapter profiles planned for later versions.

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

Qwen Code supports local stdio MCP servers through `mcpServers`.

After building this repository, add a project-scoped server from the project where you want to debug:

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

## Example workflow

Exact launch configuration is adapter-specific. Conceptually an agent can now perform:

```text
1. debug_start(adapterCommand=..., adapterId=...)
2. debug_launch(configuration={...}, breakpoints=[...])
3. debug_threads()
4. debug_stack(threadId=...)
5. debug_scopes(frameId=...)
6. debug_variables(variablesReference=...)
7. debug_evaluate(expression=..., frameId=...)
8. debug_continue(...) or debug_step(...)
9. debug_disconnect()
```

This is enough to test the core hypothesis from QwenLM/qwen-code#10051: can an agent reliably diagnose runtime bugs when DAP state is exposed through MCP?

## What v0.1 intentionally does not do

- No HTTP listener or remote exposure
- No `runInTerminal` reverse-request execution
- No adapter auto-discovery
- No registers/disassembly/memory tools yet
- No data or instruction breakpoints yet
- No multi-session support yet
- No Qwen-specific core patches

These omissions are intentional. The first milestone should validate the MCP-first approach with the smallest useful surface.

## Roadmap

### v0.2 — native debugging depth

- Modules
- Registers when exposed by the adapter
- Disassembly
- Memory read
- Exception information
- Better stopped-event snapshots

### v0.3 — richer breakpoint support

- Conditional breakpoints
- Function breakpoints
- Data breakpoints / watchpoints
- Instruction breakpoints

### v0.4 — agent workflow layer

- Qwen Code debugging Skill
- Crash-diagnosis workflow
- Build → launch → diagnose → patch → rebuild → verify loop
- Adapter profiles for common C/C++ setups

## Why MCP first?

The Qwen Code triage for issue #10051 explicitly suggested a community DAP-to-MCP bridge plus Skill before committing to a multi-quarter core DAP integration. A standalone bridge lets us collect real evidence about:

- stepping latency,
- event delivery,
- tool-call round trips,
- variable-tree size,
- debugger-specific compatibility,
- and which capabilities truly require native core support.

That evidence can later support a much narrower and stronger Qwen Code design proposal.

## Development status

**Experimental / proof of concept.** The protocol framing and session orchestration are covered by an end-to-end test using a small mock DAP adapter. Real debugger profiles are the next milestone.

## License

Apache-2.0
