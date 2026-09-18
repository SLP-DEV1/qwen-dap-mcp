import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildSarif, exportEvidenceBundle, importEvidenceBundle } from '../src/evidence-bundle.js';

test('evidence bundle exports and imports bounded JSON without accidental overwrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qwen-dap-evidence-'));
  const path = join(dir, 'evidence.json');
  const evidence = {
    fingerprint: 'abc',
    hypotheses: [{ id: 'uaf', title: 'Use after free', evidenceScore: 80, supporting: [] }],
    snapshot: { frame: { line: 7, source: { path: '/src/main.cpp' } } },
  };

  const exported = exportEvidenceBundle({ path, evidence });
  assert.equal(exported.format, 'json');
  const imported = importEvidenceBundle(path);
  assert.deepEqual(imported.evidence, evidence);
  assert.throws(() => exportEvidenceBundle({ path, evidence }), /already exists/i);
});

test('SARIF export produces native-runtime results with source location', () => {
  const sarif = buildSarif({
    hypotheses: [{ id: 'null-dereference', title: 'Null dereference', evidenceScore: 72, supporting: [] }],
    snapshot: { frame: { line: 42, source: { path: '/src/main.cpp' } } },
  });
  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs[0]?.results[0]?.ruleId, 'null-dereference');
  assert.equal(sarif.runs[0]?.results[0]?.level, 'error');
});

test('evidence import rejects non-JSON presentation artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qwen-dap-evidence-'));
  const path = join(dir, 'report.md');
  writeFileSync(path, '# report', 'utf8');
  assert.throws(() => importEvidenceBundle(path), /JSON\/SARIF/i);
});
