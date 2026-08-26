function isWindowsStylePath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value)
    || /^\\\\/.test(value)
    || (!value.startsWith('/') && value.includes('\\'));
}

/**
 * Normalize debugger/source paths without erasing POSIX case semantics.
 *
 * Windows drive/UNC/backslash paths are separator- and case-insensitive for
 * comparison. POSIX paths preserve case because `/Project/a.cpp` and
 * `/project/a.cpp` can be different files on the same machine.
 */
export function normalizeDiagnosticPath(value: string | undefined): string | undefined {
  if (!value) return undefined;

  if (isWindowsStylePath(value)) {
    let normalized = value.replace(/\\/g, '/');
    if (!/^[a-z]:\/+$/i.test(normalized)) {
      normalized = normalized.replace(/\/+$/, '');
    } else {
      normalized = `${normalized.slice(0, 2)}/`;
    }
    return normalized.toLowerCase();
  }

  if (value === '/') return '/';
  return value.replace(/\/+$/, '');
}

export function diagnosticPathWithinRoot(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return candidate.startsWith(prefix);
}
