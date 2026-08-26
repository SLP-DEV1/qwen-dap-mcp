export function normalizeEnvironmentOverrides(
  overrides: Record<string, string> | undefined,
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  if (!overrides) return {};
  if (platform !== 'win32') return { ...overrides };

  const baseKeys = new Map<string, string>();
  for (const key of Object.keys(base)) {
    baseKeys.set(key.toUpperCase(), key);
  }

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(overrides)) {
    const folded = key.toUpperCase();
    const canonical = baseKeys.get(folded) ?? key;
    const duplicate = Object.keys(normalized).find((candidate) => candidate.toUpperCase() === folded);
    if (duplicate && duplicate !== canonical) delete normalized[duplicate];
    normalized[canonical] = value;
    baseKeys.set(folded, canonical);
  }
  return normalized;
}

export function mergeEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  overrides?: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return {
    ...base,
    ...normalizeEnvironmentOverrides(overrides, base, platform),
  };
}
