# qwen-dap-mcp

**Give Qwen Code a real native debugger.**

A debugger-agnostic **Debug Adapter Protocol (DAP) → Model Context Protocol (MCP)** bridge for native runtime debugging, crash/hang analysis, multi-session debugging, remote native targets, and bounded autonomous fix/verify loops.

[![CI](https://github.com/SLP-DEV1/qwen-dap-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/SLP-DEV1/qwen-dap-mcp/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/SLP-DEV1/qwen-dap-mcp)](https://github.com/SLP-DEV1/qwen-dap-mcp/releases/latest)
[![npm](https://img.shields.io/npm/v/@slp-dev1/qwen-dap-mcp)](https://www.npmjs.com/package/@slp-dev1/qwen-dap-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@slp-dev1/qwen-dap-mcp)](https://www.npmjs.com/package/@slp-dev1/qwen-dap-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-published-5b5bd6)](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.SLP-DEV1%2Fqwen-dap-mcp)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

Published on **npm** as [`@slp-dev1/qwen-dap-mcp`](https://www.npmjs.com/package/@slp-dev1/qwen-dap-mcp) and in the official MCP Registry as `io.github.SLP-DEV1/qwen-dap-mcp`.

## Why this exists

Coding agents are good at reading and editing source, but native crashes and hangs often need evidence that only a debugger can provide: all-thread stacks, registers, locals, disassembly, exception state, memory, modules, wait states, and crash dumps.

`qwen-dap-mcp` exposes that evidence through MCP so Qwen Code and other MCP clients can reason about native failures without embedding a debugger protocol inside the agent.

### What it can do

- **Autonomous crash debugging** — diagnose → inspect source → propose fix → apply fix → build → reproduce → verify.
- **Native hang/deadlock triage** — `debug_this_hang` captures bounded all-thread stacks, classifies waits, identifies deadlock candidates, and correlates Pointer-Provenance v2 across threads.
- **Multi-session debugging** — create isolated DAP sessions and route every debugger call with an optional request-local `sessionId` without a process-global selector race.
- **Hardened remote native debugging** — connect GDB DAP to `gdbserver` and upstream `lldb-dap` to `lldb-server gdbserver` through validated TCP endpoints with loopback-first policy and explicit non-loopback allowlisting.
- **Real native debugger evidence** — stacks, registers, locals, exception state, modules, disassembly, memory, wait states, and source correlation.
- **CodeLLDB integration** — launch or attach to authorized local native targets through DAP.
- **Upstream LLVM lldb-dap integration** — first-class live debugging, remote gdb-server attach, and core-file inspection without treating lldb-dap as a CodeLLDB alias.
- **GNU GDB DAP integration** — first-class GDB 14+ launch, attach, hardened remote-target, and core-file support through `--interpreter=dap`.
- **HOL Guard policy enforcement** — optional fail-closed policy gating for adapter startup and mutating/executable DAP actions, with approval/reapproval flows, secret hashing, and exact adapter identity binding.
- **Runtime writer tracing** — `debug_find_writer` uses DAP data breakpoints/watchpoints to stop at the code that actually writes a suspicious value.
- **Windows minidumps / postmortem debugging** — open existing `.dmp` files and recover structured evidence.
- **Runtime root-cause backtracking** — follow suspicious values through bounded caller frames toward likely project-controlled producer candidates.
- **Verification fingerprints** — distinguish fixed, same-crash, changed-failure, and inconclusive reproductions.
- **Safety boundaries** — no arbitrary shell, source-writing primitive, general memory-write primitive, or hidden autonomous state inside the MCP server.

## 30-second example

```text
You: Debug why app.exe crashes with --repro

Qwen Code
  ↓
starts CodeLLDB or upstream lldb-dap through qwen-dap-mcp
  ↓
finds the native failure and first project-controlled frame
  ↓
correlates instruction operands ↔ registers ↔ locals
  ↓
backtracks runtime evidence toward a likely producer
  ↓
reads the relevant source
  ↓
applies a minimal evidence-backed fix
  ↓
builds and repeats the same reproduction
  ↓
verifies the original crash fingerprint no longer reproduces
```

## Install in Qwen Code

Install directly from the GitHub release:

```bash
qwen extensions install SLP-DEV1/qwen-dap-mcp
```

Or install the published scoped npm extension:

```bash
qwen extensions install @slp-dev1/qwen-dap-mcp
```

Then verify the extension and MCP server:

```text
/mcp
/skills
```

You should see the `qwen-dap-mcp` MCP server and bundled `native-runtime-debug` Skill.

The GitHub release archive is self-contained: runtime npm dependencies are bundled into `dist/index.js`.

### Use from another stdio MCP client

For MCP clients that accept a local stdio command, the published npm package can be launched with:

```bash
npx -y @slp-dev1/qwen-dap-mcp
```

A typical client configuration looks like:

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

Qwen Code is the primary integration and the path covered by the project's extension packaging and release validation. The MCP server itself communicates over local stdio.

### Distribution

| Channel | Identifier / install path |
| --- | --- |
| Qwen Code from GitHub | `qwen extensions install SLP-DEV1/qwen-dap-mcp` |
| Qwen Code from npm | `qwen extensions install @slp-dev1/qwen-dap-mcp` |
| npm | `@slp-dev1/qwen-dap-mcp` |
| Official MCP Registry | `io.github.SLP-DEV1/qwen-dap-mcp` |
| GitHub Releases | Self-contained extension archive |

## Debugger adapters

CodeLLDB, upstream LLVM `lldb-dap`, and GNU GDB DAP are first-class adapter paths. Existing CodeLLDB workflows remain supported; use `debug_this_crash(mode="lldb-dap")` / `debug_this_hang(mode="lldb-dap")` for LLVM's adapter or the corresponding `mode="gdb"` for GDB 14+. The `lldb-dap` path supports live launch/attach, hardened `lldb-server gdbserver` attach, plus read-only core-file analysis through `debug_this_crash(..., dumpAdapter="lldb-dap")`. GDB supports the equivalent hardened `gdbserver` workflow through `debug_attach_gdb_remote`.

LLDB discovery supports an explicit `adapterPath`, `LLDB_DAP_PATH`, canonical/versioned PATH binaries, LLVM toolchain directories / `LLVM_HOME`, and `xcrun --find lldb-dap` on macOS. GDB discovery supports `adapterPath`, `GDB_DAP_PATH`, `GDB_PATH`, `GDB_HOME`, and PATH with a GDB 14+ version gate. See [docs/lldb-dap.md](docs/lldb-dap.md), [docs/gdb-dap.md](docs/gdb-dap.md), and [docs/remote-debugging.md](docs/remote-debugging.md).

## HOL Guard integration

`qwen-dap-mcp` optionally integrates with [HOL Guard](https://github.com/hashgraph-online/hol-guard) 2.2+ as a defense-in-depth policy layer around debugger side effects.

When enabled, HOL Guard is consulted **before** a protected DAP request can allocate sequence state or cross `writeMessage()`, and **before** a debugger adapter process can be spawned. Mutating or executable actions such as `evaluate`, `launch`, `attach`, target control, state/memory writes, and breakpoint mutation are gated; read-only inspection such as stacks, scopes, variables, modules, source, disassembly, and memory reads stays on the fast path.

Approvals are bound to the effective workspace, privacy-sanitized DAP arguments, adapter command/arguments, canonical executable path, executable SHA-256, and a fingerprint of the effective adapter environment. Secret-bearing DAP fields and common credential CLI forms are replaced with per-process HMAC-SHA256 redaction markers before they enter the HOL Guard bridge, while the real debugger transport retains the original values. The selected Python interpreter and bundled bridge script are canonicalized and hash-bound, Python runs with `-I`, and `PYTHONPATH` / `PYTHONHOME` are stripped from the policy subprocess.

The integration supports HOL Guard `allow`, `warn`, `review`, `require-reapproval`, `sandbox-required`, and `block` outcomes. Review/reapproval decisions create real Approval Center requests, denied actions produce no DAP write or adapter spawn, and supported HOL Guard versions revalidate saved authority at the execution boundary.

Enable it after installing and initializing HOL Guard:

```bash
pipx install hol-guard
hol-guard init
export QWEN_DAP_MCP_HOL_GUARD=1
```

On Windows PowerShell:

```powershell
$env:QWEN_DAP_MCP_HOL_GUARD = "1"
```

For the full threat model, approval flow, exact identity binding, secret handling, TOCTOU hardening, compatibility behavior, and local smoke-test instructions, see [docs/hol-guard.md](docs/hol-guard.md).

## Roadmap

The roadmap is intentionally ordered around capabilities that make the bridge more useful to coding agents, not around exposing every debugger command. Planned scope may change as real adapter behavior and benchmark evidence improve.

| Release | Focus | Capabilities / status |
| --- | --- | --- |
| **v0.14** | GNU debugger + runtime provenance | First-class GDB DAP, `debug_find_writer`, structured MCP results/output schemas, symbol-health reporting, real GDB Linux smoke coverage |
| **v0.15** | Hangs and concurrency | `debug_this_hang`, bounded all-thread triage, deadlock/wait heuristics, Pointer-Provenance v2, deterministic native Hang Lab |
| **v0.16** | Remote + multi-session | In development: request-local isolated sessions, `debug_sessions`, hardened gdbserver/lldb-server attach, exact remote-host allowlisting, real remote Linux smoke coverage, cross-adapter session isolation |

Near-term design rule: keep the default agent surface compact and add high-level evidence workflows before adding raw debugger primitives.

### Structured agent results

The twelve default agent tools expose MCP v2 `outputSchema` contracts and return the same JSON evidence in both `structuredContent` and the legacy text content block. This keeps older clients readable while allowing MCP v2 hosts to validate and consume results without reparsing prose. Runtime snapshots also include `symbolHealth`, a deterministic `good | partial | poor | unknown` classification derived from resolved stack-frame names, source/line mappings, and explicit module symbol evidence when the adapter provides it. No synthetic numeric symbol score is used.

## Autonomous crash debugging

The high-level `debug_this_crash` workflow can drive a bounded autonomous debugging cycle:

```text
Diagnose
  ↓
select project frame
  ↓
operand ↔ register ↔ variable evidence
  ↓
call-chain / runtime provenance backtrack
  ↓
inspect source
  ↓
propose minimal fix
  ↓
apply fix
  ↓
build
  ↓
reproduce
  ↓
verify fingerprint + evidence quality
  ├── fixed → stop
  ├── same crash → revise fix
  ├── changed crash → re-baseline active failure
  ├── inconclusive → finish reproduction, do not edit
  └── budget exhausted / weak evidence → stop and report
```

Start an autonomous cycle:

```text
debug_this_crash(
  mode="codelldb",
  program="C:\\build\\app.exe",
  args=["--repro"],
  cwd="C:\\repo\\app",
  analysis={
    projectRoots:["C:\\repo\\app"],
    projectModules:["app.exe"],
    callerDepth:3
  },
  workflow={
    stage:"autonomous",
    maxIterations:3
  }
)
```

The first call returns `workflow.autonomousAgent` with explicit serializable state, dependency-aware `nextActions`, root and active crash fingerprints, bounded history, runtime backtracking evidence, verification quality, and stop/continue status.

The server keeps no hidden autonomous-loop memory. Qwen Code performs requested source edits, builds, tests, and source-control operations through its normal authorized tools.

### Autonomous statuses

| Status | Meaning |
| --- | --- |
| `needs-evidence` | Do not patch yet; collect stronger project/caller evidence |
| `needs-fix` | Evidence is strong enough for the first bounded source fix |
| `retry-fix` | The same active crash survived; revise the fix |
| `needs-reproduction` | Verification stopped too early; finish the original reproduction |
| `changed-failure` | A different crash appeared; preserve the root fingerprint and re-baseline |
| `fixed` | The complete reproduction ended cleanly |
| `budget-exhausted` | Maximum automatic fix attempts reached |
| `blocked` | Trustworthy evidence for another autonomous edit is unavailable |

## Hang and concurrency triage (v0.15)

`debug_this_hang` is the high-level workflow for a process that appears stuck, deadlocked, permanently waiting, or spinning. It can inspect the current configured session or own a CodeLLDB/lldb-dap/GDB launch/attach, observe it for a bounded interval, pause the target when necessary, then collect all-thread evidence.

```text
debug_this_hang(
  mode="codelldb",
  request="launch",
  program="C:\\build\\app.exe",
  args=["--repro-hang"],
  cwd="C:\\repo\\app",
  observeMs=5000,
  analysis={projectRoots:["C:\\repo\\app"]}
)
```

The result includes:

- `observation` — whether the target timed out, stopped, exited, or terminated during the bounded observation window,
- `allThreadTriage` — bounded stacks plus recognized wait/runnable state for every captured thread,
- `deadlock` — conservative global classification such as `deadlock-candidate`, `lock-contention`, `global-wait`, `io-wait`, or `mixed-wait`,
- `pointerProvenance` — Pointer-Provenance v2 groups equal pointer/memory-reference values across thread/frame boundaries,
- `nextActions` and explicit limitations.

Generic DAP does not expose a portable lock-owner graph, so stack/wait evidence alone never sets `cycleProven=true`. A `deadlock-candidate` is evidence consistent with deadlock, not proof. Normal condition-variable/event/semaphore/timer worker waits are not promoted to deadlock by themselves. Equal cross-thread pointer addresses are alias evidence, not proof of lock ownership or causality.

If an existing stop is only thread-local, `debug_this_hang` does not silently treat it as a process-wide freeze; it attempts bounded pauses for remaining threads before triage. Launch, attach, and pause continue through the same built-in/HOL Guard policy boundaries as the rest of the debugger.

See [docs/hang-debugging.md](docs/hang-debugging.md) for the full evidence model, modes, safety semantics, and deterministic Hang Lab.

## Multi-session and remote debugging (v0.16)

`debug_sessions` manages isolated debugger sessions while preserving `default` for callers that do not pass `sessionId`:

```text
debug_sessions(action="create", sessionId="remote-gdb")
debug_sessions(action="create", sessionId="remote-lldb")

debug_start_gdb(sessionId="remote-gdb")
debug_start_lldb_dap(sessionId="remote-lldb")
```

Every other `debug_*` tool receives an optional `sessionId`. Selection is bound to the lifetime of that async MCP request using `AsyncLocalStorage`; there is no process-global selected-session variable that concurrent calls can overwrite. Each session owns its own DAP transport, lifecycle gate, debugger state, event history, watchpoints, timeout state, postmortem flag, and HOL Guard context. Active sessions cannot be closed while a routed request is executing.

Remote attach helpers are available in the `full` toolset:

```text
debug_attach_gdb_remote(
  sessionId="remote-gdb",
  host="127.0.0.1",
  port=1234,
  program="/local/symbols/app"
)

debug_attach_lldb_dap_remote(
  sessionId="remote-lldb",
  host="127.0.0.1",
  port=1235,
  program="/local/symbols/app"
)
```

Loopback is permitted by default. Exact non-loopback hosts must be listed in `QWEN_DAP_MCP_REMOTE_DEBUG_HOSTS`. Prefer SSH/VPN tunneling rather than exposing a native debug server directly. GDB accepts only a validated TCP endpoint, not arbitrary target syntax. For lldb-dap 18 compatibility, the MCP generates exactly one `gdb-remote host:port` attach command from the validated endpoint; user-provided LLDB commands are not accepted.

Both paths are covered by real Linux CI against an actual `gdbserver` / `lldb-server gdbserver`, including breakpoint, continue, stack, and variable evidence. See [docs/remote-debugging.md](docs/remote-debugging.md) for the full workflow and threat model.

## Intelligent diagnosis

The diagnosis layer separates raw debugger facts from inference and reports:

- `classification` — current crash/stop family,
- `faultLocation` — literal debugger stop frame,
- `projectFrame` — first likely application-controlled frame,
- `frameSelection` — scored stack-frame evidence and runtime/system exclusions,
- `operandAnalysis` — instruction operands, referenced registers, memory operands, and register↔local bindings,
- `callChain` — project callers, runtime boundaries, repeated frames, and provenance clues,
- `hypotheses` — ranked explanations with explicit confidence,
- `fixWorkflow` — candidate source location and narrow evidence-backed fix direction,
- `verificationBaseline` — compact failure signature,
- `rootCauseBacktrack` — bounded runtime provenance toward producer candidates,
- `verificationQuality` — debugger-evidence strength after verification.

A high project-frame score means “likely project code”, not “proven root cause”. Causal claims should still be tied to exception state, operands/registers/locals, caller provenance, source confirmation, and reproduction.

## Crash dumps / minidumps

Open and diagnose an existing dump in one high-level call:

```text
debug_this_crash(
  mode="dump",
  dumpPath="C:\\crashes\\app.dmp",
  program="C:\\build\\app.exe",
  sourceMap={"D:/agent/_work/project/src":"C:/work/project/src"},
  analysis={projectRoots:["C:\\repo\\app"]}
)
```

A dump session is frozen/read-only. A historical dump can establish evidence for the captured failure, but a source fix still needs a rebuilt live reproduction or a newly generated dump for verification.

## Architecture

```text
Qwen Code / MCP client
        │
        │ MCP over stdio
        ▼
   qwen-dap-mcp
        │
        ├── request-local session registry/router
        ├── isolated lifecycle/concurrency guards per session
        ├── bounded DAP snapshot + all-thread capture layer
        ├── crash classification
        ├── wait/deadlock heuristics
        ├── Pointer-Provenance v2 cross-thread correlation
        ├── project-frame scoring
        ├── operand/register/local correlation
        ├── call-chain provenance
        ├── runtime root-cause backtracking
        ├── verification fingerprints + quality scoring
        └── autonomous action state machine
        │
        │ DAP over local stdio
        ▼
 CodeLLDB / lldb-dap / GDB DAP adapter
        │
        ├── authorized local live target
        ├── crash dump / core file
        └── validated TCP remote endpoint
                    │
                    └── gdbserver / lldb-server gdbserver
```

The MCP server has no HTTP listener. Debugger adapters are spawned locally without a shell and communicate with the MCP over stdio. Remote debug-server connections originate from the local debugger adapter only after endpoint validation and authorization.

## MCP toolsets

The default `agent` toolset deliberately exposes only the twelve high-level/session-management tools below so coding agents do not spend context on every low-level debugger primitive. Set `QWEN_DAP_MCP_TOOLSET=full` when you intentionally need the complete manual DAP surface or explicit remote attach helpers. See [docs/toolsets.md](docs/toolsets.md).

### Default `agent` tools

| Tool | Purpose |
| --- | --- |
| `debug_this_crash` | High-level live/CodeLLDB/lldb-dap/dump diagnosis, verification, and autonomous orchestration |
| `debug_this_hang` | High-level hang/deadlock workflow with bounded all-thread triage, wait heuristics, and Pointer-Provenance v2 |
| `debug_diagnose_stop` | Intelligent diagnosis of the current stopped state |
| `debug_source_disassembly` | Fault correlation plus project-frame instruction/operand/register/local context |
| `debug_find_writer` | Temporarily watch a suspicious value and stop at its immediate runtime writer |
| `debug_run_to_stop` | Launch/attach and race-safely wait for stop/exit/termination |
| `debug_open_dump` | Open a native core/minidump for read-only postmortem inspection |
| `debug_snapshot` | Capture a bounded raw runtime snapshot |
| `debug_status` | Read current routed session status |
| `debug_continue` | Resume an authorized live target to the next stop |
| `debug_disconnect` | Disconnect and tear down the routed debugger session |
| `debug_sessions` | Create, list, or close isolated debugger sessions |

The `full` toolset additionally exposes manual breakpoint/watchpoint management, stepping, evaluation, threads/stacks/scopes/variables, modules, disassembly, bounded memory reads, exception controls, generic DAP launch/attach, CodeLLDB / lldb-dap / GDB lifecycle primitives, and the hardened `debug_attach_gdb_remote` / `debug_attach_lldb_dap_remote` helpers.

## Verification model

Verification deliberately separates debugger evidence from external guarantees such as build success, project tests, and exact reproduction inputs.

Verdicts:

- `fixed` — complete reproduction reached a clean successful terminal outcome,
- `not-fixed` — same crash family/signature reproduced,
- `changed-failure` — execution still crashed but the active failure signature changed,
- `inconclusive` — insufficient evidence to claim success or failure.

A breakpoint, entry stop, pause, step, or configured/first-chance exception stop is deliberately **not** proof of a fix.

## Real Windows validation

The repository contains real CodeLLDB smoke workflows on Windows. The minidump smoke path:

1. compiles an MSVC C++ crash target with PDB symbols,
2. intentionally triggers an access violation,
3. writes a real `.dmp` with `MiniDumpWriteDump`,
4. starts real CodeLLDB,
5. opens the dump through DAP,
6. verifies stack/source/register/module/disassembly recovery,
7. runs intelligent project-frame diagnosis,
8. validates autonomous state/fingerprint/action generation from the real dump.

## Development

Requirements:

- Node.js 20+
- npm

Run the complete check:

```bash
npm ci --ignore-scripts
npm run check
```

`npm run check` performs TypeScript build, tests, and extension-package staging. CI runs Node 20 and 22.

The deterministic native Hang Lab can also be built and reproduced directly:

```bash
npm run demo:hang:build -- deadlock
npm run demo:hang:repro -- deadlock
```

The hang repro succeeds only when the process remains blocked until its bounded timeout.

## Safety model

- local stdio MCP transport only,
- no built-in remote HTTP debugger service,
- request-local multi-session routing; no process-global selected-session race,
- bounded session registry with close protection while routed requests are active,
- remote debugger endpoints restricted to validated TCP host/port values,
- loopback remote debug hosts allowed by default; non-loopback hosts require exact `QWEN_DAP_MCP_REMOTE_DEBUG_HOSTS` allowlisting,
- arbitrary GDB target syntax and user-supplied LLDB attach commands are not exposed,
- SSH/VPN tunneling recommended instead of direct native debug-server exposure,
- no arbitrary shell/source-writing MCP primitive,
- no arbitrary memory-write MCP primitive,
- optional HOL Guard 2.2+ policy gate for adapter spawn and mutating/executable DAP actions,
- HOL Guard approvals bound to canonical adapter identity, executable hash, workspace, arguments, and environment fingerprint,
- secret-bearing DAP/adapter values are HMAC-redacted with a per-process key before entering the HOL Guard policy bridge,
- HOL Guard Python/bridge identities are pinned, Python runs in isolated mode, and inherited Python import paths are stripped,
- `debug_this_hang` launch/attach/pause operations use the same guarded DAP boundaries,
- deadlock/wait classifications are bounded heuristics and never fabricate a lock-owner cycle,
- Pointer-Provenance v2 treats cross-thread address equality as correlation evidence, not ownership proof,
- no automatic source rollback without external evidence,
- live/remote attach intended only for authorized targets,
- postmortem dumps frozen against execution-control operations,
- bounded autonomous fix budget with deterministic stop conditions,
- weak/inconclusive evidence does not trigger another source edit,
- first-chance/configured exception stops are not automatically treated as fatal.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidance.

If the project is useful to you, starring the repository helps other Qwen Code and MCP users discover it.

## License

Apache License 2.0. See [LICENSE](LICENSE).
