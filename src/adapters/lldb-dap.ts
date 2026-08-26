import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { DapError } from '../dap/errors.js';
import { resolveExistingDirectory, resolveExistingFile } from '../local-path.js';

export type LldbDapDiscoverySource = 'explicit' | 'environment' | 'path' | 'toolchain' | 'xcrun';

export type LldbDapDiscoveryResult = {
  command: string;
  source: LldbDapDiscoverySource;
  searched: string[];
};

export type DiscoverLldbDapOptions = {
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
  toolchainCandidates?: string[];
  allowPathFallback?: boolean;
  allowToolchainFallback?: boolean;
  allowXcrunFallback?: boolean;
};

export type LldbDapLaunchOptions = {
  program: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stopOnEntry?: boolean;
};

export type LldbDapAttachOptions = {
  pid: number;
  program?: string;
  stopOnEntry?: boolean;
};

export type LldbDapCoreOptions = {
  coreFile: string;
  program: string;
  sourceMap?: Record<string, string>;
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const LLVM_VERSIONS = ['23', '22', '21', '20', '19', '18', '17'];

function executableNames(): string[] {
  if (process.platform === 'win32') return ['lldb-dap.exe'];
  return ['lldb-dap', ...LLVM_VERSIONS.map((version) => `lldb-dap-${version}`)];
}

function defaultToolchainCandidates(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];

  if (env.LLVM_HOME) {
    candidates.push(join(resolve(env.LLVM_HOME), 'bin', process.platform === 'win32' ? 'lldb-dap.exe' : 'lldb-dap'));
  }

  if (process.platform === 'linux') {
    for (const version of LLVM_VERSIONS) {
      candidates.push(`/usr/lib/llvm-${version}/bin/lldb-dap`);
    }
  } else if (process.platform === 'win32') {
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)']].filter((value): value is string => Boolean(value))) {
      candidates.push(join(root, 'LLVM', 'bin', 'lldb-dap.exe'));
    }
  }

  return [...new Set(candidates)];
}

function findOnPath(command: string): string | undefined {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [command], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });

  if (result.error || result.status !== 0 || !result.stdout) return undefined;
  const first = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return first && isFile(first) ? first : undefined;
}

function findWithXcrun(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  const result = spawnSync('xcrun', ['--find', 'lldb-dap'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0 || !result.stdout) return undefined;
  const candidate = result.stdout.trim();
  return candidate && isFile(candidate) ? candidate : undefined;
}

export function discoverLldbDap(options: DiscoverLldbDapOptions = {}): LldbDapDiscoveryResult {
  const env = options.env ?? process.env;
  const searched: string[] = [];

  if (options.explicitPath) {
    const candidate = resolveExistingFile(options.explicitPath, 'lldb-dap adapter');
    searched.push(candidate);
    return { command: candidate, source: 'explicit', searched };
  }

  if (env.LLDB_DAP_PATH) {
    const candidate = resolve(env.LLDB_DAP_PATH);
    searched.push(candidate);
    if (isFile(candidate)) return { command: candidate, source: 'environment', searched };
  }

  if (options.allowPathFallback !== false) {
    for (const name of executableNames()) {
      searched.push(name);
      const candidate = findOnPath(name);
      if (candidate) return { command: candidate, source: 'path', searched };
    }
  }

  if (options.allowToolchainFallback !== false) {
    for (const rawCandidate of options.toolchainCandidates ?? defaultToolchainCandidates(env)) {
      const candidate = resolve(rawCandidate);
      searched.push(candidate);
      if (isFile(candidate)) return { command: candidate, source: 'toolchain', searched };
    }
  }

  if (options.allowXcrunFallback !== false && process.platform === 'darwin') {
    searched.push('xcrun --find lldb-dap');
    const candidate = findWithXcrun();
    if (candidate) return { command: candidate, source: 'xcrun', searched };
  }

  throw new Error(
    `lldb-dap was not found. Install LLDB, set LLDB_DAP_PATH/LLVM_HOME, or pass adapterPath. Searched: ${searched.join(', ')}`,
  );
}

export function buildLldbDapLaunchConfiguration(options: LldbDapLaunchOptions): Record<string, unknown> {
  const program = resolveExistingFile(options.program, 'Program executable');
  const cwd = options.cwd
    ? resolveExistingDirectory(options.cwd, 'Working directory')
    : dirname(program);

  return {
    type: 'lldb-dap',
    request: 'launch',
    name: 'qwen-dap-mcp lldb-dap launch',
    program,
    args: options.args ?? [],
    cwd,
    ...(options.env ? { env: options.env } : {}),
    stopOnEntry: options.stopOnEntry ?? false,
  };
}

export function buildLldbDapAttachConfiguration(options: LldbDapAttachOptions): Record<string, unknown> {
  if (!Number.isSafeInteger(options.pid) || options.pid <= 0) {
    throw new DapError(`lldb-dap attach PID must be a positive safe integer; received ${String(options.pid)}`);
  }
  const program = options.program
    ? resolveExistingFile(options.program, 'Program image')
    : undefined;

  return {
    type: 'lldb-dap',
    request: 'attach',
    name: 'qwen-dap-mcp lldb-dap attach',
    pid: options.pid,
    ...(program ? { program } : {}),
    stopOnEntry: options.stopOnEntry ?? true,
  };
}

export function buildLldbDapCoreConfiguration(options: LldbDapCoreOptions): Record<string, unknown> {
  const coreFile = resolveExistingFile(options.coreFile, 'Crash dump');
  const program = resolveExistingFile(options.program, 'Program image');

  return {
    type: 'lldb-dap',
    request: 'attach',
    name: 'qwen-dap-mcp lldb-dap core file',
    coreFile,
    program,
    ...(options.sourceMap ? { sourceMap: Object.entries(options.sourceMap) } : {}),
  };
}
