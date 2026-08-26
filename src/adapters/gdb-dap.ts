import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { DapError } from '../dap/errors.js';
import { resolveExistingDirectory, resolveExistingFile } from '../local-path.js';
import {
  buildRemoteTcpEndpoint,
  parseRemoteTcpTarget,
  type RemoteTcpEndpoint,
} from '../remote-endpoint.js';

export const MIN_GDB_DAP_MAJOR = 14;

export type GdbDapDiscoverySource = 'explicit' | 'environment' | 'home' | 'path';

export type GdbDapVersion = {
  major: number;
  minor?: number;
  raw: string;
};

export type GdbDapDiscoveryResult = {
  command: string;
  args: string[];
  source: GdbDapDiscoverySource;
  searched: string[];
  version: GdbDapVersion;
};

export type DiscoverGdbDapOptions = {
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
  allowPathFallback?: boolean;
};

export type GdbDapLaunchOptions = {
  program: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stopOnEntry?: boolean;
  stopAtBeginningOfMainSubprogram?: boolean;
};

export type GdbDapPidAttachOptions = {
  pid: number;
  program?: string;
};

export type GdbDapRemoteAttachOptions = {
  /** Backward-compatible TCP host:port form. Non-TCP GDB target strings are rejected. */
  target?: string;
  host?: string;
  port?: number;
  program?: string;
  policyEnv?: NodeJS.ProcessEnv;
};

export type GdbDapCoreOptions = {
  coreFile: string;
  program?: string;
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function executableNames(): string[] {
  if (process.platform === 'win32') return ['gdb.exe'];
  return ['gdb', 'gdb-19', 'gdb-18', 'gdb-17', 'gdb-16', 'gdb-15', 'gdb-14'];
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
  const first = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return first && isFile(first) ? first : undefined;
}

export function parseGdbVersion(output: string): GdbDapVersion | undefined {
  const firstLine = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  const match = firstLine.match(/\b(?:GNU\s+)?gdb(?:\s+\([^)]*\))?\s+(\d+)(?:\.(\d+))?/i)
    ?? output.match(/\bgdb[^\d]*(\d+)(?:\.(\d+))?/i);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    ...(match[2] === undefined ? {} : { minor: Number(match[2]) }),
    raw: firstLine || match[0],
  };
}

function probeGdbVersion(command: string): GdbDapVersion {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: 8_000,
    maxBuffer: 128 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new DapError(`Unable to execute GDB at ${command}: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${String(result.status)}`}`);
  }
  const version = parseGdbVersion(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (!version) throw new DapError(`Unable to parse GDB version from ${command}.`);
  if (version.major < MIN_GDB_DAP_MAJOR) {
    throw new DapError(`GDB ${version.major}${version.minor === undefined ? '' : `.${version.minor}`} is too old for the built-in DAP interpreter. GDB ${MIN_GDB_DAP_MAJOR}+ is required.`);
  }
  return version;
}

function resultFor(command: string, source: GdbDapDiscoverySource, searched: string[]): GdbDapDiscoveryResult {
  return {
    command,
    args: ['--interpreter=dap', '--quiet', '--nx'],
    source,
    searched,
    version: probeGdbVersion(command),
  };
}

export function discoverGdbDap(options: DiscoverGdbDapOptions = {}): GdbDapDiscoveryResult {
  const env = options.env ?? process.env;
  const searched: string[] = [];

  if (options.explicitPath) {
    const candidate = resolveExistingFile(options.explicitPath, 'GDB executable');
    searched.push(candidate);
    return resultFor(candidate, 'explicit', searched);
  }

  for (const key of ['GDB_DAP_PATH', 'GDB_PATH'] as const) {
    const raw = env[key];
    if (!raw) continue;
    const candidate = resolve(raw);
    searched.push(candidate);
    if (isFile(candidate)) return resultFor(candidate, 'environment', searched);
  }

  if (env.GDB_HOME) {
    const candidate = join(resolve(env.GDB_HOME), 'bin', process.platform === 'win32' ? 'gdb.exe' : 'gdb');
    searched.push(candidate);
    if (isFile(candidate)) return resultFor(candidate, 'home', searched);
  }

  if (options.allowPathFallback !== false) {
    for (const name of executableNames()) {
      searched.push(name);
      const candidate = findOnPath(name);
      if (candidate) return resultFor(candidate, 'path', searched);
    }
  }

  throw new DapError(
    `GDB with DAP support was not found. Install GDB ${MIN_GDB_DAP_MAJOR}+, set GDB_PATH/GDB_DAP_PATH/GDB_HOME, or pass adapterPath. Searched: ${searched.join(', ')}`,
  );
}

export function buildGdbDapLaunchConfiguration(options: GdbDapLaunchOptions): Record<string, unknown> {
  const program = resolveExistingFile(options.program, 'Program executable');
  const cwd = options.cwd
    ? resolveExistingDirectory(options.cwd, 'Working directory')
    : dirname(program);
  return {
    program,
    args: options.args ?? [],
    cwd,
    ...(options.env ? { env: options.env } : {}),
    stopOnEntry: options.stopOnEntry ?? false,
    ...(options.stopAtBeginningOfMainSubprogram === undefined
      ? {}
      : { stopAtBeginningOfMainSubprogram: options.stopAtBeginningOfMainSubprogram }),
  };
}

export function buildGdbDapPidAttachConfiguration(options: GdbDapPidAttachOptions): Record<string, unknown> {
  if (!Number.isSafeInteger(options.pid) || options.pid <= 0) {
    throw new DapError(`GDB attach PID must be a positive safe integer; received ${String(options.pid)}`);
  }
  return {
    pid: options.pid,
    ...(options.program ? { program: resolveExistingFile(options.program, 'Program image') } : {}),
  };
}

export function resolveGdbDapRemoteEndpoint(options: GdbDapRemoteAttachOptions): RemoteTcpEndpoint {
  const hasTarget = typeof options.target === 'string' && options.target.trim().length > 0;
  const hasHost = typeof options.host === 'string' && options.host.trim().length > 0;
  const hasPort = options.port !== undefined;

  if (hasTarget && (hasHost || hasPort)) {
    throw new DapError('Specify either target or host+port for GDB remote attach, not both forms.');
  }
  if (hasTarget) return parseRemoteTcpTarget(options.target as string, options.policyEnv);
  if (!hasHost || !hasPort) {
    throw new DapError('GDB remote attach requires host and port (or the backward-compatible TCP target form).');
  }
  return buildRemoteTcpEndpoint(options.host as string, options.port as number, options.policyEnv);
}

export function buildGdbDapRemoteAttachConfiguration(options: GdbDapRemoteAttachOptions): Record<string, unknown> {
  const endpoint = resolveGdbDapRemoteEndpoint(options);
  return {
    target: endpoint.target,
    ...(options.program ? { program: resolveExistingFile(options.program, 'Program image') } : {}),
  };
}

export function buildGdbDapCoreConfiguration(options: GdbDapCoreOptions): Record<string, unknown> {
  return {
    coreFile: resolveExistingFile(options.coreFile, 'Crash dump'),
    ...(options.program ? { program: resolveExistingFile(options.program, 'Program image') } : {}),
  };
}
