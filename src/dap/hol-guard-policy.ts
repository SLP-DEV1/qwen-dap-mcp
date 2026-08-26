import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DapError } from './errors.js';
import { mergeEnvironment } from './environment.js';
import {
  createDapRequestPolicy,
  resolveDapPolicyMode,
  type DapPolicyMode,
  type DapRequestPolicy,
  type DapRequestPolicyContext,
  type DapRequestPolicyDecision,
  type DapRequestPolicyResult,
} from './request-policy.js';

export type HolGuardExecutionContext = {
  cwd?: string;
  adapterCommand?: string;
  adapterArgs?: string[];
  adapterResolvedCommand?: string;
  adapterExecutableHash?: string;
  adapterIdentityHash?: string;
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

const HOL_GUARD_COMMANDS = new Set([
  'attach',
  'configurationDone',
  'continue',
  'disconnect',
  'evaluate',
  'goto',
  'launch',
  'next',
  'pause',
  'restart',
  'restartFrame',
  'reverseContinue',
  'setBreakpoints',
  'setDataBreakpoints',
  'setExceptionBreakpoints',
  'setExpression',
  'setFunctionBreakpoints',
  'setInstructionBreakpoints',
  'setVariable',
  'stepBack',
  'stepIn',
  'stepOut',
  'terminate',
  'terminateThreads',
  'writeMemory',
]);

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const ADAPTER_IDENTITY_VERSION = 'qwen-dap-mcp-adapter-v1';
const REDACTED_MARKER = '__qwenDapMcpRedacted';

const BRIDGE_ENV_KEYS = new Set([
  'APPDATA',
  'COMSPEC',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'PYTHONIOENCODING',
  'PYTHONPATH',
  'PYTHONUTF8',
  'REQUESTS_CA_BUNDLE',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERPROFILE',
  'VIRTUAL_ENV',
  'WINDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
]);

const SENSITIVE_ARGUMENT_KEYS = new Set([
  'accesstoken',
  'apikey',
  'auth',
  'authorization',
  'bearer',
  'clientsecret',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'password',
  'passwd',
  'privatekey',
  'refreshtoken',
  'secret',
  'secretkey',
  'sessiontoken',
  'token',
]);

const ENVIRONMENT_ARGUMENT_KEYS = new Set(['env', 'environment', 'environmentvariables']);
const CLI_ARGUMENT_KEYS = new Set(['args', 'arguments', 'argv', 'commandlineargs', 'programargs']);

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
  let resolvedExecutable = executable;
  try {
    resolvedExecutable = realpathSync(executable);
  } catch {
    // Keep the PATH result. On Windows it is usually already the pipx venv executable.
  }
  const candidate = join(dirname(resolvedExecutable), process.platform === 'win32' ? 'python.exe' : 'python');
  return existsSync(candidate) ? candidate : undefined;
}

function resolvePythonCommand(explicit?: string): string {
  const configured = explicit?.trim() || process.env.QWEN_DAP_MCP_HOL_GUARD_PYTHON?.trim();
  if (configured) return configured;
  return pythonBesideHolGuard() ?? (process.platform === 'win32' ? 'python' : 'python3');
}

function defaultBridgePath(): string {
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

export function buildHolGuardBridgeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const normalized = key.toUpperCase();
    if (BRIDGE_ENV_KEYS.has(normalized) || normalized.startsWith('HOL_GUARD_')) output[key] = value;
  }
  return output;
}

function runBridge(
  pythonCommand: string,
  bridgePath: string,
  timeoutMs: number,
  action: HolGuardAction,
): Promise<HolGuardDecision> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(pythonCommand, [bridgePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      env: buildHolGuardBridgeEnvironment(),
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
      else resolvePromise(decision!);
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
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
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
  for (const [key, value] of Object.entries(mergeEnvironment(process.env, overrides))) {
    if (typeof value === 'string') merged[key] = value;
  }
  const entries = Object.entries(merged).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
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

function normalizedArgumentKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  }
  if (seen.has(value)) throw new DapError('DAP arguments contain a cycle and cannot be evaluated safely');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`;
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`);
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function redactedValue(value: unknown): Record<string, unknown> {
  const digest = createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
  return {
    [REDACTED_MARKER]: true,
    sha256: `sha256:${digest}`,
    valueType: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
  };
}

function redactedArgText(value: string): string {
  const digest = createHash('sha256').update(value, 'utf8').digest('hex');
  return `<redacted:sha256:${digest}>`;
}

function adapterFlagName(value: string): string {
  return normalizedArgumentKey(value.replace(/^--?/, '').split('=', 1)[0] ?? '');
}

export function sanitizeAdapterArgsForHolGuard(args: readonly string[]): string[] {
  const output: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const equals = arg.indexOf('=');
    if (equals > 0) {
      const left = arg.slice(0, equals);
      const right = arg.slice(equals + 1);
      if (SENSITIVE_ARGUMENT_KEYS.has(adapterFlagName(left))) {
        output.push(`${left}=${redactedArgText(right)}`);
        continue;
      }
    }
    const flag = adapterFlagName(arg);
    if (SENSITIVE_ARGUMENT_KEYS.has(flag) && index + 1 < args.length) {
      output.push(arg, redactedArgText(args[index + 1]!));
      index += 1;
      continue;
    }
    output.push(arg);
  }
  return output;
}

function sanitizeEnvironmentContainer(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') {
        const separator = item.indexOf('=');
        if (separator > 0) {
          return `${item.slice(0, separator)}=${redactedArgText(item.slice(separator + 1))}`;
        }
        return redactedValue(item);
      }
      if (item && typeof item === 'object') {
        const output: Record<string, unknown> = {};
        for (const [key, nested] of Object.entries(item as Record<string, unknown>)) {
          output[key] = normalizedArgumentKey(key) === 'value'
            ? redactedValue(nested)
            : sanitizeValue(nested, key);
        }
        return output;
      }
      return redactedValue(item);
    });
  }
  if (value && typeof value === 'object') {
    const environment: Record<string, unknown> = {};
    for (const [envKey, envValue] of Object.entries(value as Record<string, unknown>)) {
      environment[envKey] = redactedValue(envValue);
    }
    return environment;
  }
  return redactedValue(value);
}

function sanitizeValue(value: unknown, keyHint?: string): unknown {
  const normalizedKey = keyHint === undefined ? undefined : normalizedArgumentKey(keyHint);
  if (normalizedKey && SENSITIVE_ARGUMENT_KEYS.has(normalizedKey)) return redactedValue(value);
  if (normalizedKey && ENVIRONMENT_ARGUMENT_KEYS.has(normalizedKey)) return sanitizeEnvironmentContainer(value);
  if (
    normalizedKey
    && CLI_ARGUMENT_KEYS.has(normalizedKey)
    && Array.isArray(value)
    && value.every((item) => typeof item === 'string')
  ) {
    return sanitizeAdapterArgsForHolGuard(value as string[]);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    output[key] = sanitizeValue(item, key);
  }
  return output;
}

export function sanitizeDapArgumentsForHolGuard(args: unknown): unknown {
  return sanitizeValue(args);
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (process.platform !== 'win32') return env[name];
  const target = name.toUpperCase();
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === target);
  return key === undefined ? undefined : env[key];
}

function executableNames(command: string, env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32' || extname(command)) return [command];
  const extensions = (envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD')
    .split(';').map((value) => value.trim()).filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension}`)];
}

function executableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function realExecutable(path: string): string | undefined {
  if (!executableFile(path)) return undefined;
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function resolveAdapterExecutable(
  command: string,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const baseCwd = cwd ? resolve(cwd) : process.cwd();
  const pathLike = isAbsolute(command) || command.includes('/') || command.includes('\\');
  if (pathLike) {
    const base = isAbsolute(command) ? command : resolve(baseCwd, command);
    for (const candidate of executableNames(base, env)) {
      const found = realExecutable(candidate);
      if (found) return found;
    }
    return undefined;
  }
  const pathValue = envValue(env, 'PATH') ?? '';
  for (const pathEntry of pathValue.split(delimiter)) {
    const directory = pathEntry ? (isAbsolute(pathEntry) ? pathEntry : resolve(baseCwd, pathEntry)) : baseCwd;
    for (const name of executableNames(command, env)) {
      const found = realExecutable(resolve(directory, name));
      if (found) return found;
    }
  }
  return undefined;
}

function hashExecutable(path: string): string {
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  return `sha256:${digest}`;
}

function buildAdapterIdentityHash(context: HolGuardExecutionContext, rawArgs: readonly string[]): string {
  const material = {
    version: ADAPTER_IDENTITY_VERSION,
    command: context.adapterCommand ?? null,
    args: rawArgs,
    resolvedCommand: context.adapterResolvedCommand ?? null,
    executableHash: context.adapterExecutableHash ?? null,
    cwd: context.cwd ?? null,
    envHash: context.envHash ?? null,
    envKeys: context.envKeys ?? [],
  };
  const digest = createHash('sha256').update(JSON.stringify(material), 'utf8').digest('hex');
  return `sha256:${digest}`;
}

function decisionReason(decision: HolGuardDecision): string {
  const approvalHint = decision.reviewCommand
    ? `; approval: ${decision.reviewCommand}`
    : decision.approvalRequestId
      ? `; approval request: ${decision.approvalRequestId}`
      : '';
  return `HOL Guard '${decision.action}': ${decision.reason}${approvalHint}`;
}

function isPolicyPromise(value: DapRequestPolicyResult): value is Promise<DapRequestPolicyDecision> {
  return typeof (value as { then?: unknown }).then === 'function';
}

export function createHolGuardEvaluator(options: HolGuardPolicyOptions = {}): HolGuardEvaluator {
  const enabled = options.enabled ?? parseEnabled(process.env.QWEN_DAP_MCP_HOL_GUARD);
  if (!enabled) {
    return { enabled: false, evaluate: async () => ({ allow: true, action: 'allow', reason: 'HOL Guard integration disabled' }) };
  }
  const pythonCommand = resolvePythonCommand(options.pythonCommand);
  const bridgePath = options.bridgePath ?? defaultBridgePath();
  const timeoutMs = options.timeoutMs ?? parseTimeout(process.env.QWEN_DAP_MCP_HOL_GUARD_TIMEOUT_MS);
  return {
    enabled: true,
    async evaluate(action) {
      if (!existsSync(bridgePath)) throw new DapError(`HOL Guard bridge script not found: ${bridgePath}`);
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
  const applyHolGuard = (
    context: DapRequestPolicyContext,
    localDecision: DapRequestPolicyDecision,
  ): DapRequestPolicyResult => {
    if (!localDecision.allow) return localDecision;
    if (!evaluator.enabled || !shouldConsultHolGuard(context.command)) return localDecision;
    const executionContext = contextProvider?.() ?? {};
    return evaluator.evaluate({
      kind: 'dap-request',
      command: context.command,
      ...(context.args === undefined ? {} : { args: sanitizeDapArgumentsForHolGuard(context.args) }),
      ...executionContext,
    }).then((decision) => decision.allow
      ? { allow: true } as const
      : { allow: false as const, reason: decisionReason(decision) });
  };
  return (context: DapRequestPolicyContext) => {
    const localResult = builtIn(context);
    return isPolicyPromise(localResult)
      ? localResult.then((decision) => applyHolGuard(context, decision))
      : applyHolGuard(context, localResult);
  };
}

export async function requireHolGuardAdapterStart(
  evaluator: HolGuardEvaluator,
  options: { command: string; args?: string[]; cwd?: string; env?: Record<string, string> },
): Promise<HolGuardExecutionContext> {
  const rawArgs = options.args ?? [];
  const environment = buildHolGuardEnvironmentFingerprint(options.env);
  const baseContext: HolGuardExecutionContext = {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    adapterCommand: options.command,
    adapterArgs: sanitizeAdapterArgsForHolGuard(rawArgs),
    ...environment,
  };
  if (!evaluator.enabled) return baseContext;

  const effectiveEnv = mergeEnvironment(process.env, options.env);
  const resolvedCommand = resolveAdapterExecutable(options.command, options.cwd, effectiveEnv);
  const executableHash = resolvedCommand ? hashExecutable(resolvedCommand) : undefined;
  const context: HolGuardExecutionContext = {
    ...baseContext,
    ...(resolvedCommand ? { adapterResolvedCommand: resolvedCommand } : {}),
    ...(executableHash ? { adapterExecutableHash: executableHash } : {}),
  };
  context.adapterIdentityHash = buildAdapterIdentityHash(context, rawArgs);

  let decision: HolGuardDecision;
  try {
    decision = await evaluator.evaluate({
      kind: 'adapter-start',
      command: options.command,
      args: sanitizeAdapterArgsForHolGuard(rawArgs),
      ...context,
    });
  } catch (error) {
    throw new DapError('HOL Guard adapter-start policy failed closed', {
      cause: error instanceof Error ? error : undefined,
    });
  }
  if (!decision.allow) throw new DapError(`HOL Guard blocked DAP adapter start: ${decisionReason(decision)}`);
  if (!resolvedCommand || !executableHash) {
    throw new DapError(`HOL Guard allowed adapter start but executable identity could not be resolved for '${options.command}'`);
  }
  const currentHash = hashExecutable(resolvedCommand);
  if (currentHash !== executableHash) {
    throw new DapError('HOL Guard adapter executable changed after policy approval; refusing to spawn it');
  }
  return context;
}
