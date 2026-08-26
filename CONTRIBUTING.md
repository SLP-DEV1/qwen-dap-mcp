# Contributing

Thanks for helping improve `qwen-dap-mcp`.

The project aims to stay debugger-agnostic at the MCP layer while providing practical native runtime debugging through first-class DAP paths for CodeLLDB, upstream LLVM `lldb-dap`, and GNU GDB DAP.

## Good contributions

Contributions are especially useful when they include one or more of:

- a reproducible native crash, hang, differential, or runtime-state debugging workflow,
- support or hardening for a DAP adapter,
- better debugger evidence and source correlation,
- bounded autonomous debugging improvements,
- crash-dump / postmortem improvements,
- multi-session or remote-debugging hardening,
- lifecycle, cancellation, concurrency, protocol, policy, or path/endpoint-safety fixes,
- HOL Guard / DAP policy boundary regression coverage,
- real-debugger regression tests,
- documentation that makes installation, publishing, or debugging easier.

Please keep the MCP bridge focused. It should not grow into a general shell, arbitrary source-writing service, unrestricted memory-writing API, or hidden autonomous agent runtime.

## Development

Requirements:

- Node.js 20+
- npm

Install dependencies and run the complete check:

```bash
npm ci --ignore-scripts
npm run check
```

`npm run check` builds TypeScript, runs the test suite, and stages the self-contained Qwen extension package.

Adapter-specific real smoke workflows also run in GitHub Actions for CodeLLDB, GDB/gdbserver, lldb-dap/lldb-server, multi-session remote isolation, Differential Runtime, and HOL Guard compatibility.

## Pull requests

Before opening a PR:

1. Keep the change focused and explain the concrete debugging problem it solves.
2. Add or update regression tests where practical.
3. Run `npm run check` locally.
4. Avoid unrelated formatting or generated-file churn.
5. Preserve the local-stdio, endpoint-validation, authorization, and bounded-evidence safety model.
6. If a release-facing version changes, keep `package.json`, `package-lock.json`, `qwen-extension.json`, and `server.json` aligned.

For larger features, open an issue first with a concrete debugger workflow, expected behavior, and any relevant sanitized DAP messages or crash evidence.

## Bug reports

A useful debugger bug report normally includes:

- qwen-dap-mcp version,
- operating system and architecture,
- Node.js version,
- debugger / DAP adapter and version,
- target language and architecture,
- whether the failure affects local live debugging, remote debugging, postmortem, hang/differential tracing, HOL Guard/policy, or packaging,
- the smallest reliable reproduction you can share,
- relevant `QWEN_DAP_LOG_LEVEL=debug` stderr output with secrets and private paths removed,
- matching session IDs when multi-session behavior matters.

Only report live or remote targets that you are authorized to debug.

## License

By contributing, you agree that your contributions will be licensed under the repository's Apache-2.0 license.
