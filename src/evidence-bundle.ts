import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { DapError } from './dap/errors.js';
import { resolveExistingDirectory, resolveExistingFile } from './local-path.js';

const MAX_EVIDENCE_FILE_BYTES = 8 * 1024 * 1024;

function jsonSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function assertBounded(value: unknown): void {
  const size = jsonSize(value);
  if (size > MAX_EVIDENCE_FILE_BYTES) {
    throw new DapError('Evidence bundle is ' + size + ' bytes; maximum is ' + MAX_EVIDENCE_FILE_BYTES + ' bytes.');
  }
}

function writableTarget(input: string, overwrite: boolean): string {
  if (!input.trim()) throw new DapError('Evidence output path must not be empty.');
  const target = resolve(input);
  resolveExistingDirectory(dirname(target), 'Evidence output directory');
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw new DapError('Evidence output path must not be a symbolic link.');
    if (!stat.isFile()) throw new DapError('Evidence output path exists and is not a regular file.');
    if (!overwrite) throw new DapError("Evidence output already exists at '" + target + "'. Set overwrite=true only when replacement is intentional.");
  }
  return target;
}

export function buildSarif(evidence: any) {
  const hypotheses = Array.isArray(evidence?.hypotheses) ? evidence.hypotheses : [];
  const frame = evidence?.snapshot?.frame ?? evidence?.report?.snapshot?.frame;
  const results = hypotheses.slice(0, 20).map((hypothesis: any) => ({
    ruleId: String(hypothesis.id ?? 'native-runtime-failure'),
    level: Number(hypothesis.evidenceScore ?? 0) >= 70 ? 'error'
      : Number(hypothesis.evidenceScore ?? 0) >= 40 ? 'warning'
        : 'note',
    message: {
      text: String(hypothesis.title ?? hypothesis.id ?? 'Native runtime hypothesis') + ' (evidence score ' + String(hypothesis.evidenceScore ?? 'n/a') + '/100)',
    },
    ...(frame?.source?.path
      ? {
          locations: [{
            physicalLocation: {
              artifactLocation: { uri: frame.source.path },
              region: { startLine: Math.max(1, Number(frame.line ?? 1)) },
            },
          }],
        }
      : {}),
    properties: {
      supporting: hypothesis.supporting ?? [],
      contradicting: hypothesis.contradicting ?? [],
      nextEvidence: hypothesis.nextEvidence ?? [],
    },
  }));
  return {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [{
      tool: {
        driver: {
          name: 'qwen-dap-mcp',
          informationUri: 'https://github.com/SLP-DEV1/qwen-dap-mcp',
          rules: [...new Set(results.map((result: any) => result.ruleId))].map((id) => ({
            id,
            shortDescription: { text: id },
          })),
        },
      },
      results,
    }],
  };
}

export function renderEvidenceMarkdown(evidence: any): string {
  const fingerprint = evidence?.fingerprintsV2?.semantic ?? evidence?.fingerprint ?? evidence?.report?.fingerprint;
  const hypotheses = Array.isArray(evidence?.hypotheses) ? evidence.hypotheses : [];
  const lines = [
    '# Native runtime evidence',
    '',
    fingerprint ? 'Fingerprint: `' + fingerprint + '`' : 'Fingerprint: unavailable',
    '',
    '## Hypotheses',
    '',
  ];
  if (!hypotheses.length) lines.push('No structured hypotheses were included in this bundle.');
  for (const hypothesis of hypotheses.slice(0, 20)) {
    lines.push(
      '### ' + String(hypothesis.title ?? hypothesis.id ?? 'Hypothesis'),
      '',
      'Evidence score: **' + String(hypothesis.evidenceScore ?? 'n/a') + '/100**',
      '',
    );
    const supporting = Array.isArray(hypothesis.supporting) ? hypothesis.supporting : [];
    for (const item of supporting.slice(0, 12)) {
      lines.push('- ' + String(item.summary ?? item.kind ?? item));
    }
    lines.push('');
  }
  lines.push('## Structured evidence', '', '```json', JSON.stringify(evidence, null, 2), '```', '');
  return lines.join('\n');
}

export function exportEvidenceBundle(options: {
  path: string;
  evidence: unknown;
  format?: 'json' | 'markdown' | 'sarif';
  overwrite?: boolean;
}) {
  assertBounded(options.evidence);
  const format = options.format ?? 'json';
  const target = writableTarget(options.path, options.overwrite ?? false);
  const content = format === 'markdown'
    ? renderEvidenceMarkdown(options.evidence)
    : JSON.stringify(format === 'sarif' ? buildSarif(options.evidence) : options.evidence, null, 2);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_EVIDENCE_FILE_BYTES) {
    throw new DapError('Rendered evidence output is ' + bytes + ' bytes; maximum is ' + MAX_EVIDENCE_FILE_BYTES + ' bytes.');
  }
  writeFileSync(target, content, { encoding: 'utf8', flag: options.overwrite ? 'w' : 'wx' });
  return {
    action: 'export',
    path: target,
    format,
    bytes,
    overwritten: Boolean(options.overwrite),
  };
}

export function importEvidenceBundle(pathInput: string) {
  const path = resolveExistingFile(pathInput, 'Evidence bundle');
  const stat = lstatSync(path);
  if (stat.size > MAX_EVIDENCE_FILE_BYTES) {
    throw new DapError('Evidence bundle is ' + stat.size + ' bytes; maximum is ' + MAX_EVIDENCE_FILE_BYTES + ' bytes.');
  }
  const content = readFileSync(path, 'utf8');
  let evidence: unknown;
  try {
    evidence = JSON.parse(content);
  } catch (cause) {
    throw new DapError('Evidence import accepts structured JSON/SARIF files only. Markdown exports are presentation artifacts, not replay inputs.', {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
  return {
    action: 'import',
    path,
    bytes: stat.size,
    evidence,
    offline: true,
    note: 'Imported evidence is read-only offline context; it cannot resume or mutate the original debug target.',
  };
}