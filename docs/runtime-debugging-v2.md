# Runtime debugging v2

This guide covers the second-stage native debugging workflows layered on top of qwen-dap-mcp's existing DAP transport, crash/hang diagnosis, differential debugging, causal tracing, and bounded verification.

## Security profiles

Set `QWEN_DAP_MCP_PROFILE` to one of:

- `inspect` — agent toolset + inspect-only DAP policy.
- `local-debug` — default compact agent toolset + normal authorized local debugger control.
- `advanced` — high-level `forensics` toolset + normal DAP policy; raw manual DAP remains explicit via `QWEN_DAP_MCP_TOOLSET=full`.

Explicit `QWEN_DAP_MCP_TOOLSET` and `QWEN_DAP_MCP_DAP_POLICY` values override the corresponding profile defaults. Remote-host allowlisting and HOL Guard remain independent gates.

## Record/replay and rr

`debug_time_travel` supports:

- `doctor` — discover local rr and report its version.
- `record` — execute one explicit local program under rr with literal argv, `shell=false`, and a hard timeout.
- `replay-plan` — validate an existing trace and produce a loopback-only `rr replay -s PORT` plan.
- `replay-start` — start that fixed-argv loopback replay under MCP lifecycle management and optionally attach through the existing hardened GDB remote path.
- `replay-status` / `replay-stop` — inspect or terminate only the managed replay process for the current debugger session.
- `reverse` — issue `stepBack` or `reverseContinue` on a DAP adapter that advertises reverse execution.

The MCP does not expose a general command runner. Managed replay uses fixed rr argv, `shell=false`, loopback-only GDB attach, bounded readiness waiting, and terminates rr when managed attach setup fails.

## Lifetime provenance

`debug_trace_lifetime` combines current object/pointer state, sanitizer output, poison-pattern evidence, bounded forward writer tracing, and optional reverse stepping. A writer is temporal evidence, not automatically the lifetime origin.

## Thread timeline and lock ownership

`debug_thread_timeline` samples all threads across bounded resume/pause intervals. It reports execution movement, wait kinds, resources, and a lock-owner graph.

A deadlock cycle is marked proven only when debugger-visible variables explicitly identify owner thread IDs for every edge in the cycle. Generic DAP does not expose a portable lock-owner protocol.

## Symbol Doctor

`debug_symbol_doctor` combines:

- DAP module/symbol health.
- bounded local symbol-cache search.
- ELF Build-ID probing through local readelf/llvm-readelf when available.
- Mach-O UUID probing through local dwarfdump when available.
- PE CodeView identity through local llvm-readobj when available.
- PDB GUID/age probing through local llvm-pdbutil when available.
- explicit configured symbol-server candidates via `QWEN_DAP_MCP_SYMBOL_SERVERS`.

The resolver does not automatically download symbols. Filename-only local matches are candidates, not identity proof.

## Crash families and fingerprint v2

Runtime reports now contain:

- `fingerprintsV2.exact`
- `fingerprintsV2.semantic`
- `fingerprintsV2.family`

Exact retains source-line identity, semantic removes path/address noise, and family intentionally groups broader runtime failure families. `debug_crash_families` compares variants without claiming one shared root cause.

## Evidence reasoning

`debug_runtime_report` now also includes:

- known native API argument analysis for selected libc/platform calls.
- stack-integrity analysis.
- evidence-weighted competing hypotheses.
- a reviewable breakpoint plan.
- exact/semantic/family fingerprints.

Evidence scores are ranking weights, not probabilities.

## Adaptive evidence

`debug_adaptive_evidence` starts with a cheap stopped-state capture and expands to disassembly/modules/full reporting only when the cheap evidence is incomplete or `forceFull` is requested.

## Batch dump triage

`debug_dump_batch` opens a bounded number of local core/minidump files using the existing postmortem adapter path, produces a runtime report for each, and groups results by v2 crash family.

## C++ object inspection

`debug_cpp_object` performs a bounded read of a supplied object pointer, decodes the first machine word as a probable vtable pointer, and correlates that address with loaded modules. A module-backed pointer is consistent with a vtable but not proof of dynamic type.

## Evidence bundles and SARIF

`debug_evidence_bundle` exports bounded evidence as JSON, Markdown, or SARIF and imports JSON/SARIF as offline read-only context.

Exports:
- require dedicated `.qwen-dap.json`, `.qwen-dap.md`, or `.qwen-dap.sarif` artifact names so export cannot act as a general-purpose source/config writer.
- refuse symlink targets.
- refuse accidental overwrite by default.
- are capped at 8 MiB.

Imported evidence cannot control or resume the original process.

## Adapter doctor

`debug_adapter_doctor` reports current DAP capabilities, local adapter discovery, rr availability, and the resolved security profile. Discovery does not grant authority to attach to or execute targets.
