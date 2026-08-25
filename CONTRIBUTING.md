# Contributing

This repository is an experimental DAP-to-MCP bridge created to validate the MCP-first approach discussed in QwenLM/qwen-code#10051.

For the MVP, please keep changes focused on:

- debugger-agnostic DAP protocol handling,
- small, composable MCP tools,
- local stdio transport,
- tests that reproduce debugger interactions,
- evidence about MCP limitations for agentic debugging.

Before proposing a larger feature, please include a reproducible debugger workflow or test case.

## Development

```bash
npm install
npm run check
```

Pull requests should keep the bridge independent from Qwen Code core unless a core integration is explicitly being prototyped.
