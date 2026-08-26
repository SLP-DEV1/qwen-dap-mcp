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
  'configurationDone',
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recognize only the dump/core attach shapes emitted by this project.
 * Generic attach remains denied because it can stop/control a live process.
 */
export function isInspectOnlyPostmortemAttach(args: unknown): boolean {
  if (!isRecord(args)) return false;

  // Upstream lldb-dap and GNU GDB core-file flows use an explicit coreFile.
  if (typeof args.coreFile === 'string' && args.coreFile.trim().length > 0) return true;

  // CodeLLDB's documented dump flow is technically an attach request, but it
  // creates a target from a core/minidump and supplies no process-create command.
  const targetCreateCommands = args.targetCreateCommands;
  const processCreateCommands = args.processCreateCommands;
  if (!Array.isArray(targetCreateCommands) || targetCreateCommands.length === 0) return false;
  if (!Array.isArray(processCreateCommands) || processCreateCommands.length !== 0) return false;
  return targetCreateCommands.every((command) =>
    typeof command === 'string' && /^\s*target\s+create\s+-c\s+/i.test(command),
  );
}

/**
 * Build a transport-level DAP request policy.
 *
 * `standard` preserves the normal debugger feature set. `inspect-only` is a
 * fail-closed mode intended for agents or policy engines that must only read
 * debugger state: commands that are not explicitly known to be inspection
 * operations are denied. In particular, DAP `evaluate` and live `launch` /
 * `attach` are denied because they can execute code or control a target.
 * A narrowly recognized core/minidump attach is permitted so postmortem reads
 * remain usable without granting live-process attach authority.
 */
export function createDapRequestPolicy(mode: DapPolicyMode = 'standard'): DapRequestPolicy {
  if (mode === 'standard') return () => ALLOW;

  return ({ command, args }) => {
    if (INSPECT_ONLY_ALLOWED_COMMANDS.has(command)) return ALLOW;
    if (command === 'attach' && isInspectOnlyPostmortemAttach(args)) return ALLOW;
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
