# Launch kit

This file contains ready-to-use copy and metadata for announcing `qwen-dap-mcp` without rewriting the pitch for every community.

## One-line pitch

Give Qwen Code a real native debugger: autonomous C/C++ crash diagnosis and verification through a local DAP-to-MCP bridge with CodeLLDB and minidump support.

## GitHub About description

Autonomous native crash debugging for Qwen Code via DAP → MCP. CodeLLDB, crash dumps, runtime evidence and agentic verification.

## Suggested GitHub topics

```text
qwen-code
qwen
mcp
model-context-protocol
dap
debug-adapter-protocol
debugger
codelldb
lldb
crash-analysis
crash-debugging
minidump
postmortem-debugging
agentic-debugging
coding-agent
typescript
```

## Qwen Code Show and tell

### Title

Native autonomous debugging for Qwen Code with CodeLLDB through MCP

### Post

I built **qwen-dap-mcp**, a debugger-agnostic DAP → MCP bridge that gives Qwen Code structured access to a real native debugger.

The goal is to let a coding agent use debugger evidence instead of guessing from source alone when a C/C++ program crashes.

Current capabilities include:

- CodeLLDB launch/attach through DAP
- stack, register, local, module, disassembly and memory evidence
- Windows minidump / postmortem analysis
- project-frame and operand correlation
- bounded runtime root-cause backtracking
- autonomous diagnose → inspect → fix → build → reproduce → verify orchestration
- explicit crash fingerprints and changed-failure detection
- local stdio transport with no arbitrary shell or unrestricted memory-write MCP primitive

Install in Qwen Code:

```bash
qwen extensions install SLP-DEV1/qwen-dap-mcp
```

Repository:
https://github.com/SLP-DEV1/qwen-dap-mcp

I would especially appreciate feedback from people using Qwen Code for C/C++ or other native projects, and from anyone testing additional DAP adapters.

## Reddit / LocalLLaMA

### Title

I gave Qwen Code access to CodeLLDB through MCP so it can diagnose native crashes with real debugger evidence

### Post

I have been working on **qwen-dap-mcp**, a local DAP → MCP bridge for coding agents.

The problem I wanted to solve is simple: when an AI coding agent sees a native crash, source code alone is often not enough. The useful evidence is inside the debugger — exception state, stack frames, registers, locals, disassembly, modules and crash dumps.

The bridge exposes that evidence as MCP tools. Qwen Code can then drive a bounded workflow that diagnoses the crash, identifies a likely project-controlled frame, correlates operands/registers/locals, inspects the source, applies a minimal fix through its normal coding tools, rebuilds, repeats the same reproduction and verifies whether the original crash fingerprint is gone.

CodeLLDB is the first built-in debugger profile, and Windows minidump analysis is supported as well.

The server is local stdio only and deliberately does not expose an arbitrary shell, arbitrary source-writing primitive or unrestricted memory-write primitive.

Install:

```bash
qwen extensions install SLP-DEV1/qwen-dap-mcp
```

Repo:
https://github.com/SLP-DEV1/qwen-dap-mcp

Feedback on real native projects and other DAP adapters would be useful.

## Hacker News

### Title

Show HN: qwen-dap-mcp – Give coding agents a native debugger through DAP and MCP

### Text

I built qwen-dap-mcp, a local DAP-to-MCP bridge that exposes native debugger evidence to coding agents. CodeLLDB is the first built-in profile. It supports live debugging, Windows minidumps, stack/register/local/disassembly evidence, runtime provenance, and bounded diagnose/fix/reproduce/verify orchestration for Qwen Code. The MCP stays focused on debugger evidence and does not provide a general shell or unrestricted memory writes.

https://github.com/SLP-DEV1/qwen-dap-mcp

## Short X / social post

Qwen Code can now use a real native debugger.

I built `qwen-dap-mcp`: DAP → MCP with CodeLLDB, crash dumps, registers/locals/disassembly, runtime evidence and bounded autonomous diagnose → fix → reproduce → verify loops.

https://github.com/SLP-DEV1/qwen-dap-mcp

## Demo storyboard

A short terminal recording or GIF should show one complete story rather than a tool list:

1. Start with a tiny C++ target that reliably crashes.
2. Ask Qwen Code to debug the crash.
3. Show CodeLLDB starting through the MCP bridge.
4. Show the selected project frame and suspicious register/local evidence.
5. Show the source location and minimal proposed fix.
6. Show the rebuild.
7. Re-run the exact same reproduction.
8. End on the verification verdict that the original crash fingerprint is gone.

Keep the demo under roughly 30–45 seconds and avoid private source paths or unrelated terminal noise.

## Distribution checklist

- GitHub Releases: already supported by the repository release workflow.
- Qwen Code GitHub install: `qwen extensions install SLP-DEV1/qwen-dap-mcp`.
- npm target: `@slp-dev1/qwen-dap-mcp`.
- MCP Registry name: `io.github.SLP-DEV1/qwen-dap-mcp`.
- MCP registry metadata: `server.json`.
- npm ownership verification: matching `mcpName` in `package.json`.

Do not announce npm or MCP Registry availability as live until the package/registry publication has actually completed.
