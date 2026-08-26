# MCP toolsets

qwen-dap-mcp exposes two MCP tool surfaces. The debugger implementation underneath is the same; the toolset only controls which tool schemas the MCP client sees.

## `agent` — default

`agent` is optimized for coding agents. It keeps the MCP schema/context surface small and exposes the high-level workflows that normally contain enough evidence for crash diagnosis and verification:

- `debug_this_crash`
- `debug_diagnose_stop`
- `debug_source_disassembly`
- `debug_run_to_stop`
- `debug_open_dump`
- `debug_snapshot`
- `debug_status`
- `debug_continue`
- `debug_disconnect`

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

## Why the default changed

MCP clients usually include tool names, descriptions, and schemas in model context. Native debuggers naturally expose many small operations, but a coding agent fixing a crash rarely needs every low-level schema at once. The compact toolset keeps the agent focused on evidence collection and the diagnose → fix → reproduce → verify loop while preserving the complete debugger surface as an opt-in mode.

An invalid `QWEN_DAP_MCP_TOOLSET` value fails startup with an actionable error rather than silently choosing a different toolset.
