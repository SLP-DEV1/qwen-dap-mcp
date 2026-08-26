import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { DapError } from '../dap/errors.js';
import { resolveExistingDirectory, resolveExistingFile } from '../local-path.js';

export type CodeLldbDiscoverySource = 'explicit' | 'environment' | 'extension' | 'path';

export type CodeLldbDiscoveryResult = {
  command: string;
  source: CodeLldbDiscoverySource;
  extensionDirectory?: string;
  searched: string[];
};

export type DiscoverCodeLldbOptions = {
  explicitPath?: string;
  extensionRoots?: string[];
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  allowPathFallback?: boolean;
};

export type CodeLldbLaunchOptions = {
  program: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stopOnEntry?: boolean;
};

export type CodeLldbAttachOptions = {
  pid: number;
  program?: string;
  stopOnEntry?: boolean;
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function executableName(): string {
  return process.platform === 'win32' ? 'codelldb.exe' : 'codelldb';
}

function defaultExtensionRoots(env: NodeJS.ProcessEnv, homeDirectory: string): string[] {
  const roots = [
    env.VSCODE_EXTENSIONS,
    join(homeDirectory, '.vscode', 'extensions'),
    join(homeDirectory, '.vscode-insiders', 'extensions'),
    join(homeDirectory, '.cursor', 'extensions'),
    join(homeDirectory, '.windsurf', 'extensions'),
    join(homeDirectory, '.vscode-oss', 'extensions'),
  ].filter((value): value is string => Boolean(value));

  return [...new Set(roots.map((root) => resolve(root)))];
}

function findExtensionAdapter(root: string, searched: string[]): CodeLldbDiscoveryResult | undefined {
  if (!existsSync(root)) {
    searched.push(root);
    return undefined;
  }

  let entries: string[];
  try {
    entries = readdirSync(root)
      .filter((entry) => entry.startsWith('vadimcn.vscode-lldb-'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
  } catch {
    searched.push(root);
    return undefined;
  }

  for (const entry of entries) {
    const extensionDirectory = join(root, entry);
    const candidate = join(extensionDirectory, 'adapter', executableName());
    searched.push(candidate);
    if (isFile(candidate)) {
      return {
        command: candidate,
        source: 'extension',
        extensionDirectory,
        searched,
      };
    }
  }

  return undefined;
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

  if (result.error || result.status !== 0 || !result.stdout) {
    return undefined;
  }

  const first = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  return first && isFile(first) ? first : undefined;
}

export function discoverCodeLldb(options: DiscoverCodeLldbOptions = {}): CodeLldbDiscoveryResult {
  const env = options.env ?? process.env;
  const searched: string[] = [];

  if (options.explicitPath) {
    const candidate = resolveExistingFile(options.explicitPath, 'CodeLLDB adapter');
    searched.push(candidate);
    return { command: candidate, source: 'explicit', searched };
  }

  if (env.CODELLDB_PATH) {
    const candidate = resolve(env.CODELLDB_PATH);
    searched.push(candidate);
    if (isFile(candidate)) {
      return { command: candidate, source: 'environment', searched };
    }
  }

  const roots =
    options.extensionRoots ?? defaultExtensionRoots(env, options.homeDirectory ?? homedir());
  for (const root of roots) {
    const found = findExtensionAdapter(resolve(root), searched);
    if (found) {
      return found;
    }
  }

  if (options.allowPathFallback !== false) {
    const onPath = findOnPath(executableName());
    searched.push(executableName());
    if (onPath) {
      return { command: onPath, source: 'path', searched };
    }
  }

  throw new Error(
    `CodeLLDB was not found. Install vadimcn.vscode-lldb >= 1.11.0, set CODELLDB_PATH, or pass adapterPath. Searched: ${searched.join(', ')}`,
  );
}

export function buildCodeLldbLaunchConfiguration(options: CodeLldbLaunchOptions): Record<string, unknown> {
  const program = resolveExistingFile(options.program, 'Program executable');
  const cwd = options.cwd
    ? resolveExistingDirectory(options.cwd, 'Working directory')
    : dirname(program);
  return {
    type: 'lldb',
    request: 'launch',
    name: 'qwen-dap-mcp CodeLLDB launch',
    program,
    args: options.args ?? [],
    cwd,
    ...(options.env ? { env: options.env } : {}),
    stopOnEntry: options.stopOnEntry ?? false,
    // Keep debuggee I/O inside DAP so the bridge never needs to honor runInTerminal.
    terminal: 'console',
  };
}

export function buildCodeLldbAttachConfiguration(options: CodeLldbAttachOptions): Record<string, unknown> {
  if (!Number.isSafeInteger(options.pid) || options.pid <= 0) {
    throw new DapError(`CodeLLDB attach PID must be a positive safe integer; received ${String(options.pid)}`);
  }
  const program = options.program
    ? resolveExistingFile(options.program, 'Program image')
    : undefined;
  return {
    type: 'lldb',
    request: 'attach',
    name: 'qwen-dap-mcp CodeLLDB attach',
    pid: options.pid,
    ...(program ? { program } : {}),
    stopOnEntry: options.stopOnEntry ?? true,
  };
}
