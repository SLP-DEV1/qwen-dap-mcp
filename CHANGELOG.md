# Changelog

All notable prototype milestones are documented here.

## 0.9.0 - 2026-08-26

### Added

- Intelligent project-frame selection for `debug_this_crash`, `debug_diagnose_stop`, and `debug_source_disassembly` instead of assuming the raw `stack[0]` frame is application code.
- Bounded frame scoring using explicit `analysis.projectRoots` / `projectModules`, the launched executable, source information, and conservative runtime/system-module heuristics.
- `projectFrame` and `frameSelection` diagnosis sections that preserve the raw debugger fault frame separately from the first likely project-controlled frame and explain why each frame was scored or skipped.
- Operand ↔ register ↔ pointer-local correlation for x86/x64 and common ARM register naming, including register-alias normalization, memory-operand detection, and numeric local/register value matching.
- `likelyFaultOperand.faultingFrame` so a selected non-top project frame is explicitly distinguished from the literal faulting machine frame.
- Bounded `callChain` analysis with project callers, runtime-boundary depth, repeated recursion/re-entry candidates, pointer-like value provenance, and an evidence-ranked root-cause candidate.
- Conservative caller-provenance confidence: distinctive poison/debug values can provide strong lifetime evidence while repeated null values remain low confidence because unrelated pointers may all be null.
- `fixWorkflow` with an evidence-backed candidate source location and the phases diagnose → fix → rebuild → reproduce → verify.
- Reusable `verificationBaseline` signatures for the original crash family, selected project location, hypothesis kinds, and suspicious values.
- `debug_this_crash(..., workflow={stage:"verify", baseline:...})` verification with `fixed`, `not-fixed`, `changed-failure`, and `inconclusive` verdicts.
- Regression coverage for Windows-runtime frame skipping, operand/register/local correlation, caller provenance, same-crash reproduction, clean-exit verification, and conservative non-crash verification behavior.

### Changed

- Existing high-level crash tools became smarter without adding another MCP tool or a general command executor.
- Source edits and rebuilds remain the responsibility of the host coding agent/project build system; qwen-dap-mcp supplies debugger evidence, fix direction, reproduction state, and verification comparison.
- A clean reproduced process exit with code 0 is strong fix evidence; breakpoint, entry, pause, step, or other non-crash stopped states are deliberately `inconclusive` until the complete original scenario reaches a terminal outcome.
- Project-frame selection confidence means “likely project code”, not proof that the selected frame caused the bug.
- Instructions from a selected non-top project frame are treated as call-site/context evidence rather than automatically as the literal crash instruction.
- Both bundled `native-runtime-debug` Skill copies and MCP server instructions now teach project-frame reasoning, operand/data-flow interpretation, bounded caller provenance, and the verification-baseline loop.

### Verified

- Node.js 20 and 22 build/test/package matrix passes on the final feature head and merged `main`.
- Generated self-contained Qwen extension archive builds and installs successfully.
- Real Windows CodeLLDB live DAP smoke passes against an MSVC-built native target.
- Real Windows minidump smoke generates a native `.dmp` with PDB symbols, reopens it through real CodeLLDB, and validates the v0.9 project-frame selection, intelligent diagnosis, fix workflow, and verification baseline against the recovered debugger state.

## 0.8.0 - 2026-08-26

### Added

- Agent-first `debug_this_crash` workflow with four modes:
  - `current` diagnoses an already stopped live or postmortem session,
  - `live` runs an initialized generic DAP launch/attach to the next stop or process exit,
  - `codelldb` discovers/starts CodeLLDB, launches a local native executable and diagnoses the next stop in one MCP call,
  - `dump` opens a native core/minidump and immediately diagnoses the recovered frozen state.
- `debug_diagnose_stop` for bounded automatic crash/stop analysis with classification, confidence, debugger evidence, suspicious values, ranked hypotheses and suggested next checks.
- `debug_source_disassembly` for explicit source-location and instruction-pointer correlation, including exact/nearest instruction and nearby machine-code context.
- `debug_run_to_stop` composite live-debugging primitive that arms listeners before launch/attach, waits race-safely for `stopped`, `exited`, or `terminated`, and captures a bounded snapshot on stops.
- Native crash-family classification for access violations / `EXC_BAD_ACCESS`, `SIGSEGV`, stack overflow, divide-by-zero / `SIGFPE`, illegal instruction / `SIGILL`, abort/assert failures, heap-corruption style diagnostics, generic exceptions/signals, and non-crash debugger stops.
- Evidence collection for null-like pointer candidates and common debug-allocator poison patterns without treating those clues as unconditional proof of root cause.
- Structured source/disassembly correlation and root-cause hypotheses for null dereferences, invalid object lifetime, invalid memory access, stack exhaustion, zero divisors, bad control flow, explicit abort/assert paths, heap corruption and generic reported exceptions.
- Regression tests for diagnosis classification, poison/null evidence, non-crash stops, exception preservation, source/disassembly nearest-instruction fallback, and the run-to-stop workflow.

### Changed

- Refactored the CodeLLDB dump-opening sequence into a reusable `openDump()` workflow so raw postmortem inspection and `debug_this_crash(mode="dump")` share exactly the same frozen-session semantics.
- Updated server instructions and both copies of the bundled `native-runtime-debug` Skill to prefer high-level diagnosis tools before manual low-level DAP orchestration.
- Reworked the README around the agent-first v0.8 workflow, diagnosis output model, source/disassembly reasoning and evidence-bounded root-cause claims.
- High-level composite workflows remain protected by the existing reentrant lifecycle gate so an unrelated MCP request cannot reset/replace the shared adapter while diagnosis is in progress.

### Fixed

- Fixed structured logger cycle detection so repeated non-circular shared object references are serialized normally instead of being mislabeled as `[Circular]`; real ancestor cycles, including cyclic `Error.cause`, remain safely bounded.

### Verified

- Node.js 20 and 22 build/test/package matrix passes.
- Real Windows CodeLLDB live DAP smoke passes against an MSVC-built C++ target.
- Real Windows minidump smoke passes after generating a native crash dump with PDB symbols and reopening it through CodeLLDB.
- Generated self-contained extension archive installs successfully in Qwen Code.

## 0.7.1

### Fixed

- Serialized shared DAP lifecycle mutations across `start`, `launch`, `attach`, `disconnect`, `reset`, and crash-dump opening so concurrent MCP requests cannot race the same adapter/session state.
- Made compound lifecycle operations reentrant, allowing internal flows such as `start -> reset` and `open dump -> start -> attach` without self-deadlock.
- Hardened adapter shutdown so a process that was signalled but has not actually exited is escalated to `SIGKILL` instead of being mistaken for an exited process.
- Added centralized local filesystem validation for CodeLLDB program images, crash dumps, explicit adapter paths, and local adapter working directories.
- Relative paths, including legitimate `..` segments, are normalized with the platform path resolver instead of being blanket-blocked.
- Missing files/directories and wrong path kinds now fail before contacting the debugger with contextual error messages.

### Added

- Structured stderr-only logging with `debug`, `info`, `warn`, `error`, and `silent` levels controlled by `QWEN_DAP_LOG_LEVEL`.
- DAP lifecycle, adapter process, protocol, and local-path validation diagnostics routed through the centralized logger without contaminating MCP stdout.
- Regression coverage for lifecycle concurrency/reentrancy, forced adapter termination, path normalization and validation, CodeLLDB launch validation, logger filtering, and silent mode.

### Security / compatibility

- Generic DAP `configuration` objects remain adapter-defined and are not forced through local filesystem checks, preserving support for remote and custom adapters.
- The MCP transport remains stdio-only with no HTTP listener; bearer-token authentication is therefore not applicable to the current transport.
- Closes the hardening work tracked in issue #1.

## 0.7.0

### Added

- `debug_open_dump` for read-only postmortem analysis of LLDB-supported core/minidump files through CodeLLDB.
- CodeLLDB dump configuration using the documented `target create -c <core>` attach flow with no live process attach.
- Optional matching executable and `sourceMap` support for symbol/source resolution.
- Immediate bounded snapshot after opening a dump, including stack, locals/registers, modules and disassembly when available.
- Dedicated Windows minidump fixture that writes a real `.dmp` with `MiniDumpWriteDump` after an intentional access violation.
- Real CodeLLDB Windows dump CI that opens the generated minidump and validates thread/stack/source/instruction/module/disassembly recovery.
- Postmortem workflow guidance in the bundled `native-runtime-debug` Skill.

### Safety / semantics

- Dump sessions are explicitly treated as frozen read-only postmortem state.
- The Skill tells agents not to continue, step, pause, or use watchpoint workflows on a dump session.
- Verification after a dump diagnosis still requires rebuilding and reproducing the original scenario or analyzing a newly generated dump.

## 0.6.0

### Added

- Self-contained Qwen Code extension packaging with a bundled `dist/index.js`.
- Release staging validation that rejects unresolved npm runtime imports and symlinks.
- GitHub Actions release workflow that builds and tests the bridge, creates a generic `qwen-dap-mcp.tar.gz`, installs that archive with Qwen Code, and publishes it as the single GitHub Release asset.
- Reproducible Qwen Code archive smoke test pinned to Qwen Code 0.22.0.

### Changed

- `npm run check` now also builds the release-ready extension staging directory.
- Release archives no longer require `npm install` after download because runtime dependencies are bundled into the MCP server entrypoint.
- Generated `release/` output is ignored by git.

### Installation target

After the v0.6.0 GitHub Release is published, Qwen Code can install the extension directly from the repository release with:

```text
qwen extensions install SLP-DEV1/qwen-dap-mcp
```

The release workflow validates that the produced archive can be installed by Qwen Code before publishing it.

## 0.5.0

### Added

- Native Qwen Code extension manifest (`qwen-extension.json`).
- Bundled `native-runtime-debug` Qwen Skill.
- Project-local copy of the Skill for repository development.
- Evidence-driven crash/exception diagnosis workflow.
- Unexpected-write workflow using real DAP data breakpoints/watchpoints.
- Fix verification guidance: rebuild, reproduce, inspect, and run normal tests.
- Extension/Skill consistency and packaging tests.

### Changed

- npm package file list now includes the Qwen extension manifest and bundled Skills.
- README now documents extension linking and explicit Skill invocation.

## 0.4.0

### Added

- Conditional, hit-count, column, and log source-breakpoint fields.
- Function breakpoints.
- Instruction breakpoints.
- Data-breakpoint discovery and data breakpoints/watchpoints.
- Exception breakpoint configuration.
- DAP pause support.

### Verified with real CodeLLDB on Windows

- Conditional source breakpoint verified.
- `main` function breakpoint verified.
- Instruction breakpoint verified.
- Hardware/data watchpoint stopped when `counter` changed from 35 to 42.
- CodeLLDB advertised `read`, `write`, and `readWrite` watchpoint modes.
- Windows pause behavior observed as raw `DebugBreak` / exception `0x80000003`; bridge preserves that raw stop while annotating `requestedAction: "pause"`.

## 0.3.0

### Added

- `debug_modules`.
- `debug_disassemble`.
- bounded `debug_read_memory`.
- `debug_exception_info`.
- agent-friendly `debug_snapshot` combining thread, stack, top frame, locals, registers, disassembly, optional modules, and exception data.

### Verified with real CodeLLDB on Windows

- 5 loaded modules in the native smoke target session.
- 11 disassembled instructions around the instruction pointer.
- 16 readable executable-memory bytes.
- local variables `delta` and `counter`.
- register scope capture.

## 0.2.0

### Added

- First-class CodeLLDB discovery/profile for Windows.
- `debug_codelldb_info`.
- `debug_start_codelldb`.
- `debug_launch_codelldb`.
- `debug_attach_codelldb`.
- Real Windows GitHub Actions smoke test using an MSVC-built C++ executable and CodeLLDB over DAP stdio.

## 0.1.0

### Added

- Initial debugger-agnostic DAP transport and session layer.
- MCP stdio server.
- Launch/attach, simple source breakpoints, continue, stepping, threads, stack, scopes, variables, evaluate, events, status, and disconnect tools.
- End-to-end mock DAP adapter test.
