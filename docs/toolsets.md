# MCP toolsets

qwen-dap-mcp exposes two MCP tool surfaces. The debugger implementation underneath is the same; the toolset only controls which tool schemas the MCP client sees.

## `agent` — default

`agent` is optimized for coding agents. It keeps the MCP schema/context surface small and exposes the high-level workflows that normally contain enough evidence for crash diagnosis, hang triage, runtime provenance, and verification:

- `debug_this_crash` — high-level crash diagnosis / verification / bounded autonomous workflow
- `debug_this_hang` — bounded all-thread hang/deadlock triage with wait heuristics and Pointer-Provenance v2
- `debug_diagnose_stop` — intelligent analysis of an already stopped crash
- `debug_source_disassembly` — source/instruction/register correlation
- `debug_find_writer` — temporary data-breakpoint/watchpoint workflow for suspicious values
- `debug_run_to_stop` — lower-level launch/attach until the next stop or exit
- `debug_open_dump` — read-only core/minidump inspection
- `debug_snapshot` — bounded raw stopped-state evidence
- `debug_status` — current debugger/session status
- `debug_continue` — resume an authorized live target
- `debug_disconnect` — tear down the active debugger session

No environment variable is required:

```bash
npx -y @slp-dev1/qwen-dap-mcp
```

Or set it explicitly:

```bash
QWEN_DAP_MCP_TOOLSET=agent npx -y @slp-dev1/qwen-dap-mcp
```

PowerShell:

```powershell
$env:QWEN_DAP_MCP_TOOLSET = 'agent'
npx -y @slp-dev1/qwen-dap-mcp
```

## `full` — manual debugger surface

Use `full` when the client or user intentionally needs low-level DAP operations such as manual breakpoint/watchpoint management, stepping, expression evaluation, direct memory reads, module inspection, or raw thread/stack/scope traversal.

```bash
QWEN_DAP_MCP_TOOLSET=full npx -y @slp-dev1/qwen-dap-mcp
```

PowerShell:

```powershell
$env:QWEN_DAP_MCP_TOOLSET = 'full'
npx -y @slp-dev1/qwen-dap-mcp
```

The full toolset remains backwards compatible with the pre-v0.12 public tool surface.

## Hang workflow safety

`debug_this_hang` can pause a live target and its launch/attach modes can execute or take debugger control of an authorized local process. Those DAP boundaries use the same built-in policy and optional HOL Guard enforcement as the corresponding low-level `launch`, `attach`, and `pause` operations.

All-thread wait/deadlock results are deliberately heuristic. Generic DAP has no portable lock-owner graph, so `deadlock-candidate` means the captured state is consistent with deadlock; it does not claim a proven cycle. Pointer-Provenance v2 similarly treats repeated pointer values across threads as correlation evidence, not proof of lock ownership or causality.

## Why the default changed

MCP clients usually include tool names, descriptions, and schemas in model context. Native debuggers naturally expose many small operations, but a coding agent fixing a crash or hang rarely needs every low-level schema at once. The compact toolset keeps the agent focused on evidence collection and the diagnose → fix → reproduce → verify loop while preserving the complete debugger surface as an opt-in mode.

An invalid `QWEN_DAP_MCP_TOOLSET` value falls back to the safe `agent` toolset with a warning.
