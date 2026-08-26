# Crash-debugging benchmark

This directory defines a small reproducible benchmark harness for comparing coding-agent crash workflows. It deliberately contains **no claimed performance numbers** until real runs have been recorded.

## Modes to compare

Suggested baseline modes:

- `source-only` — the coding agent can inspect/edit/build source but receives no debugger evidence.
- `dap-raw` — the coding agent receives low-level debugger access without the high-level qwen-dap-mcp diagnosis workflow.
- `qwen-dap-mcp` — use `debug_this_crash` and its evidence-backed diagnose/fix/reproduce/verify flow.

Keep the model, model settings, initial source tree, reproduction command, and fix budget identical across modes.

## Result format

Create a JSON file such as `benchmark/results.local.json`:

```json
{
  "schemaVersion": 1,
  "runs": [
    {
      "case": "null-pointer",
      "mode": "qwen-dap-mcp",
      "client": "Qwen Code",
      "model": "your-model-and-quant",
      "commit": "git-commit-used-for-the-run",
      "solved": true,
      "verified": true,
      "iterations": 1,
      "notes": "Exact reproduction exited successfully after rebuild."
    }
  ]
}
```

`solved` means the run produced a source change that addresses the case. `verified` is stricter: the original reproduction must be completed again after rebuilding, and evidence must show the original failure no longer reproduces. A run that merely reaches a breakpoint or a different incomplete stop is not verified.

## Report

```bash
npm run benchmark:report -- benchmark/results.local.json
```

The report groups runs by mode and reports total runs, solved runs, verified runs, solve rate, and verification rate. It does not infer missing outcomes and does not manufacture benchmark data.

## Reproducibility checklist

For publishable results record:

1. repository commit and qwen-dap-mcp version,
2. client + exact model/quantization/provider,
3. context size and relevant generation settings,
4. the exact prompt,
5. crash fixture and reproduction command,
6. maximum fix iterations / stopping policy,
7. raw run logs or transcript when possible,
8. `solved` and `verified` as separate outcomes.

The initial cases are defined in [`cases.json`](cases.json) and implemented in [`../examples/crash-lab`](../examples/crash-lab).
