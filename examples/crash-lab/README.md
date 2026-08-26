# qwen-dap-mcp Crash Lab

Small native crash fixtures for trying the debugger bridge without bringing your own failing application.

The cases are intentionally simple. The point is not to challenge the model with source-code puzzles; it is to demonstrate that the agent can collect runtime evidence, make an evidence-backed change, rebuild, reproduce the exact scenario, and verify the original crash is gone.

## Cases

| Case | Expected failure family | What the debugger should expose |
| --- | --- | --- |
| `null-pointer` | access violation / segmentation fault | null base pointer, project frame, source line and faulting load |
| `divide-by-zero` | divide-by-zero / SIGFPE | zero divisor, project frame and arithmetic instruction |
| `bad-call-target` | access violation / segmentation fault | null call target and the project-controlled caller |

## Build

From the repository root:

```bash
npm run demo:build
```

Or one fixture only:

```bash
npm run demo:build -- null-pointer
```

The script prefers `cl` on Windows and otherwise tries `clang++` and `g++`. It builds with debug symbols, optimization disabled, frame pointers preserved, and places generated binaries under `examples/crash-lab/build/`.

On Windows, if `cl` is installed but not visible in a normal terminal, use a Visual Studio Developer PowerShell or make `clang++`/`g++` available on `PATH`.

## Confirm the crash without the agent

```bash
npm run demo:repro -- null-pointer
```

The wrapper exits successfully only when the fixture terminates abnormally. A clean fixture exit is treated as a failed reproduction.

## Try it with Qwen Code

Install/link qwen-dap-mcp, build a fixture, then ask Qwen Code:

```text
Use qwen-dap-mcp to diagnose and fix the crash in examples/crash-lab/null-pointer.
Do not infer the root cause from source alone. Reproduce it under the debugger,
use runtime evidence, make the smallest justified fix, rebuild the same target,
and verify the original crash no longer reproduces.
```

For the compact default toolset, `debug_this_crash` is sufficient for the normal flow. Set `QWEN_DAP_MCP_TOOLSET=full` only when you deliberately want the agent to use manual breakpoint/watchpoint/evaluate/memory tools.

## Recording benchmark runs

Do not edit the fixture before the run begins. Record the model/client/version, git commit, prompt, diagnosis outcome, whether a source fix was produced, and whether the exact reproduction was verified. See [`../../benchmark/README.md`](../../benchmark/README.md).
