import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import path from 'node:path';

import { packageVersion } from '../src/version.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

async function readJson(relativePath: string): Promise<any> {
  return JSON.parse(await readFile(path.join(projectRoot, relativePath), 'utf8'));
}

test('package, lockfile, Qwen extension, MCP Registry and runtime versions stay aligned', async () => {
  const packageJson = await readJson('package.json');
  const packageLock = await readJson('package-lock.json');
  const extensionManifest = await readJson('qwen-extension.json');
  const registryManifest = await readJson('server.json');
  const registryPackage = registryManifest.packages.find(
    (entry: any) => entry.registryType === 'npm' && entry.identifier === packageJson.name,
  );

  assert.equal(packageVersion, packageJson.version);
  assert.equal(packageLock.name, packageJson.name);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages?.['']?.name, packageJson.name);
  assert.equal(packageLock.packages?.['']?.version, packageJson.version);
  assert.equal(extensionManifest.version, packageJson.version);
  assert.equal(registryManifest.version, packageJson.version);
  assert.equal(registryManifest.name, packageJson.mcpName);
  assert.ok(registryPackage, `server.json must contain npm package ${packageJson.name}`);
  assert.equal(registryPackage.version, packageJson.version);
});
