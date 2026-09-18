import { readdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DebugProtocol } from '@vscode/debugprotocol';

import { resolveExistingDirectory, resolveExistingFile } from '../local-path.js';

type ToolProbe = {
  command?: string;
  output?: string;
  error?: string;
};

export type BinaryIdentity = {
  path: string;
  format: 'elf' | 'pe' | 'macho' | 'unknown';
  buildId?: string;
  uuid?: string;
  pdb?: {
    path?: string;
    guid?: string;
    age?: string;
  };
  probes: ToolProbe[];
};

export function resolveSymbolInspectionTool(name: string, envName: string): string | undefined {
  const configured = process.env[envName]?.trim();
  if (configured) return resolveExistingFile(configured, `${name} executable`);
  return commandOnPath(name);
}

function commandOnPath(name: string): string | undefined {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [name], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 4_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0 || !result.stdout) return undefined;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function run(command: string | undefined, args: string[]): ToolProbe {
  if (!command) return { error: 'tool-not-found' };
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 8_000,
    maxBuffer: 512 * 1024,
  });
  if (result.error || result.status !== 0) {
    return {
      command,
      output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(-64 * 1024),
      error: result.error?.message ?? `exit-${String(result.status)}`,
    };
  }
  return {
    command,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(-128 * 1024),
  };
}

function normalizedId(value: string | undefined): string | undefined {
  return value?.replace(/[{}\-\s]/g, '').toLowerCase();
}

export function inspectBinaryIdentity(input: string): BinaryIdentity {
  const path = resolveExistingFile(input, 'Binary image');
  const extension = extname(path).toLowerCase();
  const probes: ToolProbe[] = [];

  if (process.platform !== 'win32' || ['.so', '.elf', ''].includes(extension)) {
    const readelf = commandOnPath('readelf') ?? commandOnPath('llvm-readelf');
    const probe = run(readelf, ['-n', path]);
    probes.push(probe);
    const buildId = probe.output?.match(/Build ID:\s*([0-9a-f]+)/i)?.[1];
    if (buildId) return { path, format: 'elf', buildId: buildId.toLowerCase(), probes };
  }

  const llvmReadobj = resolveSymbolInspectionTool('llvm-readobj', 'QWEN_DAP_MCP_LLVM_READOBJ');
  if (llvmReadobj) {
    const probe = run(llvmReadobj, ['--coff-debug-directory', path]);
    probes.push(probe);
    const text = probe.output ?? '';
    const pdbPath = text.match(/PDBFileName:\s*(.+)/i)?.[1]?.trim();
    const guid = text.match(/(?:PDB70Signature|Signature|Guid):\s*([0-9a-f{}-]{16,})/i)?.[1];
    const age = text.match(/Age:\s*(\d+)/i)?.[1];
    if (pdbPath || guid || age || /DebugDirectory/i.test(text)) {
      return {
        path,
        format: 'pe',
        pdb: {
          ...(pdbPath ? { path: pdbPath } : {}),
          ...(guid ? { guid: normalizedId(guid) } : {}),
          ...(age ? { age } : {}),
        },
        probes,
      };
    }
  }

  const dwarfdump = commandOnPath('dwarfdump');
  if (dwarfdump) {
    const probe = run(dwarfdump, ['--uuid', path]);
    probes.push(probe);
    const uuid = probe.output?.match(/UUID:\s*([0-9A-F-]+)/i)?.[1];
    if (uuid) return { path, format: 'macho', uuid: normalizedId(uuid), probes };
  }

  return { path, format: 'unknown', probes };
}

export function inspectPdbIdentity(input: string) {
  const path = resolveExistingFile(input, 'PDB file');
  const command = resolveSymbolInspectionTool('llvm-pdbutil', 'QWEN_DAP_MCP_LLVM_PDBUTIL');
  const probe = run(command, ['dump', '-summary', path]);
  const text = probe.output ?? '';
  const guid = text.match(/(?:Guid|GUID):\s*([0-9a-f{}-]{16,})/i)?.[1];
  const age = text.match(/Age:\s*(\d+)/i)?.[1];
  return {
    path,
    guid: normalizedId(guid),
    age,
    probe,
  };
}

function stem(name: string): string {
  const base = basename(name).toLowerCase();
  return base.replace(/\.(?:exe|dll|so(?:\.\d+)*|dylib|pdb|debug)$/i, '');
}

export function compareBinaryAndPdb(binary: BinaryIdentity, pdb: ReturnType<typeof inspectPdbIdentity>) {
  if (binary.format !== 'pe' || !binary.pdb) {
    return {
      comparable: false,
      match: undefined,
      reason: 'The binary did not expose PE CodeView/PDB identity through the available local inspection tools.',
    };
  }
  const binaryGuid = normalizedId(binary.pdb.guid);
  const pdbGuid = normalizedId(pdb.guid);
  if (!binaryGuid || !pdbGuid) {
    return {
      comparable: false,
      match: undefined,
      reason: 'Both PE and PDB GUIDs are required for a strong identity comparison.',
    };
  }
  const guidMatch = binaryGuid === pdbGuid;
  const ageMatch = !binary.pdb.age || !pdb.age || binary.pdb.age === pdb.age;
  return {
    comparable: true,
    match: guidMatch && ageMatch,
    guidMatch,
    ageMatch,
    binary: binary.pdb,
    pdb: { guid: pdb.guid, age: pdb.age },
    strength: binary.pdb.age && pdb.age ? 'strong-guid-age' : 'guid-only',
  };
}

export function findLocalSymbolCandidates(
  modules: readonly DebugProtocol.Module[],
  searchPaths: readonly string[],
  options: { maxEntries?: number; maxDepth?: number } = {},
) {
  const maxEntries = options.maxEntries ?? 2_000;
  const maxDepth = options.maxDepth ?? 4;
  const roots = searchPaths.map((path) => resolveExistingDirectory(path, 'Symbol search directory'));
  const targets = modules.map((module) => ({
    module: module.name,
    stem: stem(module.path ?? module.name),
    symbolStatus: module.symbolStatus,
    currentSymbolFilePath: module.symbolFilePath,
  }));
  const matches: Array<{ module: string; candidate: string; reason: string }> = [];
  let visited = 0;
  let truncated = false;

  const walk = (directory: string, depth: number) => {
    if (depth > maxDepth || truncated) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      visited += 1;
      if (visited > maxEntries) {
        truncated = true;
        return;
      }
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (/\.dsym$/i.test(entry.name)) {
          const target = targets.find((candidate) => stem(entry.name.replace(/\.dsym$/i, '')) === candidate.stem);
          if (target) matches.push({ module: target.module, candidate: path, reason: 'matching dSYM bundle name' });
        }
        walk(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (!['.pdb', '.debug', '.sym', '.dbg'].includes(ext)) continue;
      const candidateStem = stem(entry.name);
      for (const target of targets) {
        if (candidateStem === target.stem || candidateStem.startsWith(`${target.stem}.`)) {
          matches.push({ module: target.module, candidate: path, reason: `matching symbol artifact name for ${target.stem}` });
        }
      }
    }
  };

  for (const root of roots) walk(root, 0);

  return {
    searchPaths: roots,
    visitedEntries: visited,
    truncated,
    matches: matches.slice(0, 200),
    unresolvedModules: targets
      .filter((target) => !matches.some((match) => match.module === target.module))
      .slice(0, 200),
  };
}

export function configuredSymbolResolvers(
  identity: BinaryIdentity | undefined,
  value = process.env.QWEN_DAP_MCP_SYMBOL_SERVERS,
) {
  const servers = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 20);
  const candidates: Array<{ server: string; url?: string; kind: string }> = [];

  for (const server of servers) {
    if (identity?.format === 'elf' && identity.buildId && /^https?:\/\//i.test(server)) {
      candidates.push({
        server,
        kind: 'debuginfod-compatible-candidate',
        url: `${server.replace(/\/$/, '')}/buildid/${identity.buildId}/debuginfo`,
      });
    } else {
      candidates.push({
        server,
        kind: identity?.format === 'pe' ? 'pdb-symbol-server-root' : 'configured-symbol-server-root',
      });
    }
  }

  return {
    configured: servers.length > 0,
    servers,
    candidates,
    networkFetchPerformed: false,
    note: 'qwen-dap-mcp does not automatically download symbols. Resolver candidates are explicit so the host agent/user can review network destinations and cache policy first.',
  };
}

export function symbolMismatchSummary(options: {
  modules: readonly DebugProtocol.Module[];
  binaryIdentity?: BinaryIdentity;
  pdbIdentity?: ReturnType<typeof inspectPdbIdentity>;
  localSearch?: ReturnType<typeof findLocalSymbolCandidates>;
}) {
  const explicitMissing = options.modules.filter((module) => /missing|not\s+(?:loaded|found|available)|no\s+symbols?/i.test(module.symbolStatus ?? ''));
  const binaryPdbComparison = options.binaryIdentity && options.pdbIdentity
    ? compareBinaryAndPdb(options.binaryIdentity, options.pdbIdentity)
    : undefined;

  const issues: Array<Record<string, unknown>> = [];
  for (const module of explicitMissing.slice(0, 100)) {
    issues.push({
      kind: 'module-symbols-missing',
      module: module.name,
      path: module.path,
      symbolStatus: module.symbolStatus,
    });
  }
  if (binaryPdbComparison?.comparable && binaryPdbComparison.match === false) {
    issues.push({
      kind: 'binary-pdb-identity-mismatch',
      comparison: binaryPdbComparison,
      severity: 'high',
    });
  }

  return {
    status: issues.some((issue) => issue.kind === 'binary-pdb-identity-mismatch')
      ? 'mismatch'
      : explicitMissing.length
        ? 'missing-or-incomplete'
        : 'no-explicit-mismatch',
    issues,
    binaryPdbComparison,
    localCandidates: options.localSearch?.matches ?? [],
    limitations: [
      'Strong PE/PDB identity comparison requires llvm-readobj and llvm-pdbutil to be available locally.',
      'ELF Build-ID and Mach-O UUID extraction depends on local readelf/llvm-readelf or dwarfdump availability.',
      'A matching filename alone is only a candidate; do not treat it as a binary identity match.',
    ],
  };
}
