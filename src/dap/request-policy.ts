import { DapError } from './errors.js';

export type DapPolicyMode = 'standard' | 'inspect-only';

export type DapRequestPolicyContext = {
  command: string;
  args?: unknown;
};

export type DapRequestPolicyDecision =
  | { allow: true }
  | { allow: false; reason: string };

export type DapRequestPolicyResult = DapRequestPolicyDecision | Promise<DapRequestPolicyDecision>;
export type DapRequestPolicy = (context: DapRequestPolicyContext) => DapRequestPolicyResult;

const INSPECT_ONLY_ALLOWED_COMMANDS = new Set([
  'initialize',
  'cancel',
  'threads',
  'stackTrace',
  'scopes',
  'variables',
  'modules',
  'disassemble',
  'readMemory',
  'exceptionInfo',
  'source',
  'loadedSources',
  'breakpointLocations',
]);

const ALLOW: DapRequestPolicyDecision = { allow: true };

/**
 * Build a transport-level DAP request policy.
 *
 * `standard` preserves the normal debugger feature set. `inspect-only` is a
 * fail-closed mode intended for agents or policy engines that must only read
 * debugger state: commands that are not explicitly known to be inspection
 * operations are denied. In particular, DAP `evaluate` and `launch` are denied
 * because either can execute code in or start a target process.
 */
export function createDapRequestPolicy(mode: DapPolicyMode = 'standard'): DapRequestPolicy {
  if (mode === 'standard') return () => ALLOW;

  return ({ command }) => {
    if (INSPECT_ONLY_ALLOWED_COMMANDS.has(command)) return ALLOW;
    return {
      allow: false,
      reason: `DAP policy '${mode}' only permits explicit inspection requests; '${command}' may change or execute target state`,
    };
  };
}

/** Resolve the built-in policy from QWEN_DAP_MCP_DAP_POLICY. */
export function resolveDapPolicyMode(value = process.env.QWEN_DAP_MCP_DAP_POLICY): DapPolicyMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'standard') return 'standard';
  if (normalized === 'inspect-only' || normalized === 'readonly' || normalized === 'read-only') {
    return 'inspect-only';
  }
  throw new DapError(
    `Unsupported QWEN_DAP_MCP_DAP_POLICY '${value}'. Expected 'standard' or 'inspect-only' (alias: 'read-only').`,
  );
}
