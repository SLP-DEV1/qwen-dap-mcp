import { statSync } from 'node:fs';
import { resolve } from 'node:path';

import { DapError } from './dap/errors.js';
import { logger } from './logger.js';

function resolveInputPath(input: string, label: string): string {
  if (!input.trim()) {
    throw new DapError(`${label} must not be empty`);
  }
  return resolve(input);
}

function readStat(path: string, label: string) {
  try {
    return statSync(path);
  } catch (cause) {
    logger.warn('Local path validation failed', { label, path, reason: 'missing-or-inaccessible' });
    throw new DapError(`${label} does not exist or cannot be accessed at '${path}'`, {
      cause: cause instanceof Error ? cause : undefined,
    });
  }
}

export function resolveExistingFile(input: string, label: string): string {
  const resolved = resolveInputPath(input, label);
  const stat = readStat(resolved, label);
  if (!stat.isFile()) {
    logger.warn('Local path validation failed', { label, path: resolved, reason: 'not-a-file' });
    throw new DapError(`${label} is not a file at '${resolved}'`);
  }
  logger.debug('Validated local file path', { label, path: resolved });
  return resolved;
}

export function resolveExistingDirectory(input: string, label: string): string {
  const resolved = resolveInputPath(input, label);
  const stat = readStat(resolved, label);
  if (!stat.isDirectory()) {
    logger.warn('Local path validation failed', { label, path: resolved, reason: 'not-a-directory' });
    throw new DapError(`${label} is not a directory at '${resolved}'`);
  }
  logger.debug('Validated local directory path', { label, path: resolved });
  return resolved;
}
