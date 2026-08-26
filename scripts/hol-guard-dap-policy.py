#!/usr/bin/env python3
"""HOL Guard adapter for qwen-dap-mcp DAP policy decisions.

The process reads one JSON action from stdin and writes exactly one JSON
policy decision to stdout. It never starts a debug adapter and never forwards a
DAP request. All executable side effects remain in the TypeScript caller after
this process has returned an allow/warn decision.

The bridge targets HOL Guard 2.2+ and feature-detects the late-claim authority
API so newer Guard releases get the strongest available revalidation without
making qwen-dap-mcp depend on a private package version pin.
"""

from __future__ import annotations

import importlib.metadata
import inspect
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

MIN_HOL_GUARD_VERSION = (2, 2)
BRIDGE_POLICY_VERSION = "qwen-dap-mcp-hol-guard-v2"


def _error(message: str) -> int:
    print(message, file=sys.stderr, flush=True)
    return 2


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _guard_version() -> str:
    return importlib.metadata.version("hol-guard")


def _version_tuple(value: str) -> tuple[int, int] | None:
    match = re.match(r"^(\d+)\.(\d+)", value)
    if match is None:
        return None
    return int(match.group(1)), int(match.group(2))


def _workspace(payload: dict[str, Any]) -> Path:
    # For launch requests the debuggee working directory is a better policy
    # workspace than the adapter's own cwd. Fall back through the active adapter
    # session and finally the MCP server process cwd.
    args = payload.get("args")
    if isinstance(args, dict):
        request_cwd = args.get("cwd")
        if isinstance(request_cwd, str) and request_cwd.strip():
            return Path(request_cwd).expanduser().resolve()
    raw = payload.get("cwd")
    if isinstance(raw, str) and raw.strip():
        return Path(raw).expanduser().resolve()
    return Path.cwd().resolve()


def _safe_token(value: str) -> str:
    token = re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_").lower()
    return token or "unknown"


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def _tool_shape(payload: dict[str, Any]) -> tuple[str, dict[str, Any], dict[str, Any], str]:
    kind = payload.get("kind")
    if kind == "adapter-start":
        command = payload.get("command")
        if not isinstance(command, str) or not command.strip():
            raise ValueError("adapter-start requires a non-empty command")
        args = _string_list(payload.get("args", []))
        arguments: dict[str, Any] = {
            "command": command,
            "args": args,
        }
        cwd = payload.get("cwd")
        if isinstance(cwd, str) and cwd.strip():
            arguments["cwd"] = cwd
        env_hash = payload.get("envHash")
        if isinstance(env_hash, str) and env_hash.strip():
            arguments["environmentHash"] = env_hash
        schema = {
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "args": {"type": "array", "items": {"type": "string"}},
                "cwd": {"type": "string"},
                "environmentHash": {"type": "string"},
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
            "Execute a Debug Adapter Protocol action that may run code or change the selected target process.",
        )

    raise ValueError(f"unsupported action kind: {kind!r}")


def _server_fingerprint(payload: dict[str, Any]) -> dict[str, object]:
    kind = payload.get("kind")
    adapter_command = payload.get("adapterCommand")
    if not isinstance(adapter_command, str) or not adapter_command.strip():
        candidate = payload.get("command") if kind == "adapter-start" else None
        adapter_command = candidate if isinstance(candidate, str) else "unknown-adapter"
    adapter_args = _string_list(payload.get("adapterArgs", payload.get("args", []))) if kind == "adapter-start" else _string_list(payload.get("adapterArgs", []))
    env_hash = payload.get("envHash")
    env_keys = _string_list(payload.get("envKeys", []))
    return {
        "command": adapter_command,
        "args": adapter_args,
        "configured_env_values_hash": env_hash if isinstance(env_hash, str) else None,
        "configured_env_keys": env_keys,
        "transport": "stdio",
        "resolved_executable": adapter_command,
        "tool_catalog_state": "complete",
        "tool_catalog_fingerprint": BRIDGE_POLICY_VERSION,
    }


def _launch_target(payload: dict[str, Any], tool_name: str, arguments: dict[str, Any]) -> str:
    if payload.get("kind") == "adapter-start":
        command = str(arguments.get("command") or "unknown-adapter")
        args = arguments.get("args")
        suffix = " " + " ".join(args) if isinstance(args, list) and args else ""
        return f"{command}{suffix}"
    dap_command = str(arguments.get("dapCommand") or tool_name)
    nested = arguments.get("arguments")
    if isinstance(nested, dict):
        program = nested.get("program") or nested.get("target") or nested.get("processId")
        if program is not None:
            return f"DAP {dap_command}: {program}"
    return f"DAP {dap_command}"


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001 - CLI boundary must fail closed
        return _error(f"invalid qwen-dap-mcp HOL Guard input: {exc}")

    if not isinstance(payload, dict):
        return _error("qwen-dap-mcp HOL Guard input must be a JSON object")

    try:
        guard_version = _guard_version()
        parsed_version = _version_tuple(guard_version)
        if parsed_version is None or parsed_version < MIN_HOL_GUARD_VERSION:
            return _error(
                f"HOL Guard {guard_version} is unsupported; qwen-dap-mcp requires HOL Guard 2.2 or newer"
            )

        from codex_plugin_scanner.guard.approvals import queue_blocked_approvals
        from codex_plugin_scanner.guard.config import load_guard_config, resolve_guard_home
        from codex_plugin_scanner.guard.daemon import ensure_guard_daemon
        from codex_plugin_scanner.guard.mcp_tool_calls import (
            allow_tool_call,
            block_tool_call,
            build_tool_call_artifact,
            build_tool_call_hash,
            evaluate_tool_call,
            resolve_tool_call_policy_action,
        )
        from codex_plugin_scanner.guard.models import HarnessDetection
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
        store = GuardStore(guard_home)
        config_path = str(workspace / ".qwen-dap-mcp-hol-guard")
        server_fingerprint = _server_fingerprint(payload)

        def build_authority() -> tuple[Any, Any, str, object]:
            current_config = load_guard_config(guard_home, workspace)
            current_artifact = build_tool_call_artifact(
                harness="qwen-dap-mcp",
                server_name="qwen-dap-mcp",
                server_id="io.github.SLP-DEV1/qwen-dap-mcp",
                server_fingerprint=server_fingerprint,
                tool_name=tool_name,
                source_scope="project",
                config_path=config_path,
                transport="stdio",
                tool_schema=tool_schema,
                tool_description=tool_description,
            )
            current_hash = build_tool_call_hash(
                current_artifact,
                arguments,
                workspace=workspace,
                config=current_config,
            )
            return current_config, current_artifact, current_hash, arguments

        config, artifact, artifact_hash, _ = build_authority()
        evaluation_kwargs: dict[str, Any] = {
            "store": store,
            "config": config,
            "artifact": artifact,
            "artifact_hash": artifact_hash,
            "arguments": arguments,
        }
        evaluate_parameters = inspect.signature(evaluate_tool_call).parameters
        if "fresh_authority_provider" in evaluate_parameters:
            evaluation_kwargs["fresh_authority_provider"] = build_authority
        decision = evaluate_tool_call(**evaluation_kwargs)

        post_claim_authority = getattr(decision, "post_claim_authority", None)
        if post_claim_authority is not None:
            config = post_claim_authority.config
            artifact = post_claim_authority.artifact
            artifact_hash = post_claim_authority.artifact_hash
            arguments = post_claim_authority.arguments

        action = resolve_tool_call_policy_action(decision)
        timestamp = _now()
        signals = tuple(decision.signals)
        risk_categories = tuple(decision.risk_categories)
        response: dict[str, object] = {
            "allow": False,
            "action": action,
            "reason": decision.summary,
            "source": decision.source,
            "signals": list(signals),
            "riskCategories": list(risk_categories),
            "guardVersion": guard_version,
        }

        # Observe mode never blocks execution, but still records the evaluated
        # action as an allowed runtime event so Guard keeps an audit trail.
        if config.mode == "observe":
            allow_tool_call(
                store=store,
                artifact=artifact,
                artifact_hash=artifact_hash,
                decision_source="observe",
                now=timestamp,
                signals=signals,
                remember=False,
                risk_categories=risk_categories,
                arguments=arguments,
                policy_workspace=str(workspace),
                policy_action="warn" if action not in {"allow", "warn"} else action,
            )
            response["allow"] = True
            response["reason"] = f"HOL Guard observe mode recorded '{action}': {decision.summary}"
            print(json.dumps(response, separators=(",", ":")), flush=True)
            return 0

        if action in {"allow", "warn"}:
            allow_tool_call(
                store=store,
                artifact=artifact,
                artifact_hash=artifact_hash,
                decision_source=decision.source,
                now=timestamp,
                signals=signals,
                remember=False,
                risk_categories=risk_categories,
                arguments=arguments,
                policy_workspace=str(workspace),
                policy_action=action,
            )
            response["allow"] = True
            print(json.dumps(response, separators=(",", ":")), flush=True)
            return 0

        if action in {"review", "require-reapproval"}:
            approval_center_url = ensure_guard_daemon(guard_home)
            launch_target = _launch_target(payload, tool_name, arguments)
            evaluation = {
                "artifacts": [
                    {
                        "artifact_id": artifact.artifact_id,
                        "artifact_name": artifact.name,
                        "artifact_type": artifact.artifact_type,
                        "artifact_hash": artifact_hash,
                        "approval_context_hash": artifact_hash,
                        "source_scope": artifact.source_scope,
                        "config_path": artifact.config_path,
                        "workspace": str(workspace),
                        "changed_fields": ["runtime_tool_call", payload.get("kind", "dap")],
                        "policy_action": action,
                        "launch_target": launch_target,
                        "risk_summary": decision.summary,
                        "risk_signals": list(signals),
                    }
                ]
            }
            queued = queue_blocked_approvals(
                detection=HarnessDetection(
                    harness="qwen-dap-mcp",
                    installed=True,
                    command_available=True,
                    config_paths=(config_path,),
                    artifacts=(artifact,),
                ),
                evaluation=evaluation,
                store=store,
                approval_center_url=approval_center_url,
                now=timestamp,
                redaction_level=config.receipt_redaction_level,
            )
            block_tool_call(
                store=store,
                artifact=artifact,
                artifact_hash=artifact_hash,
                decision_source=decision.source,
                now=timestamp,
                signals=signals,
                risk_categories=risk_categories,
                arguments=arguments,
                policy_action=action,
            )
            response["approvalCenterUrl"] = approval_center_url
            if queued:
                request = queued[0]
                request_id = request.get("request_id")
                review_command = request.get("review_command")
                if isinstance(request_id, str):
                    response["approvalRequestId"] = request_id
                if isinstance(review_command, str):
                    response["reviewCommand"] = review_command
            print(json.dumps(response, separators=(",", ":")), flush=True)
            return 0

        # sandbox-required and block are terminal in this integration. Record
        # the non-execution receipt and return the blocking decision.
        block_tool_call(
            store=store,
            artifact=artifact,
            artifact_hash=artifact_hash,
            decision_source=decision.source,
            now=timestamp,
            signals=signals,
            risk_categories=risk_categories,
            arguments=arguments,
            policy_action=action,
        )
        print(json.dumps(response, separators=(",", ":")), flush=True)
        return 0
    except Exception as exc:  # noqa: BLE001 - policy boundary must fail closed
        return _error(f"HOL Guard DAP policy evaluation failed: {exc}")


if __name__ == "__main__":
    raise SystemExit(main())
