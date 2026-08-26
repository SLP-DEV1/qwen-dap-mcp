# CI architecture

The project uses three CI tiers so pull requests get fast feedback without dropping real-debugger coverage.

## 1. Fast CI

`.github/workflows/ci.yml` runs on every pull request and on `main`.

It covers:

- Node.js 20 and 22,
- TypeScript build,
- unit/regression tests,
- extension staging,
- deterministic Crash Lab and Hang Lab smoke cases,
- npm package-shape validation.

This is the default required feedback loop. It intentionally does not install native debuggers, HOL Guard, Qwen Code, or build the Docker image.

## 2. Targeted integration smokes

Expensive integration checks run only when their relevant paths change:

- `native-smoke.yml` selects CodeLLDB, Windows minidump, GDB/gdbserver, lldb-dap/lldb-server, differential-runtime, and multi-session remote suites from the PR diff.
- `hol-guard-compat.yml` runs only for HOL Guard / policy-boundary changes, plus its weekly compatibility schedule.
- `extension-package-smoke.yml` runs for Qwen extension/package integration changes.
- `container-smoke.yml` runs for Docker/server/container-facing changes.

All targeted workflows use `concurrency` with `cancel-in-progress`, so an updated PR does not keep obsolete expensive runs alive.

`native-smoke.yml` also runs the complete native suite on its weekly schedule and when started manually.

## 3. Release gate

`release-extension.yml` calls all reusable integration workflows before the release job can publish:

1. full native debugger smoke coverage,
2. HOL Guard compatibility,
3. Qwen extension archive installation,
4. container build,
5. only then the existing build, GitHub release verification, published-extension install check, and npm/MCP Registry publication handoff.

A path-selected PR therefore does not need to execute every native adapter on every edit, while a release still cannot proceed without the complete real-integration gate.

## Rerunning failures

Each native suite remains a separately named job inside `Native Debugger Smoke`, so a failed CodeLLDB, GDB, LLDB, dump, differential, or multi-session job is visible and can be rerun independently from the Actions UI.

For local validation, run:

```bash
npm ci --ignore-scripts
npm run check
```
