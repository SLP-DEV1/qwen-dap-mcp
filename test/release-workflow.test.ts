import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const extensionSmokeUrl = new URL('../.github/workflows/extension-package-smoke.yml', import.meta.url);
const releaseWorkflowUrl = new URL('../.github/workflows/release-extension.yml', import.meta.url);

test('published release verification is serialized inside the release workflow', async () => {
  const [extensionSmoke, releaseWorkflow] = await Promise.all([
    readFile(extensionSmokeUrl, 'utf8'),
    readFile(releaseWorkflowUrl, 'utf8'),
  ]);

  assert.doesNotMatch(extensionSmoke, /^\s{2}published-release-install:/m);
  assert.match(releaseWorkflow, /- '\.github\/workflows\/release-extension\.yml'/);
  assert.match(releaseWorkflow, /- 'test\/release-workflow\.test\.ts'/);
  assert.match(releaseWorkflow, /- name: Publish GitHub release/);
  assert.match(releaseWorkflow, /- name: Verify published release metadata/);
  assert.match(releaseWorkflow, /- name: Verify published GitHub release installs exact version/);

  const publishIndex = releaseWorkflow.indexOf('- name: Publish GitHub release');
  const metadataIndex = releaseWorkflow.indexOf('- name: Verify published release metadata');
  const installIndex = releaseWorkflow.indexOf('- name: Verify published GitHub release installs exact version');

  assert.ok(publishIndex >= 0);
  assert.ok(metadataIndex > publishIndex, 'release metadata must be checked only after publish');
  assert.ok(installIndex > metadataIndex, 'published release install must happen after metadata validation');

  assert.match(releaseWorkflow, /if \[ "\$\{\{ steps\.version\.outputs\.exists \}\}" = 'false' \]; then/);
  assert.match(releaseWorkflow, /test "\$TARGET_COMMIT" = "\$GITHUB_SHA"/);
  assert.match(releaseWorkflow, /preserving historical release target/);
  assert.match(releaseWorkflow, /grep -F "Qwen DAP MCP \(\$\{VERSION\}\)"/);
  assert.match(releaseWorkflow, /grep -F "Release tag: \$\{TAG\}"/);
  assert.match(releaseWorkflow, /manifest\.version !== expected/);
});
