# awesome-mcp-servers submission

Copy/paste-ready submission material for `punkpeye/awesome-mcp-servers`.

Upstream repository:

`https://github.com/punkpeye/awesome-mcp-servers`

## PR title

```text
Add qwen-dap-mcp native debugger bridge 🤖🤖🤖
```

The `🤖🤖🤖` suffix opts into the streamlined automated-agent submission path described by the upstream CONTRIBUTING guide.

## Target category

`Developer Tools`

Keep the new line alphabetically placed within that category and do not bundle unrelated changes into the PR.

## README entry

```markdown
- [SLP-DEV1/qwen-dap-mcp](https://github.com/SLP-DEV1/qwen-dap-mcp) 📇 🏠 🪟 - DAP-to-MCP bridge that gives coding agents structured native-debugger evidence through CodeLLDB, including stack frames, registers, locals, disassembly, memory, crash dumps, and bounded autonomous crash fix/verify workflows. [![SLP-DEV1/qwen-dap-mcp MCP server](https://glama.ai/mcp/servers/SLP-DEV1/qwen-dap-mcp/badges/score.svg)](https://glama.ai/mcp/servers/SLP-DEV1/qwen-dap-mcp)
```

## PR body

```markdown
## What this adds

Adds `SLP-DEV1/qwen-dap-mcp` to Developer Tools.

qwen-dap-mcp is a local DAP-to-MCP bridge for coding agents. It exposes structured native-debugger evidence through CodeLLDB, including live debugging, Windows minidumps, stack/register/local/disassembly/module/memory evidence, and bounded diagnose → fix → reproduce → verify workflows.

Project links:

- Repository: https://github.com/SLP-DEV1/qwen-dap-mcp
- Glama: https://glama.ai/mcp/servers/SLP-DEV1/qwen-dap-mcp
- npm: https://www.npmjs.com/package/@slp-dev1/qwen-dap-mcp
- Official MCP Registry: `io.github.SLP-DEV1/qwen-dap-mcp`

I maintain this server. The Glama score badge is included in the README entry as required.
```

## Minimal manual workflow

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/awesome-mcp-servers.git
cd awesome-mcp-servers
git remote add upstream https://github.com/punkpeye/awesome-mcp-servers.git
git fetch upstream
git checkout -b add-qwen-dap-mcp upstream/main
```

Edit `README.md`, add the exact entry above in alphabetical order under Developer Tools, then:

```bash
git add README.md
git commit -m "Add qwen-dap-mcp native debugger bridge"
git push -u origin add-qwen-dap-mcp
```

Open a PR from the fork using the title and body above.

## Validation checklist

Before submitting:

- repository link resolves,
- Glama link resolves,
- Glama score badge renders,
- entry is one line,
- entry is in the most relevant category,
- alphabetical order is preserved,
- PR contains no unrelated changes,
- maintainer relationship is disclosed.
