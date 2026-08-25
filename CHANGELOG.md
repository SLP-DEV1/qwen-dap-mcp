# Changelog

All notable prototype milestones are documented here.

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
