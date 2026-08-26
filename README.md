# qwen-dap-mcp

**Give coding agents a real native debugger.**

`qwen-dap-mcp` is a local **Debug Adapter Protocol (DAP) → Model Context Protocol (MCP)** bridge for native crash debugging, hang/deadlock triage, crash dumps, differential runtime analysis, remote targets, and bounded fix/verify workflows.

Built for **Qwen Code**, usable from any stdio MCP client, and designed to expose debugger evidence without turning MCP into a general-purpose shell.

[![CI](https://github.com/SLP-DEV1/qwen-dap-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/SLP-DEV1/qwen-dap-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/SLP-DEV1/qwen-dap-mcp)](https://github.com/SLP-DEV1/qwen-dap-mcp/releases/latest)
[![npm](https://img.shields.io/npm/v/@slp-dev1/qwen-dap-mcp)](https://www.npmjs.com/package/@slp-dev1/qwen-dap-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@slp-dev1/qwen-dap-mcp)](https://www.npmjs.com/package/@slp-dev1/qwen-dap-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-published-5b5bd6)](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.SLP-DEV1%2Fqwen-dap-mcp)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![GitHub stars](https://img.shields.io/github/stars/SLP-DEV1/qwen-dap-mcp?style=social)](https://github.com/SLP-DEV1/qwen-dap-mcp/stargazers)

**[Quick start](#quick-start) · [Capabilities](#what-it-does) · [Debugger support](#debugger-support) · [Safety](#safety-by-design) · [Docs](docs/README.md) · [Contributing](CONTRIBUTING.md)**

## Why this exists

Coding agents can read source and propose patches, but native failures often cannot be diagnosed reliably from source alone. The useful evidence lives at runtime: thread stacks, registers, locals, disassembly, exception state, modules, memory, wait states, symbols, and crash dumps.

`qwen-dap-mcp` makes that evidence available through MCP and adds agent-oriented workflows on top of raw debugger primitives:

- **Evidence first** — inspect the actual failing process instead of guessing from source.
- **High-level workflows** — crash, hang, differential, writer-tracing, dump, and verification tools are designed for agents rather than humans driving a debugger console.
- **Bounded automation** — autonomous fix/verify state is explicit, serializable, iteration-limited, and re-checks the original reproduction.
- **Small default surface** — the normal agent toolset stays compact while advanced low-level DAP tools remain opt-in.
- **Local by default** — the MCP server communicates over stdio and debugger adapters run locally unless you explicitly configure a validated remote target.

## Quick start

### Qwen Code

Install directly from GitHub:

```bash
qwen extensions install SLP-DEV1/qwen-dap-mcp
```

Or install the published npm package:

```bash
qwen extensions install @slp-dev1/qwen-dap-mcp
```

Then verify the extension:

```text
/mcp
/skills
```

You should see the `qwen-dap-mcp` server and the bundled `native-runtime-debug` skill.

### Any stdio MCP client

```bash
npx -y @slp-dev1/qwen-dap-mcp
```

Typical configuration:

```json
{
  "mcpServers": {
    "qwen-dap-mcp": {
      "command": "npx",
      "args": ["-y", "@slp-dev1/qwen-dap-mcp"]
    }
  }
}
```

CLI discovery is available without starting the stdio server:

```bash
qwen-dap-mcp --help
qwen-dap-mcp --version
```

## 30-second example

```text
You: Debug why app.exe crashes with --repro

Coding agent
  ↓
qwen-dap-mcp starts a DAP debugger
  ↓
captures the native failure + project-controlled frame
  ↓
correlates stack + registers + locals + disassembly
  ↓
backtracks runtime evidence toward the likely producer
  ↓
agent applies a minimal source fix
  ↓
builds and repeats the original reproduction
  ↓
verifies whether the original crash fingerprint is gone
```

The MCP server supplies debugger evidence and bounded workflow state. Source editing, builds, tests, and source-control operations stay with the coding agent's normal authorized tools.

## What it does

| Problem | Agent-oriented capability |
| --- | --- |
| Native crash | Diagnose a stopped process, identify project frames, collect runtime evidence, and drive bounded fix/verify loops |
| Hang or deadlock | Observe, pause when needed, capture all-thread stacks, classify waits, and surface conservative deadlock candidates |
| Good run vs bad run | Compare stopped sessions semantically while suppressing raw ASLR/address noise |
| Suspicious value | Trace real writers with data breakpoints/watchpoints and bounded temporal tracing |
| Crash dump | Inspect Windows minidumps and supported LLDB/GDB postmortem targets without launching the failed program |
| Remote native target | Attach through validated `gdbserver` / `lldb-server gdbserver` endpoints with loopback-first policy |
| Multiple targets | Keep isolated DAP sessions and route requests by `sessionId` |
| Agent safety | Keep the default surface compact and optionally gate executable/mutating DAP actions with HOL Guard |

### Default agent tool surface

The default toolset intentionally exposes 14 high-signal tools:

| Tool | Purpose |
| --- | --- |
| `debug_this_crash` | High-level native crash diagnosis and bounded autonomous verification |
| `debug_this_hang` | High-level hang/deadlock triage |
| `debug_compare_runs` | Semantic comparison of baseline and failing stopped sessions |
| `debug_trace_value` | Bounded temporal tracing of a suspicious value |
| `debug_diagnose_stop` | Diagnose the current debugger stop |
| `debug_source_disassembly` | Correlate source with nearby native instructions |
| `debug_find_writer` | Stop at the code that writes a watched value |
| `debug_run_to_stop` | Continue/launch toward a bounded meaningful stop |
| `debug_open_dump` | Open supported postmortem dump/core targets |
| `debug_snapshot` | Capture structured runtime evidence |
| `debug_status` | Inspect debugger/session state |
| `debug_continue` | Continue the active target |
| `debug_disconnect` | Cleanly end a debugger session |
| `debug_sessions` | Create, inspect, and remove isolated sessions |

Need raw stacks, scopes, variables, memory, modules, breakpoints, evaluation, stepping, or adapter-specific controls? See the opt-in **full toolset** in [docs/toolsets.md](docs/toolsets.md).

## Debugger support

| Adapter / target | Supported use |
| --- | --- |
| **CodeLLDB** | Local native launch/attach and Windows minidump workflows |
| **LLVM `lldb-dap`** | Native launch/attach, core-file inspection, and `lldb-server gdbserver` remote attach |
| **GNU GDB 14+ DAP** | Native launch/attach, core-file workflows, and hardened `gdbserver` remote attach |

Adapter discovery, prerequisites, and platform-specific setup are documented in [docs/README.md](docs/README.md).

## More than raw DAP

Raw DAP is intentionally low level. `qwen-dap-mcp` keeps raw debugger access available in the full toolset, but its default surface focuses on workflows an agent can reason about directly.

| | Source only | Raw DAP | qwen-dap-mcp agent tools |
| --- | :---: | :---: | :---: |
| Runtime debugger evidence | — | ✓ | ✓ |
| High-level crash diagnosis | — | — | ✓ |
| All-thread hang triage | — | manual | ✓ |
| Good-vs-bad semantic diff | — | manual | ✓ |
| Explicit bounded fix/verify state | — | — | ✓ |
| Verification fingerprinting | — | — | ✓ |

## Safety by design

A debugger can execute and mutate target state, so the bridge treats that power explicitly.

- No arbitrary shell tool is exposed by the MCP server.
- No source-writing primitive is exposed by the MCP server.
- No general memory-write primitive is part of the default agent surface.
- Remote endpoints are validated and non-loopback access requires explicit allowlisting.
- Autonomous workflow state is explicit rather than hidden inside a background loop.
- Optional **HOL Guard 2.2+** integration can fail closed before protected adapter startup or executable/mutating DAP actions cross the debugger boundary.

Read the full policy and threat model in [docs/hol-guard.md](docs/hol-guard.md) and [SECURITY.md](SECURITY.md).

## Repro labs and benchmark harness

The repository includes deterministic native fixtures so behavior can be tested instead of demonstrated only with screenshots:

```bash
npm run demo:build -- null-pointer
npm run demo:repro -- null-pointer

npm run demo:hang:build -- deadlock
npm run demo:hang:repro -- deadlock
```

[`benchmark/`](benchmark/) also contains a reproducible comparison harness for `source-only`, `dap-raw`, and `qwen-dap-mcp` workflows. It deliberately ships without invented performance numbers; publishable results should record the exact model, settings, commit, reproduction, raw outcome, and verification status.

## Documentation

Start with the [documentation index](docs/README.md).

| Topic | Guide |
| --- | --- |
| CodeLLDB on Windows | [docs/CODELLDB_WINDOWS.md](docs/CODELLDB_WINDOWS.md) |
| LLVM `lldb-dap` | [docs/lldb-dap.md](docs/lldb-dap.md) |
| GNU GDB DAP | [docs/gdb-dap.md](docs/gdb-dap.md) |
| Remote debugging | [docs/remote-debugging.md](docs/remote-debugging.md) |
| Hang/deadlock analysis | [docs/hang-debugging.md](docs/hang-debugging.md) |
| Differential debugging | [docs/differential-debugging.md](docs/differential-debugging.md) |
| Agent vs full toolsets | [docs/toolsets.md](docs/toolsets.md) |
| HOL Guard integration | [docs/hol-guard.md](docs/hol-guard.md) |
| Publishing / releases | [docs/publishing.md](docs/publishing.md) |

## Development

Requirements: **Node.js 20+**.

```bash
git clone https://github.com/SLP-DEV1/qwen-dap-mcp.git
cd qwen-dap-mcp
npm ci
npm run check
```

`npm run check` builds TypeScript, runs the test suite, and validates the self-contained Qwen extension package. CI additionally exercises native crash/hang fixtures, adapter-specific real smoke tests, package output, HOL Guard compatibility, and the container build.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Distribution

Published as:

- npm: `@slp-dev1/qwen-dap-mcp`
- MCP Registry: `io.github.SLP-DEV1/qwen-dap-mcp`
- Qwen Code extension: `qwen extensions install SLP-DEV1/qwen-dap-mcp`
- GitHub Releases: self-contained extension archives

Current release details are in [CHANGELOG.md](CHANGELOG.md) and [GitHub Releases](https://github.com/SLP-DEV1/qwen-dap-mcp/releases).

## Contributing

Bug reports, reproducible native failure cases, adapter compatibility findings, documentation fixes, and focused feature proposals are welcome. Please keep additions evidence-driven and prefer high-level agent workflows over expanding the default surface with raw debugger commands.

If this project saves you a debugging session, **consider starring the repository** — it helps other MCP and coding-agent users discover it.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
