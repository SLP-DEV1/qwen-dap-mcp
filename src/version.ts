import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version?: unknown };

if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
  throw new Error('package.json must contain a non-empty string version');
}

export const packageVersion = packageJson.version;
