# Contributing

Thanks for helping improve `qwen-dap-mcp`.

The project aims to stay debugger-agnostic at the MCP layer while providing practical native runtime debugging through DAP adapters such as CodeLLDB.

## Good contributions

Contributions are especially useful when they include one or more of:

- a reproducible native debugging or crash-analysis workflow,
- support or hardening for a DAP adapter,
- better debugger evidence and source correlation,
- bounded autonomous debugging improvements,
- crash-dump / postmortem improvements,
- lifecycle, concurrency, protocol, or path-safety fixes,
- regression tests for real debugger behavior,
- documentation that makes installation or debugging easier.

Please keep the MCP bridge focused. It should not grow into a general shell, arbitrary source-writing service, unrestricted memory-writing API, or hidden autonomous agent runtime.

## Development

Requirements:

- Node.js 20+
- npm

Install dependencies and run the complete check:

```bash
npm install --ignore-scripts
npm run check
```

`npm run check` builds TypeScript, runs the test suite, and stages the self-contained Qwen extension package.

## Pull requests

Before opening a PR:

1. Keep the change focused and explain the debugging problem it solves.
2. Add or update regression tests where practical.
3. Run `npm run check` locally.
4. Avoid unrelated formatting or generated-file churn.
5. Preserve the bridge's local-stdio and bounded-evidence safety model.

For larger features, open an issue first with a concrete debugger workflow, expected behavior, and any relevant DAP messages or crash evidence.

## Bug reports

A useful debugger bug report normally includes:

- operating system,
- Node.js version,
- debugger / DAP adapter and version,
- target language and architecture,
- whether the failure is live debugging or postmortem,
- the smallest reliable reproduction you can share,
- relevant `QWEN_DAP_LOG_LEVEL=debug` stderr output with secrets and private paths removed.

## License

By contributing, you agree that your contributions will be licensed under the repository's Apache-2.0 license.
