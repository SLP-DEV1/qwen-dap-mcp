#!/usr/bin/env python3
"""HOL Guard adapter for qwen-dap-mcp DAP policy decisions.

The process reads one JSON action from stdin and writes exactly one JSON
policy decision to stdout. It intentionally performs policy evaluation only;
it never starts the adapter and never forwards a DAP request.

This bridge targets HOL Guard 2.2+'s local runtime MCP policy primitives. When
qwen-dap-mcp enables HOL Guard, bridge/import failures are handled fail-closed
by the TypeScript caller.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any


def _error(message: str) -> int:
    print(message, file=sys.stderr, flush=True)
    return 2


def _workspace(payload: dict[str, Any]) -> Path:
    raw = payload.get("cwd")
    if not isinstance(raw, str) or not raw.strip():
        return Path.cwd().resolve()
    return Path(raw).expanduser().resolve()


def _safe_token(value: str) -> str:
    token = re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_").lower()
    return token or "unknown"


def _tool_shape(payload: dict[str, Any]) -> tuple[str, dict[str, Any], dict[str, Any], str]:
    kind = payload.get("kind")
    if kind == "adapter-start":
        command = payload.get("command")
        if not isinstance(command, str) or not command.strip():
            raise ValueError("adapter-start requires a non-empty command")
        raw_args = payload.get("args", [])
        args = raw_args if isinstance(raw_args, list) else []
        arguments: dict[str, Any] = {
            "command": command,
            "args": args,
        }
        cwd = payload.get("cwd")
        if isinstance(cwd, str) and cwd.strip():
            arguments["cwd"] = cwd
        schema = {
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "args": {"type": "array", "items": {"type": "string"}},
                "cwd": {"type": "string"},
            },
            "required": ["command"],
        }
        return (
            "execute_dap_adapter_start",
            arguments,
            schema,
            "Execute a local DAP adapter process. This can start the wrong or an untrusted executable.",
        )

    if kind == "dap-request":
        command = payload.get("command")
        if not isinstance(command, str) or not command.strip():
            raise ValueError("dap-request requires a non-empty command")
        arguments = {
            "dapCommand": command,
            "arguments": payload.get("args"),
        }
        schema = {
            "type": "object",
            "properties": {
                "dapCommand": {"type": "string"},
                "arguments": {"type": ["object", "array", "string", "number", "boolean", "null"]},
            },
            "required": ["dapCommand"],
        }
        return (
            f"execute_dap_{_safe_token(command)}",
            arguments,
            schema,
            "Execute a Debug Adapter Protocol action that may run code or mutate debuggee execution state.",
        )

    raise ValueError(f"unsupported action kind: {kind!r}")


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001 - CLI boundary must fail closed
        return _error(f"invalid qwen-dap-mcp HOL Guard input: {exc}")

    if not isinstance(payload, dict):
        return _error("qwen-dap-mcp HOL Guard input must be a JSON object")

    try:
        from codex_plugin_scanner.guard.config import load_guard_config, resolve_guard_home
        from codex_plugin_scanner.guard.mcp_tool_calls import (
            build_tool_call_artifact,
            build_tool_call_hash,
            evaluate_tool_call,
            resolve_tool_call_policy_action,
        )
        from codex_plugin_scanner.guard.store import GuardStore
    except Exception as exc:  # noqa: BLE001 - installation/version boundary
        return _error(
            "HOL Guard Python package is unavailable or incompatible. "
            f"Install/upgrade hol-guard and point QWEN_DAP_MCP_HOL_GUARD_PYTHON at its interpreter: {exc}"
        )

    try:
        workspace = _workspace(payload)
        tool_name, arguments, tool_schema, tool_description = _tool_shape(payload)
        guard_home = resolve_guard_home(os.environ.get("HOL_GUARD_HOME"))
        config = load_guard_config(guard_home, workspace)
        store = GuardStore(guard_home)

        artifact = build_tool_call_artifact(
            harness="qwen-dap-mcp",
            server_name="qwen-dap-mcp",
            server_id="io.github.SLP-DEV1/qwen-dap-mcp",
            tool_name=tool_name,
            source_scope="project",
            config_path=str(workspace / ".qwen-dap-mcp-hol-guard"),
            transport="stdio",
            tool_schema=tool_schema,
            tool_description=tool_description,
        )
        artifact_hash = build_tool_call_hash(
            artifact,
            arguments,
            workspace=workspace,
            config=config,
        )
        decision = evaluate_tool_call(
            store=store,
            config=config,
            artifact=artifact,
            artifact_hash=artifact_hash,
            arguments=arguments,
        )
        action = resolve_tool_call_policy_action(decision)

        # HOL Guard observe mode records/evaluates without enforcement. In
        # prompt/enforce mode only terminally executable actions proceed here;
        # review/reapproval stays fail-closed at the DAP boundary.
        allow = config.mode == "observe" or action in {"allow", "warn"}
        response = {
            "allow": allow,
            "action": action,
            "reason": decision.summary,
            "source": decision.source,
            "signals": list(decision.signals),
            "riskCategories": list(decision.risk_categories),
        }
        print(json.dumps(response, separators=(",", ":")), flush=True)
        return 0
    except Exception as exc:  # noqa: BLE001 - policy boundary must fail closed
        return _error(f"HOL Guard DAP policy evaluation failed: {exc}")


if __name__ == "__main__":
    raise SystemExit(main())
