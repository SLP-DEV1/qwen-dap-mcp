# 30–45 second demo storyboard

Use the Crash Lab so the recording is reproducible and does not depend on a private project.

## Preparation

```bash
npm install --ignore-scripts
npm run demo:build -- null-pointer
```

Make sure Qwen Code has the current qwen-dap-mcp extension installed or linked.

## Recording sequence

### 0–5 s — establish the failure

Show a terminal and run:

```bash
npm run demo:repro -- null-pointer
```

Keep the final `Crash reproduced as expected` line visible for a moment.

### 5–10 s — ask the agent

Open Qwen Code in the repository and enter:

```text
Use qwen-dap-mcp to diagnose and fix the crash in examples/crash-lab/null-pointer.
Do not infer the root cause from source alone. Reproduce it under the debugger,
use runtime evidence, make the smallest justified fix, rebuild the same target,
and verify the original crash no longer reproduces.
```

### 10–25 s — show debugger evidence

Keep the recording focused on the high-value evidence rather than every tool call:

```text
classification: access violation / segmentation fault
project frame: read_payload(...)
fault operand / pointer: null
source correlation: examples/crash-lab/null-pointer/main.cpp
```

If the agent prints a large JSON response, zoom/crop to the classification, project frame, operand/local evidence and proposed fix.

### 25–35 s — patch and rebuild

Show the small source edit and successful rebuild. Avoid editing the fixture before the debugger evidence has been collected.

### 35–45 s — verification

Show the rebuilt reproduction completing cleanly and the qwen-dap-mcp verification verdict:

```text
original crash fingerprint: no longer reproduced
verification: fixed
```

## Suggested title/caption

**Give your coding agent a real native debugger — DAP → MCP with CodeLLDB**

Short caption:

> qwen-dap-mcp gives Qwen Code structured native runtime evidence instead of asking the model to guess from source alone. Local stdio MCP, CodeLLDB, crash dumps, and evidence-backed reproduce/verify loops.

## Recording notes

- Keep the terminal font large enough for mobile viewing.
- Do not hide intermediate failures; a real reproduction makes the demo credible.
- Prefer one uninterrupted workflow over a montage.
- Do not claim benchmark improvements in the video until measured runs exist in `benchmark/`.
- Reuse the same clip for the README, Reddit, GitHub Discussions, and Show HN.
