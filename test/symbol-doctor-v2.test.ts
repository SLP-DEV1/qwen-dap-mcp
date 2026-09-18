import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  compareBinaryAndPdb,
  configuredSymbolResolvers,
  findLocalSymbolCandidates,
  resolveSymbolInspectionTool,
  symbolMismatchSummary,
} from '../src/diagnostics/symbol-doctor.js';

test('local symbol search finds bounded filename candidates without claiming identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qwen-symbols-'));
  const nested = join(dir, 'cache');
  mkdirSync(nested);
  writeFileSync(join(nested, 'app.pdb'), 'fake');

  const result = findLocalSymbolCandidates(
    [{ id: 'app', name: 'app.exe', path: '/build/app.exe', symbolStatus: 'Symbols not loaded' }],
    [dir],
  );
  assert.equal(result.matches.length, 1);
  assert.match(result.matches[0]?.reason ?? '', /candidate|matching/i);
});

test('PE/PDB GUID mismatch is reported as strong mismatch evidence', () => {
  const comparison = compareBinaryAndPdb(
    {
      path: '/app.exe',
      format: 'pe',
      pdb: { guid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', age: '1' },
      probes: [],
    },
    {
      path: '/app.pdb',
      guid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      age: '1',
      probe: {},
    },
  );
  assert.equal(comparison.comparable, true);
  assert.equal(comparison.match, false);

  const summary = symbolMismatchSummary({
    modules: [{ id: 'app', name: 'app.exe', symbolStatus: 'Symbols not loaded' }],
    binaryIdentity: {
      path: '/app.exe',
      format: 'pe',
      pdb: { guid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', age: '1' },
      probes: [],
    },
    pdbIdentity: {
      path: '/app.pdb',
      guid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      age: '1',
      probe: {},
    },
  });
  assert.equal(summary.status, 'mismatch');
});

test('configured ELF resolver produces explicit debuginfod candidate without fetching', () => {
  const resolver = configuredSymbolResolvers(
    { path: '/app', format: 'elf', buildId: 'abcdef', probes: [] },
    'https://debuginfod.example',
  );
  assert.equal(resolver.networkFetchPerformed, false);
  assert.equal(resolver.candidates[0]?.url, 'https://debuginfod.example/buildid/abcdef/debuginfo');
});


test('explicit symbol inspection tool path overrides PATH discovery deterministically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qwen-symbol-tool-'));
  const tool = join(dir, process.platform === 'win32' ? 'llvm-readobj.exe' : 'llvm-readobj');
  writeFileSync(tool, 'stub');

  const key = 'QWEN_DAP_MCP_TEST_LLVM_TOOL';
  const previous = process.env[key];
  process.env[key] = tool;
  try {
    assert.equal(resolveSymbolInspectionTool('llvm-readobj', key), tool);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});
