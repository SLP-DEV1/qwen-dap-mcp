import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scriptPath = fileURLToPath(new URL('../scripts/build-extension-package.mjs', import.meta.url));
const sourcePath = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const sourceDirectory = fileURLToPath(new URL('../src', import.meta.url));

test('extension packaging refuses destructive output directories inside the project', async () => {
  const before = await readFile(sourcePath, 'utf8');
  const result = spawnSync(process.execPath, [scriptPath, sourceDirectory], {
    encoding: 'utf8',
    windowsHide: true,
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /outside the generated release subtree/i);
  await access(sourcePath, constants.R_OK);
  assert.equal(await readFile(sourcePath, 'utf8'), before, 'source file must remain untouched');
});
