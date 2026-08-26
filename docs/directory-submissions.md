# Directory submissions

Maintained copy and requirements for listing `qwen-dap-mcp` in MCP discovery directories and curated lists.

Canonical project data:

- Repository: `https://github.com/SLP-DEV1/qwen-dap-mcp`
- Current release: `v0.12.0`
- npm: `@slp-dev1/qwen-dap-mcp@0.12.0`
- npm latest: `0.12.0`
- MCP Registry: `io.github.SLP-DEV1/qwen-dap-mcp`
- Category: Developer Tools / Debugging / Coding Agents
- Language: TypeScript
- Transport: local stdio
- License: Apache-2.0
- Primary integration: Qwen Code
- Tested native debugger profile: CodeLLDB
- Validated postmortem path: Windows minidumps

## Glama

Glama is the immediate prerequisite for the large `punkpeye/awesome-mcp-servers` listing. Glama also indexes the official MCP Registry, so the newly published official Registry record may appear automatically. If the repository is not visible yet, use **Add Server** at `https://glama.ai/mcp/servers` and submit the GitHub repository.

Submission metadata:

```text
Name: qwen-dap-mcp
Repository: https://github.com/SLP-DEV1/qwen-dap-mcp
Category: Developer Tools
Transport: stdio
Language: TypeScript
License: Apache-2.0
Description: Give AI coding agents a real native debugger. qwen-dap-mcp bridges DAP to MCP and exposes structured CodeLLDB runtime and crash evidence, Windows minidumps, compact agent-first tooling, and bounded evidence-backed crash fix/verify workflows.
Install: npx -y @slp-dev1/qwen-dap-mcp
Version: 0.12.0
```

The repository contains a root `Dockerfile`, `.dockerignore`, and `glama.json` so Glama can build the server reproducibly, start the stdio MCP process, and run protocol introspection. The container is useful for registry validation and for environments where the debugger and target executable are available inside the same runtime. Normal native debugging remains a local workflow because CodeLLDB and the program being debugged must be reachable from the MCP process.

After the server is visible on Glama:

1. Authenticate with GitHub and claim the server.
2. Open the server's Score/Admin area and run the build/introspection test.
3. Make sure a quality score is generated; the exact grade is not a prerequisite for the awesome-list submission.
4. Copy the exact Glama repository path and score badge URL.
5. Only then submit the `punkpeye/awesome-mcp-servers` PR.

Expected badge shape after Glama assigns the final path:

```markdown
[![SLP-DEV1/qwen-dap-mcp MCP server](https://glama.ai/mcp/servers/SLP-DEV1/qwen-dap-mcp/badges/score.svg)](https://glama.ai/mcp/servers/SLP-DEV1/qwen-dap-mcp)
```

Do not assume that exact path until Glama actually creates the listing.

## punkpeye/awesome-mcp-servers

Current upstream contribution rules require a README entry in the most specific category, alphabetical placement, one server per line, a concise description, and a Glama score badge for new server submissions.

Target category: `Developer Tools`.

Suggested entry once the real Glama path is known:

```markdown
- [SLP-DEV1/qwen-dap-mcp](https://github.com/SLP-DEV1/qwen-dap-mcp) 📇 🏠 🪟 - DAP-to-MCP bridge that gives coding agents structured native-debugger evidence through CodeLLDB, including stack frames, registers, locals, disassembly, memory, crash dumps, and bounded autonomous crash fix/verify workflows. [GLAMA SCORE BADGE]
```

Suggested PR title:

```text
Add qwen-dap-mcp native debugger bridge 🤖🤖🤖
```

The upstream CONTRIBUTING guide explicitly allows automated-agent submissions to opt into its streamlined process by adding `🤖🤖🤖` to the PR title.

Do not submit this PR until the Glama listing exists and its score badge resolves; otherwise upstream automation labels the submission `missing-glama`.

## BrethofAI/awesome-mcp-servers

This curated list asks maintainers to open an issue containing the server name, repository URL, category, and one paragraph explaining why it is worth listing.

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

## Why it is worth listing

qwen-dap-mcp gives MCP-capable coding agents structured access to a real native debugger instead of relying only on shell output. It bridges the Debug Adapter Protocol to MCP and exposes stack frames, registers, locals, exception state, modules, disassembly, bounded memory reads, CodeLLDB live debugging, Windows minidump analysis, runtime root-cause backtracking, and evidence-based crash verification. v0.12 adds a compact agent-first tool surface plus reproducible native Crash Lab fixtures and benchmark scaffolding. Qwen Code is the primary integration, and the project ships tested GitHub releases plus a published npm package and official MCP Registry entry.
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

Reusable launch copy for Qwen Code Show and Tell, Reddit, Hacker News and short social posts lives in [`launch-kit.md`](launch-kit.md).

Community-specific constraints matter:

- Qwen Code: use a new **Show and tell** discussion, not the old feature issue.
- `r/LocalLLaMA`: current Rule 4 actively removes accounts whose subreddit activity is mostly self-promotion; participate normally before posting the project again. Rule 3 also scrutinizes undisclosed LLM-generated posts, so rewrite the final Reddit copy in your own voice and disclose assistance where appropriate.
- Hacker News: Show HN is appropriate because the project is runnable without signup, but HN currently restricts Show HN submissions from accounts that are not established community participants.

Do **not** post further updates in `QwenLM/qwen-code/issues/10051`.
