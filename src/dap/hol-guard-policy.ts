import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DapError } from './errors.js';
import {
  createDapRequestPolicy,
  resolveDapPolicyMode,
  type DapPolicyMode,
  type DapRequestPolicy,
  type DapRequestPolicyContext,
} from './request-policy.js';

export type HolGuardExecutionContext = {
  cwd?: string;
  adapterCommand?: string;
  adapterArgs?: string[];
  envKeys?: string[];
  envHash?: string;
};

export type HolGuardAction =
  | ({
      kind: 'dap-request';
      command: string;
      args?: unknown;
    } & HolGuardExecutionContext)
  | ({
      kind: 'adapter-start';
      command: string;
      args: string[];
    } & HolGuardExecutionContext);

export type HolGuardDecision = {
  allow: boolean;
  action: string;
  reason: string;
  source?: string;
  guardVersion?: string;
  approvalRequestId?: string;
  approvalCenterUrl?: string;
  reviewCommand?: string;
};

export type HolGuardEvaluator = {
  readonly enabled: boolean;
  evaluate(action: HolGuardAction): Promise<HolGuardDecision>;
};

export type HolGuardPolicyOptions = {
  enabled?: boolean;
  pythonCommand?: string;
  timeoutMs?: number;
  bridgePath?: string;
};

// evaluate can execute arbitrary expressions, launch starts a target, and
// attach can bind the agent to the wrong live process. Read-only inspection
// stays on the zero-overhead path.
const HOL_GUARD_COMMANDS = new Set(['evaluate', 'launch', 'attach']);

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
  // Normal npm/source layout: dist/dap/hol-guard-policy.js -> ../../scripts.
  // Bundled Qwen extension layout: dist/index.js -> ../scripts.
  const candidates = [
    fileURLToPath(new URL('../../scripts/hol-guard-dap-policy.py', import.meta.url)),
    fileURLToPath(new URL('../scripts/hol-guard-dap-policy.py', import.meta.url)),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function truncate(value: string, max = 500): string {
  const compact = value.trim().replace(/\s+/g, ' ');
  return compact.length <= max ? compact : `${compact.slice(0, max)}…`;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
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
  return {
    allow: record.allow,
    action: record.action,
    reason: record.reason,
    ...(optionalString(record, 'source') ? { source: optionalString(record, 'source') } : {}),
    ...(optionalString(record, 'guardVersion') ? { guardVersion: optionalString(record, 'guardVersion') } : {}),
    ...(optionalString(record, 'approvalRequestId') ? { approvalRequestId: optionalString(record, 'approvalRequestId') } : {}),
    ...(optionalString(record, 'approvalCenterUrl') ? { approvalCenterUrl: optionalString(record, 'approvalCenterUrl') } : {}),
    ...(optionalString(record, 'reviewCommand') ? { reviewCommand: optionalString(record, 'reviewCommand') } : {}),
  };
}

function runBridge(
  pythonCommand: string,
  bridgePath: string,
  timeoutMs: number,
  action: HolGuardAction,
): Promise<HolGuardDecision> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonCommand, [bridgePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;

    const finish = (error?: Error, decision?: HolGuardDecision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(decision!);
    };
    const append = (current: string, chunk: Buffer | string): string => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      outputBytes += Buffer.byteLength(text, 'utf8');
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(new DapError(`HOL Guard bridge output exceeded ${MAX_OUTPUT_BYTES} bytes`));
        return current;
      }
      return current + text;
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new DapError(`HOL Guard policy process timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', (error) => {
      finish(new DapError(`HOL Guard policy process failed: ${error.message}`, { cause: error }));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = truncate(stderr || stdout || (signal ? `signal ${signal}` : `exit code ${String(code)}`));
        finish(new DapError(`HOL Guard policy process failed closed: ${detail}`));
        return;
      }
      try {
        finish(undefined, parseDecision(stdout));
      } catch (error) {
        finish(error instanceof Error ? error : new DapError(String(error)));
      }
    });
    child.stdin.on('error', (error) => {
      finish(new DapError(`HOL Guard bridge stdin failed: ${error.message}`, { cause: error }));
    });
    child.stdin.end(`${JSON.stringify(action)}\n`);
  });
}

export function buildHolGuardEnvironmentFingerprint(
  overrides: Record<string, string> | undefined,
): Pick<HolGuardExecutionContext, 'envKeys' | 'envHash'> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') merged[key] = value;
  }
  Object.assign(merged, overrides ?? {});

  const entries = Object.entries(merged).sort(([left], [right]) => left.localeCompare(right));
  const hash = createHash('sha256');
  for (const [key, value] of entries) {
    hash.update(key, 'utf8');
    hash.update('\0');
    hash.update(value, 'utf8');
    hash.update('\0');
  }
  return {
    envKeys: entries.map(([key]) => key),
    envHash: `sha256:${hash.digest('hex')}`,
  };
}

function decisionReason(decision: HolGuardDecision): string {
  const approvalHint = decision.reviewCommand
    ? `; approval: ${decision.reviewCommand}`
    : decision.approvalRequestId
      ? `; approval request: ${decision.approvalRequestId}`
      : '';
  return `HOL Guard '${decision.action}': ${decision.reason}${approvalHint}`;
}

export function createHolGuardEvaluator(options: HolGuardPolicyOptions = {}): HolGuardEvaluator {
  const enabled = options.enabled ?? parseEnabled(process.env.QWEN_DAP_MCP_HOL_GUARD);
  if (!enabled) {
    return {
      enabled: false,
      evaluate: async () => ({ allow: true, action: 'allow', reason: 'HOL Guard integration disabled' }),
    };
  }

  const pythonCommand = resolvePythonCommand(options.pythonCommand);
  const bridgePath = options.bridgePath ?? defaultBridgePath();
  const timeoutMs = options.timeoutMs ?? parseTimeout(process.env.QWEN_DAP_MCP_HOL_GUARD_TIMEOUT_MS);

  return {
    enabled: true,
    async evaluate(action) {
      if (!existsSync(bridgePath)) {
        throw new DapError(`HOL Guard bridge script not found: ${bridgePath}`);
      }
      return runBridge(pythonCommand, bridgePath, timeoutMs, action);
    },
  };
}

export function shouldConsultHolGuard(command: string): boolean {
  return HOL_GUARD_COMMANDS.has(command);
}

export function createGuardedDapRequestPolicy(
  evaluator: HolGuardEvaluator,
  policyMode: DapPolicyMode = resolveDapPolicyMode(),
  contextProvider?: () => HolGuardExecutionContext | undefined,
): DapRequestPolicy {
  const builtIn = createDapRequestPolicy(policyMode);

  return async (context: DapRequestPolicyContext) => {
    const localDecision = await builtIn(context);
    if (!localDecision.allow) return localDecision;
    if (!evaluator.enabled || !shouldConsultHolGuard(context.command)) return localDecision;

    const executionContext = contextProvider?.() ?? {};
    const decision = await evaluator.evaluate({
      kind: 'dap-request',
      command: context.command,
      ...(context.args === undefined ? {} : { args: context.args }),
      ...executionContext,
    });
    if (decision.allow) return { allow: true };
    return {
      allow: false,
      reason: decisionReason(decision),
    };
  };
}

export async function requireHolGuardAdapterStart(
  evaluator: HolGuardEvaluator,
  options: { command: string; args?: string[]; cwd?: string; env?: Record<string, string> },
): Promise<HolGuardExecutionContext> {
  const environment = buildHolGuardEnvironmentFingerprint(options.env);
  const context: HolGuardExecutionContext = {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    adapterCommand: options.command,
    adapterArgs: options.args ?? [],
    ...environment,
  };
  if (!evaluator.enabled) return context;

  let decision: HolGuardDecision;
  try {
    decision = await evaluator.evaluate({
      kind: 'adapter-start',
      command: options.command,
      args: options.args ?? [],
      ...context,
    });
  } catch (error) {
    throw new DapError('HOL Guard adapter-start policy failed closed', {
      cause: error instanceof Error ? error : undefined,
    });
  }

  if (!decision.allow) {
    throw new DapError(`HOL Guard blocked DAP adapter start: ${decisionReason(decision)}`);
  }
  return context;
}
