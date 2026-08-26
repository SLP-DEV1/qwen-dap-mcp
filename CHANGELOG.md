# Changelog

All notable prototype milestones are documented here.

## 0.11.2 - 2026-08-26

### Fixed / hardened

- Isolated retired DAP adapter process events so late stdout, stderr, process errors, or exits from an old adapter cannot contaminate a newer debugging generation.
- Treat signal-terminated child processes as exited even when `exitCode` remains null.
- Reject pending DAP requests promptly on malformed framing, duplicate `Content-Length` headers, invalid JSON, and message-handler protocol failures.
- Bound CodeLLDB PATH discovery and validate direct attach PIDs before contacting the adapter.
- Hardened runtime snapshots so optional locals, registers, modules, disassembly, and exception collection failures are reported as bounded evidence gaps instead of collapsing the whole snapshot.
- Merge locals/arguments/parameters conservatively and validate variable references before requesting variables.
- Clean up CodeLLDB instances owned by failed dump-open transactions and harden owned-session cleanup paths.
- Prevent extension packaging from recursively deleting checked-in project directories outside the dedicated generated release subtree.
- Added path-normalization, output-bounding, diagnosis, lifecycle, package-safety, dump-profile, and DAP-generation regression coverage.

### Distribution / project

- Added scoped npm publication validation and manual npm + official MCP Registry publication automation.
- Published package metadata uses `@slp-dev1/qwen-dap-mcp` and MCP Registry name `io.github.SLP-DEV1/qwen-dap-mcp`.
- Added npm/MCP Registry badges, generic stdio MCP installation guidance, `llms.txt`, and directory-submission documentation.
- Added publishing documentation for npm bootstrap, GitHub OIDC trusted publishing, and MCP Registry publication.

### Verified

- Refreshed pull-request CI passes on Node.js 20 and 22 with `npm run check` and scoped npm package validation.
- Qwen extension package smoke passes on merged `main` after the full v0.11 hardening audit.

## 0.11.1 - 2026-08-26

### Added / changed

- Launch-ready README, contribution/security guidance, issue templates, pull-request template, and canonical Apache-2.0 license text.
- Scoped npm package identity `@slp-dev1/qwen-dap-mcp`, public publish metadata, and official MCP Registry metadata via `server.json`.
- Self-contained GitHub Release distribution remains the primary validated Qwen Code installation path.
- Added launch/community copy and distribution checklist for project discovery.

### Verified

- GitHub Release `v0.11.1` builds, installs, and verifies the exact extension version through Qwen Code release smoke testing.

## 0.11.0 - 2026-08-26

### Added

- Autonomous action protocol v2 for `debug_this_crash(..., workflow={stage:"autonomous"})` with stable action IDs, explicit dependencies, ownership, status, structured inputs, expected results, and success criteria.
- Evidence-backed action chain `inspect-source -> propose-fix -> apply-fix -> build -> reproduce -> verify`, while keeping source editing and builds outside the debugger bridge.
- `rootCauseBacktrack` runtime provenance that follows the selected fault operand/value through bounded caller frames and produces ranked project-controlled producer candidates.
- `verificationQuality` scoring that separates debugger evidence from external build/test/reproduction guarantees and reports reproduction/root-crash/new-crash status explicitly.
- Regression coverage for Windows path fingerprint normalization, multi-register fault binding, large DAP headers, dump-command control characters, autonomous protocol fields, and verification semantics.

### Changed

- Increased the default bounded caller depth from 2 to 3, with a maximum of 8, for stronger producer/ownership reasoning without unbounded stack analysis.
- `debug_this_crash` now validates local CodeLLDB launch paths before adapter discovery/startup, and crash-dump opening validates dump/program inputs before starting CodeLLDB.
- Changed failures are re-baselined against the new trustworthy crash diagnosis instead of automatically rolling back the previous patch; the original root fingerprint remains preserved.
- The bundled Qwen Skill, MCP server instructions, README, and Windows CodeLLDB guide now teach protocol-v2 action dependencies, runtime backtracking, verification quality, raw-fault-vs-project-frame separation, and the no-automatic-rollback policy.
- GitHub Actions now use `actions/checkout@v5` and `actions/setup-node@v5`, avoid duplicate branch CI outside `main`, and broaden Windows/extension smoke triggers to cover DAP, diagnostics, agent, Skill, and packaging changes.

### Fixed / hardened

- DAP connection shutdown now waits for actual process exit, escalates to `SIGKILL` when needed, and no longer treats `ChildProcess.killed` as proof of termination.
- Fresh adapter starts clear stale event history, stderr, parser buffers, request sequence, and pending requests so state cannot leak between debug sessions.
- Adapter stdin/process failures and adapter exit now reject event waiters immediately instead of leaving them to timeout.
- DAP framing now bounds unterminated and terminated headers, rejects oversized/unsafe payload lengths, truncates protocol-error previews, and rejects pending requests after fatal protocol-size violations.
- Launch/attach now race the `initialized` event against an early request rejection so actionable adapter failures surface immediately rather than waiting for a stale timeout.
- Pause/continue/step event waits are observed immediately, preventing rejected stop waiters from becoming unhandled promises when the underlying request fails first.
- `debug_run_to_stop` now rejects promptly on adapter exit/error and preserves the more specific launch/attach failure when a concurrent outcome wait has already failed.
- Exception classification no longer treats configured/first-chance `breakMode="always"` stops as proof of a fatal crash; agents are instructed to continue the reproduction before patching.
- Address/null parsing accepts common debugger formatting and numeric zero without weakening poison/lifetime evidence rules.
- Verification fingerprints canonicalize Windows path separator/case differences so equivalent source paths do not become false changed-failure signatures.
- Root-cause backtracking binds locals to the actual `likelyFaultOperand.register` instead of accidentally selecting the first variable binding when an instruction references multiple registers.
- Crash-dump LLDB command construction rejects control characters in embedded paths, preventing ambiguous multi-command input through unusual local filenames.
- Extension packaging refuses dangerous output targets such as filesystem root, repository root, and the script directory before recursive cleanup; protected-path comparison is Windows case-insensitive.
- MCP stdio startup now installs explicit error reporting and graceful SIGINT/SIGTERM shutdown handling.

### Verified

- Final v0.11 feature head and merged `main` pass `npm run check` on Node.js 20 and 22.
- Real Windows CodeLLDB live DAP smoke passes against an MSVC-built native target.
- Real Windows minidump smoke builds a native crash fixture with PDB symbols, generates a real `.dmp`, opens it through CodeLLDB, and validates intelligent project-frame selection plus autonomous state/action generation.
- Self-contained Qwen extension archive builds, validates, and installs successfully with the pinned Qwen Code smoke environment.

## 0.10.1 - 2026-08-26

### Fixed

- Aligned the `initialized` event timeout with the effective long launch/attach request timeout so slow adapters do not fail configuration prematurely.
- Observed the parallel launch/attach request rejection immediately, preventing unhandled rejected promises while DAP initialization/configuration is still in progress.
- Cleared stale `activeRequest` state and kept `configured=false` on every failed launch/attach path while preserving the successful request mode after configuration completes.
- Preserved the original actionable launch/attach exception in `debug_run_to_stop` when the independent stopped/exited/terminated outcome wait had already timed out.
- Added deterministic regression tests for timeout alignment, rejection observation, stale-state cleanup, successful active-request state, and failure preservation.

## 0.10.0 - 2026-08-26

### Added

- Bounded autonomous crash-fixing loop through `debug_this_crash(..., workflow={stage:"autonomous"})` without adding a general shell or source-writing executor.
- Serializable `autonomousAgent.state` carrying an immutable original/root crash fingerprint, the currently active failure fingerprint, verification baselines, bounded iteration budget, status and history.
- Ordered `nextActions` split between `coding-agent` and `debugger` responsibilities so Qwen Code can inspect source, apply an evidence-backed fix, rebuild, reproduce and return to the debugger for verification.
- Deterministic autonomous states: `needs-evidence`, `needs-fix`, `retry-fix`, `needs-reproduction`, `changed-failure`, `fixed`, `budget-exhausted`, and `blocked`.
- Automatic strategy broadening after repeated identical failures so the agent investigates earlier caller/provenance/ownership evidence instead of repeatedly masking the final crash site.
- Changed-failure re-baselining that preserves the original root fingerprint while continuing against the new source-backed active failure signature.
- State-integrity validation that recomputes root/active fingerprints from embedded baselines and rejects mismatches, impossible iteration counters, invalid budgets, or oversized history.
- Regression coverage for autonomous start/action queues, clean fix termination, inconclusive reproduction, repeated-failure broadening, changed-failure re-baselining, budget exhaustion, and tampered serialized state.

### Changed

- The bundled `native-runtime-debug` Skill now prefers the autonomous workflow for crash-fixing tasks and instructs Qwen to follow `nextActions` in order while returning the serialized state unchanged between reproductions.
- Non-crash stops such as breakpoints or entry pauses no longer trigger another autonomous source edit or consume fix budget; they request completion of the original reproduction instead.
- Autonomous loop state remains explicit in MCP request/response data rather than hidden in server memory, so the workflow can survive MCP/client restarts.
- README and server instructions now document the autonomous debugging contract, stop conditions, evidence thresholds, and separation between debugger orchestration and normal coding/build tools.

### Verified

- Node.js 20 and 22 build/test/package matrix passes on the final feature head and merged `main`.
- Generated self-contained Qwen extension archive builds and installs successfully.
- Real Windows CodeLLDB live DAP smoke passes on the merged autonomous-agent commit.
- Real Windows minidump smoke builds a native MSVC/PDB crash target, generates and reopens a real `.dmp` through CodeLLDB, and validates autonomous crash fingerprint/state/next-action creation against recovered debugger evidence.

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
