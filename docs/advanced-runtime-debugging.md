# Advanced runtime debugging

The advanced runtime workflows build on the existing DAP session, crash diagnosis, writer tracing, differential analysis, and bounded operation policies.

## Causal value tracing

`debug_causal_trace` starts from the current stopped snapshot and combines the consumer-side value with bounded watchpoint/data-breakpoint writer observations.

It is intended for questions such as:

```text
crash consumer
  -> suspicious pointer/value
  -> immediate writer
  -> earlier writer/propagator
```

The producer chain is runtime evidence, not automatic proof of root cause. A writer can merely copy an already-invalid value.

## Runtime progress probing

`debug_progress_probe` repeatedly resumes and pauses a live target for short bounded intervals and compares the selected thread's frame, source location, and instruction pointer.

Possible classifications include:

- `no-observed-progress`
- `probable-busy-loop`
- `same-frame-progress`
- `forward-progress-observed`

Sampling perturbs scheduling. A repeated instruction pointer is consistent with spinning, but does not prove that the application performs no useful work.

## Reverse execution

`debug_reverse_execution` exposes DAP `stepBack` and `reverseContinue` only when the adapter advertises `supportsStepBack`.

This is useful with record/replay-capable debuggers. Ordinary CodeLLDB/GDB/lldb-dap sessions may not provide reverse execution unless the underlying debugger/recording setup supports it.

Reverse execution is live target control. It remains blocked by `inspect-only` policy and is covered by HOL Guard when enabled.

## Runtime reports

`debug_runtime_report` creates a bounded structured triage report containing:

- normalized crash fingerprint
- top-frame crash identity
- exception identity
- full bounded runtime snapshot
- Symbol Doctor summary and suggested next actions
- AddressSanitizer / UBSan / TSan / LSan evidence found in captured debugger output
- common poison/debug fill pattern findings
- ABI register-to-argument mapping for Windows x64, System V AMD64, and AArch64
- recent adapter/debuggee output used for correlation

Poison values, sanitizer text, and ABI argument mappings are evidence. They are not standalone root-cause proof.

## Crash clustering

Use `debug_cluster_crashes` with identities produced by `debug_runtime_report` to group multiple dump/reproduction reports by their normalized fingerprint.

The tool intentionally consumes report identities rather than opening arbitrary files itself. Open each dump through the existing hardened `debug_open_dump` path, produce a report, then cluster those reports.

## Regression oracle

`debug_regression_oracle` compares a current reproduction fingerprint with the original failure.

It returns:

- `original-crash`
- `changed-crash`
- `inconclusive`

A changed crash is deliberately **not** called good. A patch or commit may remove the original failure while exposing a downstream defect.

## Child/fork request visibility

Adapters can send DAP reverse requests such as `startDebugging` when a subprocess or worker wants a debugger.

`debug_child_requests` exposes a bounded history of those requests, but the transport continues to reject them by default. This preserves the existing fail-closed boundary: an adapter cannot silently cause qwen-dap-mcp to spawn or take control of another target.

Use the returned child configuration as evidence, then create and authorize a separate debugger session explicitly.

## Safety summary

- `debug_runtime_report`, `debug_cluster_crashes`, `debug_regression_oracle`, and `debug_child_requests` are inspection-only.
- `debug_causal_trace`, `debug_progress_probe`, and `debug_reverse_execution` can resume or otherwise control a live target.
- Frozen dumps cannot be used for causal writer tracing, progress probing, or reverse execution.
- `QWEN_DAP_MCP_DAP_POLICY=inspect-only` continues to deny live control.
- HOL Guard already treats `reverseContinue` and `stepBack` as protected DAP commands.
