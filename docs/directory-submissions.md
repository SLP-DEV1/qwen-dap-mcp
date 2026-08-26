# Directory submissions

Maintained copy and requirements for listing `qwen-dap-mcp` in MCP discovery directories and curated lists.

Canonical project data:

- Repository: `https://github.com/SLP-DEV1/qwen-dap-mcp`
- npm: `@slp-dev1/qwen-dap-mcp`
- MCP Registry: `io.github.SLP-DEV1/qwen-dap-mcp`
- Category: Developer Tools / Debugging / Coding Agents
- Language: TypeScript
- Transport: local stdio
- License: Apache-2.0
- Primary integration: Qwen Code
- Tested native debugger profile: CodeLLDB
- Validated postmortem path: Windows minidumps

## punkpeye/awesome-mcp-servers

Current upstream contribution rules require a README entry in the most specific category, alphabetical placement, one server per line, a concise description, and a Glama score badge for new server submissions.

Target category: `Developer Tools`.

Suggested entry before adding the Glama badge:

```markdown
- [SLP-DEV1/qwen-dap-mcp](https://github.com/SLP-DEV1/qwen-dap-mcp) 📇 🏠 🪟 - DAP-to-MCP bridge that gives coding agents structured native-debugger evidence through CodeLLDB, including stack frames, registers, locals, disassembly, memory, crash dumps, and bounded autonomous crash fix/verify workflows. [ADD GLAMA SCORE BADGE AFTER GLAMA LISTING]
```

Suggested PR title after Glama is ready:

```text
Add qwen-dap-mcp native debugger bridge 🤖🤖🤖
```

The upstream CONTRIBUTING guide explicitly allows automated-agent submissions to opt into its streamlined process by adding `🤖🤖🤖` to the PR title.

Do not submit this PR until the Glama listing exists and its score badge resolves; otherwise upstream automation marks the submission `missing-glama`.

## Glama

Glama is the prerequisite for the large `punkpeye/awesome-mcp-servers` listing.

Submission metadata:

```text
Name: qwen-dap-mcp
Repository: https://github.com/SLP-DEV1/qwen-dap-mcp
Category: Developer Tools
Transport: stdio
Language: TypeScript
License: Apache-2.0
Description: Give AI coding agents a real native debugger. qwen-dap-mcp bridges DAP to MCP and exposes structured CodeLLDB runtime and crash evidence, Windows minidumps, and bounded evidence-backed crash fix/verify workflows.
Install: npx -y @slp-dev1/qwen-dap-mcp
```

After Glama assigns the final repository path, use the exact generated Glama score badge in the punkpeye entry rather than guessing its URL.

## BrethofAI/awesome-mcp-servers

This curated list currently asks maintainers to open an issue containing the server name, repository URL, category, and one paragraph explaining why it is worth listing. It also requires a maintained release within the last six months.

Suggested issue title:

```text
Add qwen-dap-mcp — native debugging for coding agents via DAP → MCP
```

Suggested issue body:

```markdown
## Server

**qwen-dap-mcp**  
Repository: https://github.com/SLP-DEV1/qwen-dap-mcp  
Category: Developer Tools  
License: Apache-2.0  
Distribution: npm `@slp-dev1/qwen-dap-mcp`, official MCP Registry `io.github.SLP-DEV1/qwen-dap-mcp`

## Why it is worth listing

qwen-dap-mcp gives MCP-capable coding agents structured access to a real native debugger instead of relying only on shell output. It bridges the Debug Adapter Protocol to MCP and exposes stack frames, registers, locals, exception state, modules, disassembly, bounded memory reads, CodeLLDB live debugging, Windows minidump analysis, runtime root-cause backtracking, and evidence-based crash verification. Qwen Code is the primary integration, and the project ships tested GitHub releases plus a published npm package and official MCP Registry entry.
```

## mcp-finder/awesome-mcp-servers

Target category: `Developer tools`.

Suggested README entry:

```markdown
- [qwen-dap-mcp](https://github.com/SLP-DEV1/qwen-dap-mcp) — Gives MCP-capable coding agents structured native-debugger evidence through a DAP bridge, with CodeLLDB runtime debugging, crash dumps, and bounded autonomous crash verification.
```

The upstream contribution checklist expects a working server, a public source/install path, a one-sentence functional description, and placement in the most specific category.

## Smithery

Current Smithery publishing supports public Streamable HTTP servers directly. Local stdio servers are distributed as pre-built MCPB bundles. `qwen-dap-mcp` is intentionally local stdio, so a Smithery listing should wait until the project ships and validates an MCPB bundle rather than adding a remote HTTP transport only for directory compatibility.

Potential future Smithery qualified name:

```text
slp-dev1/qwen-dap-mcp
```

## Community launch channels

Reusable launch copy for Qwen Code Show and Tell, Reddit, Hacker News and short social posts lives in [`launch-kit.md`](launch-kit.md).

Do **not** post further updates in `QwenLM/qwen-code/issues/10051`. Use a new Qwen Code Show and Tell discussion for community launch material instead.
