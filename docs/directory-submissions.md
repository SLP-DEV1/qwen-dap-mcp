# Directory submissions

Maintained copy and requirements for listing `qwen-dap-mcp` in MCP discovery directories and curated lists.

Canonical project data:

- Repository: `https://github.com/SLP-DEV1/qwen-dap-mcp`
- Current release: `v0.12.0`
- npm: `@slp-dev1/qwen-dap-mcp@0.12.0`
- npm latest: `0.12.0`
- MCP Registry: `io.github.SLP-DEV1/qwen-dap-mcp`
- Glama: `https://glama.ai/mcp/servers/SLP-DEV1/qwen-dap-mcp`
- Qwen Code Show and tell: `https://github.com/QwenLM/qwen-code/discussions/10130`
- Category: Developer Tools / Debugging / Coding Agents
- Language: TypeScript
- Transport: local stdio
- License: Apache-2.0
- Primary integration: Qwen Code
- Tested native debugger profile: CodeLLDB
- Validated postmortem path: Windows minidumps

## Glama

The Glama listing is live:

`https://glama.ai/mcp/servers/SLP-DEV1/qwen-dap-mcp`

The repository contains a root `Dockerfile`, `.dockerignore`, and `glama.json` so Glama can build the server reproducibly, start the stdio MCP process, and run protocol introspection. Normal native debugging remains local because CodeLLDB and the program being debugged must be reachable from the MCP process.

Exact Glama score badge:

```markdown
[![SLP-DEV1/qwen-dap-mcp MCP server](https://glama.ai/mcp/servers/SLP-DEV1/qwen-dap-mcp/badges/score.svg)](https://glama.ai/mcp/servers/SLP-DEV1/qwen-dap-mcp)
```

This is the badge shape required by the large `punkpeye/awesome-mcp-servers` list. The exact grade is not the important part for submission; the Glama listing must exist and the badge must resolve.

## punkpeye/awesome-mcp-servers

Upstream contribution rules require a README entry in the most specific category, alphabetical placement, one server per line, a concise description, and a Glama score badge for new server submissions.

Target category: `Developer Tools`.

Final suggested entry:

```markdown
- [SLP-DEV1/qwen-dap-mcp](https://github.com/SLP-DEV1/qwen-dap-mcp) 📇 🏠 🪟 - DAP-to-MCP bridge that gives coding agents structured native-debugger evidence through CodeLLDB, including stack frames, registers, locals, disassembly, memory, crash dumps, and bounded autonomous crash fix/verify workflows. [![SLP-DEV1/qwen-dap-mcp MCP server](https://glama.ai/mcp/servers/SLP-DEV1/qwen-dap-mcp/badges/score.svg)](https://glama.ai/mcp/servers/SLP-DEV1/qwen-dap-mcp)
```

Suggested PR title:

```text
Add qwen-dap-mcp native debugger bridge 🤖🤖🤖
```

The upstream CONTRIBUTING guide explicitly allows automated-agent submissions to opt into its streamlined process by adding `🤖🤖🤖` to the PR title. Keep the entry alphabetically placed within the relevant category and one server per line.

A copy/paste-ready submission checklist is maintained in [`awesome-mcp-submission.md`](awesome-mcp-submission.md).

## BrethofAI/awesome-mcp-servers

Suggested issue title:

```text
Add qwen-dap-mcp - native debugging for coding agents via DAP to MCP
```

Suggested issue body:

```markdown
## Server

**qwen-dap-mcp**  
Repository: https://github.com/SLP-DEV1/qwen-dap-mcp  
Category: Developer Tools  
License: Apache-2.0  
Current release: v0.12.0  
Distribution: npm `@slp-dev1/qwen-dap-mcp`, official MCP Registry `io.github.SLP-DEV1/qwen-dap-mcp`  
Glama: https://glama.ai/mcp/servers/SLP-DEV1/qwen-dap-mcp

## Why it is worth listing

qwen-dap-mcp gives MCP-capable coding agents structured access to a real native debugger instead of relying only on shell output. It bridges the Debug Adapter Protocol to MCP and exposes stack frames, registers, locals, exception state, modules, disassembly, bounded memory reads, CodeLLDB live debugging, Windows minidump analysis, runtime root-cause backtracking, and evidence-based crash verification. v0.12 adds a compact agent-first tool surface plus reproducible native Crash Lab fixtures and benchmark scaffolding. Qwen Code is the primary integration, and the project ships tested GitHub releases plus a published npm package, official MCP Registry entry, and Glama listing.
```

## mcp-finder/awesome-mcp-servers

Target category: `Developer tools`.

Suggested README entry:

```markdown
- [qwen-dap-mcp](https://github.com/SLP-DEV1/qwen-dap-mcp) - Gives MCP-capable coding agents structured native-debugger evidence through a DAP bridge, with CodeLLDB runtime debugging, crash dumps, compact agent tooling, and bounded autonomous crash verification.
```

## Smithery

Current Smithery publishing supports public Streamable HTTP servers directly. Local stdio servers are distributed as pre-built MCPB bundles. `qwen-dap-mcp` is intentionally local stdio, so a Smithery listing should wait until the project ships and validates an MCPB bundle rather than adding a remote HTTP transport only for directory compatibility.

Potential future Smithery qualified name:

```text
slp-dev1/qwen-dap-mcp
```

## Community launch channels

The Qwen Code Show and tell post is live:

`https://github.com/QwenLM/qwen-code/discussions/10130`

Reusable launch copy for Reddit, Hacker News, short social posts, and future Qwen updates lives in [`launch-kit.md`](launch-kit.md).

Community-specific constraints matter:

- Qwen Code: use the live Show and tell discussion for project discussion and updates.
- `r/LocalLLaMA`: avoid repeated self-promotion; participate normally and rewrite any final post in your own voice.
- Hacker News: Show HN is appropriate because the project is runnable without signup, but established-account participation matters.

Do **not** post further updates in `QwenLM/qwen-code/issues/10051`.
