# Documentation

Use this page as the map for `qwen-dap-mcp`. The root [README](../README.md) is intentionally optimized for installation and project discovery; deeper behavior and adapter details live here.

## Start here

- [Root README](../README.md) — what the project does, quick install, debugger support, safety model, and development entry point.
- [Toolsets](toolsets.md) — the compact 14-tool agent surface versus the opt-in full DAP toolset.
- [Security policy](../SECURITY.md) — supported versions, trust boundaries, and vulnerability reporting.
- [Contributing](../CONTRIBUTING.md) — local development and contribution expectations.

## Debugger adapters

- [CodeLLDB on Windows](CODELLDB_WINDOWS.md) — discovery, launch/attach, Windows-specific setup, and minidump workflows.
- [LLVM lldb-dap](lldb-dap.md) — live native debugging, adapter discovery, remote attach, and core-file analysis.
- [GNU GDB DAP](gdb-dap.md) — GDB 14+ launch/attach, adapter discovery, remote attach, and core-file workflows.
- [Remote debugging](remote-debugging.md) — validated endpoints, allowlisting, `gdbserver`, and `lldb-server gdbserver`.

## Agent workflows

- [Differential debugging](differential-debugging.md) — compare known-good and failing stopped sessions while suppressing raw address noise.
- [Hang and deadlock debugging](hang-debugging.md) — bounded observation, all-thread evidence, wait classification, and conservative deadlock heuristics.
- [HOL Guard integration](hol-guard.md) — optional fail-closed policy gating for protected debugger side effects.
- [Toolsets](toolsets.md) — when to use the high-level agent tools and when the full low-level DAP surface is appropriate.

## Reproducibility and testing

- [Crash Lab](../examples/crash-lab/README.md) — deterministic native crash fixtures used by demos and smoke coverage.
- [Benchmark harness](../benchmark/README.md) — reproducible source-only vs raw-DAP vs qwen-dap-mcp comparisons without fabricated performance claims.
- [CI workflows](../.github/workflows/) — cross-version TypeScript checks plus real adapter, packaging, HOL Guard, remote, dump, and container smoke coverage.

## Releases and publishing

- [Publishing guide](publishing.md) — npm, MCP Registry, Qwen extension, and release workflow details.
- [Changelog](../CHANGELOG.md) — current and historical release changes.
- [v0.13.0 notes](v0.13.0.md) — historical release notes.
- [v0.12.0 notes](v0.12.0.md) — historical release notes.

## Machine-readable project metadata

- [`server.json`](../server.json) — MCP Registry server metadata.
- [`qwen-extension.json`](../qwen-extension.json) — Qwen Code extension metadata.
- [`llms.txt`](../llms.txt) — compact documentation map for language-model tooling.
- [`glama.json`](../glama.json) — Glama-compatible server metadata.

If a guide and the current implementation disagree, treat that as a documentation bug and open an issue with the version, adapter, platform, and reproduction details.
