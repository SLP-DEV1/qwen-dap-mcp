import type { RuntimeSnapshot } from './session.js';

type CrashHint = {
  pattern: RegExp;
  label: string;
};

const WINDOWS_POSTMORTEM_HINTS: readonly CrashHint[] = [
  { pattern: /\b(?:0x)?c0000005\b/i, label: 'access violation' },
  { pattern: /\b(?:0x)?c00000fd\b/i, label: 'stack overflow' },
  { pattern: /\b(?:0x)?c0000094\b/i, label: 'integer divide by zero' },
  { pattern: /\b(?:0x)?c000008e\b/i, label: 'floating point division by zero' },
  { pattern: /\b(?:0x)?c000001d\b/i, label: 'illegal instruction' },
  { pattern: /\b(?:0x)?c0000374\b/i, label: 'heap corruption' },
];

function evidenceText(snapshot: RuntimeSnapshot): string {
  try {
    return JSON.stringify({ stopped: snapshot.stopped, exception: snapshot.exception }).toLowerCase();
  } catch {
    return '';
  }
}

function appendHint(description: unknown, hint: string): string {
  const existing = typeof description === 'string' ? description.trim() : '';
  if (!existing) return hint;
  if (existing.toLowerCase().includes(hint.toLowerCase())) return existing;
  return `${existing} (${hint})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Add stable crash-family wording to frozen Windows dump evidence when the
 * adapter exposes only a raw SEH status code. The original DAP fields are kept
 * intact; the canonical wording merely lets debugger-agnostic diagnosis logic
 * classify the same failure consistently across adapters and versions.
 */
export function normalizePostmortemSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  const text = evidenceText(snapshot);
  const hint = WINDOWS_POSTMORTEM_HINTS.find((candidate) => candidate.pattern.test(text))?.label;
  if (!hint) return { ...snapshot, postmortem: true };

  const stopped = isRecord(snapshot.stopped)
    ? { ...snapshot.stopped, description: appendHint(snapshot.stopped.description, hint) }
    : snapshot.stopped;
  const exception = snapshot.exception
    ? { ...snapshot.exception, description: appendHint(snapshot.exception.description, hint) }
    : snapshot.exception;

  return {
    ...snapshot,
    postmortem: true,
    ...(stopped === undefined ? {} : { stopped }),
    ...(exception === undefined ? {} : { exception }),
  };
}
