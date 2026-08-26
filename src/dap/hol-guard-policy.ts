import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DapError } from './errors.js';
import {
  createDapRequestPolicy,
  resolveDapPolicyMode,
  type DapPolicyMode,
  type DapRequestPolicy,
  type DapRequestPolicyContext,
} from './request-policy.js';

export type HolGuardAction =
  | {
      kind: 'dap-request';
      command: string;
      args?: unknown;
      cwd?: string;
    }
  | {
      kind: 'adapter-start';
      command: string;
      args: string[];
      cwd?: string;
    };

export type HolGuardDecision = {
  allow: boolean;
  action: string;
  reason: string;
};

export type HolGuardEvaluator = {
  readonly enabled: boolean;
  evaluate(action: HolGuardAction): HolGuardDecision;
};

export type HolGuardPolicyOptions = {
  enabled?: boolean;
  pythonCommand?: string;
  timeoutMs?: number;
  bridgePath?: string;
};

const HOL_GUARD_COMMANDS = new Set([
  'evaluate',
  'launch',
  'attach',
  'restart',
  'configurationDone',
  'continue',
  'next',
  'stepIn',
  'stepOut',
  'stepBack',
  'reverseContinue',
  'goto',
  'setVariable',
  'setExpression',
  'writeMemory',
  'terminate',
]);

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function parseEnabled(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') return false;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enforce'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  throw new DapError(
    `Unsupported QWEN_DAP_MCP_HOL_GUARD value '${value}'. Expected on/off, true/false, or 1/0.`,
  );
}

function parseTimeout(value: string | undefined): number {
  if (!value || value.trim() === '') return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > MAX_TIMEOUT_MS) {
    throw new DapError(
      `Invalid QWEN_DAP_MCP_HOL_GUARD_TIMEOUT_MS '${value}'. Expected 100-${MAX_TIMEOUT_MS}.`,
    );
  }
  return parsed;
}

function firstExecutableOnPath(name: string): string | undefined {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(finder, [name], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 2_000,
  });
  if (result.status !== 0 || !result.stdout) return undefined;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function pythonBesideHolGuard(): string | undefined {
  const executable = firstExecutableOnPath('hol-guard');
  if (!executable) return undefined;

  let resolved = executable;
  try {
    resolved = realpathSync(executable);
  } catch {
    // Keep the PATH result. On Windows it is usually already the pipx venv executable.
  }

  const candidate = join(dirname(resolved), process.platform === 'win32' ? 'python.exe' : 'python');
  return existsSync(candidate) ? candidate : undefined;
}

function resolvePythonCommand(explicit?: string): string {
  const configured = explicit?.trim() || process.env.QWEN_DAP_MCP_HOL_GUARD_PYTHON?.trim();
  if (configured) return configured;
  return pythonBesideHolGuard() ?? (process.platform === 'win32' ? 'python' : 'python3');
}

function defaultBridgePath(): string {
  return fileURLToPath(new URL('../../scripts/hol-guard-dap-policy.py', import.meta.url));
}

function truncate(value: string, max = 500): string {
  const compact = value.trim().replace(/\s+/g, ' ');
  return compact.length <= max ? compact : `${compact.slice(0, max)}…`;
}

function parseDecision(stdout: string): HolGuardDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new DapError('HOL Guard bridge returned invalid JSON', {
      cause: error instanceof Error ? error : undefined,
    });
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new DapError('HOL Guard bridge returned an invalid decision object');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.allow !== 'boolean' || typeof record.action !== 'string' || typeof record.reason !== 'string') {
    throw new DapError('HOL Guard bridge decision is missing allow/action/reason');
  }
  return { allow: record.allow, action: record.action, reason: record.reason };
}

export function createHolGuardEvaluator(options: HolGuardPolicyOptions = {}): HolGuardEvaluator {
  const enabled = options.enabled ?? parseEnabled(process.env.QWEN_DAP_MCP_HOL_GUARD);
  if (!enabled) {
    return {
      enabled: false,
      evaluate: () => ({ allow: true, action: 'allow', reason: 'HOL Guard integration disabled' }),
    };
  }

  const pythonCommand = resolvePythonCommand(options.pythonCommand);
  const bridgePath = options.bridgePath ?? defaultBridgePath();
  const timeoutMs = options.timeoutMs ?? parseTimeout(process.env.QWEN_DAP_MCP_HOL_GUARD_TIMEOUT_MS);

  return {
    enabled: true,
    evaluate(action) {
      if (!existsSync(bridgePath)) {
        throw new DapError(`HOL Guard bridge script not found: ${bridgePath}`);
      }

      const result = spawnSync(pythonCommand, [bridgePath], {
        input: `${JSON.stringify(action)}\n`,
        encoding: 'utf8',
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: process.env,
      });

      if (result.error) {
        throw new DapError(`HOL Guard policy process failed: ${result.error.message}`, { cause: result.error });
      }
      if (result.status !== 0) {
        const detail = truncate(result.stderr || result.stdout || `exit code ${String(result.status)}`);
        throw new DapError(`HOL Guard policy process failed closed: ${detail}`);
      }
      return parseDecision(result.stdout);
    },
  };
}

export function shouldConsultHolGuard(command: string): boolean {
  return HOL_GUARD_COMMANDS.has(command);
}

export function createGuardedDapRequestPolicy(
  evaluator: HolGuardEvaluator,
  policyMode: DapPolicyMode = resolveDapPolicyMode(),
): DapRequestPolicy {
  const builtIn = createDapRequestPolicy(policyMode);

  return (context: DapRequestPolicyContext) => {
    const localDecision = builtIn(context);
    if (!localDecision.allow) return localDecision;
    if (!evaluator.enabled || !shouldConsultHolGuard(context.command)) return localDecision;

    const decision = evaluator.evaluate({
      kind: 'dap-request',
      command: context.command,
      ...(context.args === undefined ? {} : { args: context.args }),
    });
    if (decision.allow) return { allow: true };
    return {
      allow: false,
      reason: `HOL Guard '${decision.action}': ${decision.reason}`,
    };
  };
}

export function requireHolGuardAdapterStart(
  evaluator: HolGuardEvaluator,
  options: { command: string; args?: string[]; cwd?: string },
): void {
  if (!evaluator.enabled) return;

  let decision: HolGuardDecision;
  try {
    decision = evaluator.evaluate({
      kind: 'adapter-start',
      command: options.command,
      args: options.args ?? [],
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
  } catch (error) {
    throw new DapError('HOL Guard adapter-start policy failed closed', {
      cause: error instanceof Error ? error : undefined,
    });
  }

  if (!decision.allow) {
    throw new DapError(`HOL Guard blocked DAP adapter start (${decision.action}): ${decision.reason}`);
  }
}
