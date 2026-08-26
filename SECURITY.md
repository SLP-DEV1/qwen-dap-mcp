# Security Policy

## Supported versions

Security fixes are applied to the latest release and the current `main` branch.

## Reporting a vulnerability

Please do **not** publish exploit details, sensitive crash dumps, credentials, private source code, or other confidential target data in a public issue.

If GitHub private vulnerability reporting is enabled for this repository, use **Security → Report a vulnerability**. Otherwise, open a minimal public issue that only states that you have a security-sensitive report and asks the maintainer for a private contact path.

Useful non-sensitive context includes:

- affected `qwen-dap-mcp` version,
- operating system and architecture,
- DAP adapter and version,
- whether the issue affects live debugging, dump debugging, MCP transport, packaging, or path validation,
- high-level impact without weaponized reproduction details.

## Security boundaries

`qwen-dap-mcp` is intentionally designed around local, authorized debugging workflows:

- MCP transport is local stdio,
- there is no built-in remote HTTP debugger service,
- there is no arbitrary shell/source-writing MCP primitive,
- there is no unrestricted memory-write MCP primitive,
- live attach is intended only for authorized local targets,
- postmortem dump sessions are read-only for execution-control operations,
- autonomous fix attempts are bounded and evidence-gated.

These boundaries are security properties. Changes that weaken them should receive explicit review and regression coverage.
