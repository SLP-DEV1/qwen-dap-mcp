import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { DapConnection } from '../src/dap/connection.js';
import { resolveExistingDirectory, resolveExistingFile } from '../src/local-path.js';
import { createLogger } from '../src/logger.js';

test('local path validation normalizes parent segments instead of rejecting them', () => {
  const root = mkdtempSync(join(tmpdir(), 'qwen-dap-paths-'));
  try {
    const nested = join(root, 'nested');
    const program = join(root, 'app.bin');
    mkdirSync(nested);
    writeFileSync(program, 'fixture');

    const withParentSegment = join(nested, '..', 'app.bin');
    assert.equal(resolveExistingFile(withParentSegment, 'Program executable'), resolve(program));
    assert.equal(resolveExistingDirectory(nested, 'Working directory'), resolve(nested));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local path validation reports missing files and wrong path kinds clearly', () => {
  const root = mkdtempSync(join(tmpdir(), 'qwen-dap-path-errors-'));
  try {
    const file = join(root, 'file.bin');
    writeFileSync(file, 'fixture');

    assert.throws(
      () => resolveExistingFile(join(root, 'missing.bin'), 'Program executable'),
      /Program executable does not exist/,
    );
    assert.throws(
      () => resolveExistingDirectory(file, 'Working directory'),
      /Working directory is not a directory/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DAP adapter start validates its local cwd before spawning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qwen-dap-cwd-'));
  try {
    const connection = new DapConnection();
    await assert.rejects(
      connection.start({ command: process.execPath, cwd: join(root, 'missing-directory') }),
      /DAP adapter working directory does not exist/,
    );
    assert.equal(connection.isRunning, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('structured logger filters by level and emits parseable records', () => {
  const lines: string[] = [];
  const log = createLogger({ level: 'warn', sink: (line) => lines.push(line) });

  log.debug('hidden debug');
  log.info('hidden info');
  log.warn('visible warning', { operation: 'validation' });
  log.error('visible error', { error: new Error('boom') });

  assert.equal(lines.length, 2);
  const warning = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
  const error = JSON.parse(lines[1] ?? '{}') as Record<string, unknown>;

  assert.equal(warning.level, 'warn');
  assert.equal(warning.component, 'qwen-dap-mcp');
  assert.equal(warning.message, 'visible warning');
  assert.deepEqual(warning.fields, { operation: 'validation' });
  assert.equal(error.level, 'error');
  assert.equal(error.message, 'visible error');
});

test('structured logger preserves shared non-circular object references', () => {
  const lines: string[] = [];
  const log = createLogger({ level: 'info', sink: (line) => lines.push(line) });
  const shared = { userId: 123, path: '/tmp/x' };

  log.info('diamond reference', { a: shared, b: shared });

  const record = JSON.parse(lines[0] ?? '{}') as {
    fields?: { a?: unknown; b?: unknown };
  };
  assert.deepEqual(record.fields?.a, shared);
  assert.deepEqual(record.fields?.b, shared);
});

test('structured logger marks only true ancestor cycles as circular', () => {
  const lines: string[] = [];
  const log = createLogger({ level: 'info', sink: (line) => lines.push(line) });
  const cyclic: { name: string; self?: unknown } = { name: 'root' };
  cyclic.self = cyclic;
  const error = new Error('boom') as Error & { cause?: unknown };
  error.cause = error;

  log.info('real cycles', { cyclic, error });

  const record = JSON.parse(lines[0] ?? '{}') as {
    fields?: {
      cyclic?: { self?: unknown };
      error?: { cause?: unknown };
    };
  };
  assert.equal(record.fields?.cyclic?.self, '[Circular]');
  assert.equal(record.fields?.error?.cause, '[Circular]');
});

test('structured logger supports silent mode', () => {
  const lines: string[] = [];
  const log = createLogger({ level: 'silent', sink: (line) => lines.push(line) });
  log.error('hidden');
  assert.deepEqual(lines, []);
});
