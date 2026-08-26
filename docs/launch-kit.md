# Launch kit

Ready-to-use copy and metadata for announcing `qwen-dap-mcp` without rewriting the pitch for every community.

## One-line pitch

Give Qwen Code a real native debugger: local DAP-to-MCP crash diagnosis and verification with CodeLLDB, minidumps, compact agent tooling, and reproducible Crash Lab examples.

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

## Live launch links

- Qwen Code Show and tell: https://github.com/QwenLM/qwen-code/discussions/10130
- Glama: https://glama.ai/mcp/servers/SLP-DEV1/qwen-dap-mcp
- npm: https://www.npmjs.com/package/@slp-dev1/qwen-dap-mcp
- GitHub repository: https://github.com/SLP-DEV1/qwen-dap-mcp
- Official MCP Registry name: `io.github.SLP-DEV1/qwen-dap-mcp`

## Qwen Code Show and tell

The launch discussion is live at:

https://github.com/QwenLM/qwen-code/discussions/10130

Use that discussion for follow-up results, compatibility reports, demo clips, and meaningful release updates. Do not duplicate the same launch post into the old feature issue.

### Reference title

I gave Qwen Code a real native debugger through DAP and MCP

### Reference project summary

I built **qwen-dap-mcp**, a local DAP → MCP bridge that gives Qwen Code structured access to a real native debugger instead of asking it to infer every crash from source and terminal output alone.

The useful evidence for a native crash is often inside the debugger: stack frames, registers, locals, exception state, disassembly, loaded modules and crash dumps. qwen-dap-mcp exposes that evidence through MCP and keeps the fix/build work in the normal coding-agent workflow.

`v0.12.0` adds a compact default agent toolset, while the full low-level debugger surface remains available through `QWEN_DAP_MCP_TOOLSET=full`. It also includes a reproducible Crash Lab and benchmark scaffold so the workflow can be tested rather than only described.

Install in Qwen Code:

```bash
qwen extensions install SLP-DEV1/qwen-dap-mcp
```

Or run the published MCP package directly:

```bash
npx -y @slp-dev1/qwen-dap-mcp
```

Glama:
https://glama.ai/mcp/servers/SLP-DEV1/qwen-dap-mcp

## Reddit / LocalLLaMA

**Important:** avoid repeated self-promotion. Participate normally in the subreddit, and rewrite the final version in your own voice before posting.

### Suggested title

I connected Qwen Code to CodeLLDB through MCP so it can inspect real native crash state

### Draft to rewrite in your own voice

I kept running into the same limitation with coding agents on native projects: they can read source and retry builds, but once the program actually crashes they often do not have the debugger state that a human would immediately inspect.

So I built **qwen-dap-mcp**, a local DAP → MCP bridge. The idea is not to give the model a bigger shell. It gives the agent structured debugger evidence such as stack frames, registers, locals, exception state, disassembly, modules and crash dumps.

Qwen Code can use that evidence in a bounded workflow: diagnose the stop, identify a likely project-controlled frame, correlate the faulting operand with registers/locals, make the source change through its normal coding tools, rebuild, reproduce the same scenario and compare the new result against the original crash fingerprint.

The first fully tested debugger profile is CodeLLDB. Windows minidumps are covered by a real CI smoke test as well.

`v0.12.0` also adds a smaller default MCP tool surface for agents and a tiny Crash Lab so the workflow is reproducible.

Everything runs locally over stdio. The MCP itself deliberately does not expose an arbitrary shell or unrestricted memory writes.

Repo: https://github.com/SLP-DEV1/qwen-dap-mcp

Glama: https://glama.ai/mcp/servers/SLP-DEV1/qwen-dap-mcp

npm: `npx -y @slp-dev1/qwen-dap-mcp`

If anyone tries it on a real native project, I would be interested in where the debugger evidence helps and where the agent still gets stuck.

## Hacker News

Use Show HN only from an account that already participates normally on Hacker News.

### Title

Show HN: qwen-dap-mcp – Native debugging for coding agents via DAP and MCP

### Submission text / first comment

I built qwen-dap-mcp because coding agents tend to be much better at editing source than at inspecting what happened inside a native process at the moment it crashed.

It is a local DAP-to-MCP bridge. CodeLLDB is the first first-class debugger profile, with live debugging and Windows minidump support. The MCP exposes bounded stack/register/local/module/disassembly/memory evidence plus higher-level crash diagnosis and verification. Source editing and builds remain outside the debugger bridge.

The design goal is to make crash fixing evidence-driven without turning the MCP into a general execution backdoor. There is no arbitrary shell tool and no unrestricted memory-write primitive.

v0.12 adds a compact agent-facing toolset and a reproducible Crash Lab. The repository can be installed directly as a Qwen Code extension or run as an npm MCP package.

https://github.com/SLP-DEV1/qwen-dap-mcp

## Short social post

Qwen Code can now use a real native debugger.

`qwen-dap-mcp` bridges DAP → MCP with CodeLLDB, live crash evidence, Windows minidumps and bounded diagnose → fix → reproduce → verify workflows.

v0.12 adds a compact agent toolset + reproducible Crash Lab.

https://github.com/SLP-DEV1/qwen-dap-mcp

Glama: https://glama.ai/mcp/servers/SLP-DEV1/qwen-dap-mcp

## Demo storyboard

A short terminal recording or GIF should show one complete story rather than a tool list:

1. Build the included `null-pointer` Crash Lab target.
2. Reproduce the crash once before Qwen touches the source.
3. Ask Qwen Code to debug and fix the crash using qwen-dap-mcp.
4. Show CodeLLDB starting through the MCP bridge.
5. Show the selected project frame and suspicious register/local evidence.
6. Show the source location and minimal fix.
7. Show the rebuild.
8. Re-run the exact same reproduction.
9. End on the verification verdict that the original crash fingerprint is gone.

Useful commands:

```bash
npm run demo:build -- null-pointer
npm run demo:repro -- null-pointer
```

Keep the recording around 30–45 seconds and avoid private source paths or unrelated terminal noise.

## Distribution status

- GitHub Release: `v0.12.0` live.
- Qwen Code GitHub install: `qwen extensions install SLP-DEV1/qwen-dap-mcp`.
- npm: `@slp-dev1/qwen-dap-mcp@0.12.0`, with `latest` pointing to `0.12.0`.
- MCP Registry: `io.github.SLP-DEV1/qwen-dap-mcp` published through GitHub OIDC.
- Glama: live at `https://glama.ai/mcp/servers/SLP-DEV1/qwen-dap-mcp`.
- Qwen Code Show and tell: live at `https://github.com/QwenLM/qwen-code/discussions/10130`.

Do not post further updates in `QwenLM/qwen-code/issues/10051`; use the live Qwen Code Show and tell discussion instead.
