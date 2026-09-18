import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { DapError } from '../dap/errors.js';
import { resolveExistingDirectory, resolveExistingFile } from '../local-path.js';

export type RrDiscoveryResult = {
  command: string;
  version: string;
  source: 'explicit' | 'environment' | 'path';
  searched: string[];
};

export type RrRecordOptions = {
  program: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  traceDir?: string;
  timeoutMs?: number;
  rrPath?: string;
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findOnPath(command: string): string | undefined {
  const result = spawnSync('which', [command], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0 || !result.stdout) return undefined;
  const first = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return first && isFile(first) ? first : undefined;
}

function probeVersion(command: string): string {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 8_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new DapError(`Unable to execute rr at '${command}': ${result.error?.message ?? result.stderr?.trim() ?? `exit ${String(result.status)}`}`);
  }
  const version = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!version || !/\brr\b/i.test(version)) {
    throw new DapError(`Unable to parse rr version from '${command}'.`);
  }
  return version.slice(0, 300);
}

export function discoverRr(options: { explicitPath?: string; env?: NodeJS.ProcessEnv } = {}): RrDiscoveryResult {
  if (process.platform !== 'linux') {
    throw new DapError('rr integration is supported only on Linux hosts.');
  }
  const env = options.env ?? process.env;
  const searched: string[] = [];

  if (options.explicitPath) {
    const command = resolveExistingFile(options.explicitPath, 'rr executable');
    searched.push(command);
    return { command, version: probeVersion(command), source: 'explicit', searched };
  }

  if (env.RR_PATH?.trim()) {
    const command = resolve(env.RR_PATH);
    searched.push(command);
    if (isFile(command)) {
      return { command, version: probeVersion(command), source: 'environment', searched };
    }
  }

  searched.push('rr');
  const command = findOnPath('rr');
  if (command) return { command, version: probeVersion(command), source: 'path', searched };

  throw new DapError(`rr was not found. Install rr, set RR_PATH, or pass rrPath. Searched: ${searched.join(', ')}`);
}

export function buildRrReplayPlan(options: {
  traceDir: string;
  port: number;
  rrPath?: string;
}) {
  const rr = discoverRr({ ...(options.rrPath ? { explicitPath: options.rrPath } : {}) });
  const traceDir = resolveExistingDirectory(options.traceDir, 'rr trace directory');
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new DapError(`rr replay port must be an integer from 1 to 65535; received ${String(options.port)}`);
  }
  return {
    rr,
    traceDir,
    command: rr.command,
    args: ['replay', '-s', String(options.port), traceDir],
    gdbRemote: {
      host: '127.0.0.1',
      port: options.port,
      target: `127.0.0.1:${options.port}`,
    },
    next: 'Start this fixed rr replay command outside or through an explicitly authorized process runner, then attach qwen-dap-mcp with its existing validated GDB remote helper to 127.0.0.1:port.',
    safety: 'The plan is loopback-only and does not execute arbitrary debugger command strings.',
  };
}

export function recordWithRr(options: RrRecordOptions) {
  const rr = discoverRr({ ...(options.rrPath ? { explicitPath: options.rrPath } : {}) });
  const program = resolveExistingFile(options.program, 'rr recording program');
  const cwd = options.cwd
    ? resolveExistingDirectory(options.cwd, 'rr recording working directory')
    : dirname(program);
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    throw new DapError('rr recording timeoutMs must be between 1000 and 600000.');
  }

  let traceDir: string | undefined;
  if (options.traceDir?.trim()) {
    traceDir = resolve(options.traceDir);
    resolveExistingDirectory(dirname(traceDir), 'rr trace parent directory');
    if (existsSync(traceDir)) {
      throw new DapError(`rr trace output path already exists at '${traceDir}'. Choose a new traceDir to avoid overwriting existing evidence.`);
    }
  }

  const args = [
    'record',
    ...(traceDir ? ['-o', traceDir] : []),
    program,
    ...(options.args ?? []),
  ];
  const result = spawnSync(rr.command, args, {
    cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 512 * 1024,
  });

  if (result.error) {
    const timeout = (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    throw new DapError(timeout
      ? `rr recording exceeded the ${timeoutMs} ms bound.`
      : `rr recording failed: ${result.error.message}`);
  }

  return {
    rr,
    program,
    cwd,
    requestedTraceDir: traceDir,
    exitStatus: result.status,
    signal: result.signal,
    success: result.status === 0,
    stdout: (result.stdout ?? '').slice(-64 * 1024),
    stderr: (result.stderr ?? '').slice(-64 * 1024),
    commandIdentity: {
      command: rr.command,
      args,
      shell: false,
    },
    note: 'Recording executes the explicitly supplied target program under rr. Treat target side effects exactly as a normal local program launch.',
  };
}
