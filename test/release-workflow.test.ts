import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const extensionSmokeUrl = new URL('../.github/workflows/extension-package-smoke.yml', import.meta.url);
const releaseWorkflowUrl = new URL('../.github/workflows/release-extension.yml', import.meta.url);
const registryWorkflowUrl = new URL('../.github/workflows/publish-registries.yml', import.meta.url);

test('published release verification is serialized inside the release workflow', async () => {
  const [extensionSmoke, releaseWorkflow] = await Promise.all([
    readFile(extensionSmokeUrl, 'utf8'),
    readFile(releaseWorkflowUrl, 'utf8'),
  ]);

  assert.doesNotMatch(extensionSmoke, /^\s{2}published-release-install:/m);
  assert.match(releaseWorkflow, /- '\.github\/workflows\/release-extension\.yml'/);
  assert.match(releaseWorkflow, /- 'test\/release-workflow\.test\.ts'/);
  assert.match(releaseWorkflow, /^\s{2}actions: write\s*$/m);
  assert.match(releaseWorkflow, /- name: Publish GitHub release/);
  assert.match(releaseWorkflow, /- name: Verify published release metadata/);
  assert.match(releaseWorkflow, /- name: Verify published GitHub release installs exact version/);
  assert.match(releaseWorkflow, /- name: Trigger npm and MCP Registry publication/);
  assert.match(releaseWorkflow, /gh workflow run publish-registries\.yml/);
  assert.match(releaseWorkflow, /--field publish_npm=true/);
  assert.match(releaseWorkflow, /--field publish_mcp=true/);

  const publishIndex = releaseWorkflow.indexOf('- name: Publish GitHub release');
  const metadataIndex = releaseWorkflow.indexOf('- name: Verify published release metadata');
  const installIndex = releaseWorkflow.indexOf('- name: Verify published GitHub release installs exact version');
  const registryIndex = releaseWorkflow.indexOf('- name: Trigger npm and MCP Registry publication');

  assert.ok(publishIndex >= 0);
  assert.ok(metadataIndex > publishIndex, 'release metadata must be checked only after publish');
  assert.ok(installIndex > metadataIndex, 'published release install must happen after metadata validation');
  assert.ok(registryIndex > installIndex, 'registry publication must be triggered only after release install verification');

  assert.match(releaseWorkflow, /if \[ "\$\{\{ steps\.version\.outputs\.exists \}\}" = 'false' \]; then/);
  assert.match(releaseWorkflow, /test "\$TARGET_COMMIT" = "\$GITHUB_SHA"/);
  assert.match(releaseWorkflow, /preserving historical release target/);
  assert.match(releaseWorkflow, /grep -F "Qwen DAP MCP \(\$\{VERSION\}\)"/);
  assert.match(releaseWorkflow, /grep -F "Release tag: \$\{TAG\}"/);
  assert.match(releaseWorkflow, /manifest\.version !== expected/);
});

test('registry publication is release-bound, idempotent, and verifies npm before MCP', async () => {
  const workflow = await readFile(registryWorkflowUrl, 'utf8');

  assert.match(workflow, /^\s{2}workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s{2}(push|release):/m);
  assert.match(workflow, /^\s{2}id-token: write\s*$/m);
  assert.match(workflow, /Registry publication must be dispatched from the main branch/);
  assert.match(workflow, /git checkout --detach "refs\/tags\/\$\{tag\}"/);
  assert.match(workflow, /git merge-base --is-ancestor "refs\/tags\/\$\{tag\}" origin\/main/);

  assert.match(workflow, /const expectedPackage = '@slp-dev1\/qwen-dap-mcp'/);
  assert.match(workflow, /const expectedName = 'io\.github\.SLP-DEV1\/qwen-dap-mcp'/);
  assert.match(workflow, /pkg\.mcpName !== expectedName/);
  assert.match(workflow, /server\.packages\?\.\[0\]\?\.identifier !== expectedPackage/);
  assert.match(workflow, /npm pack --dry-run --json/);
  assert.match(workflow, /'NOTICE'/);
  assert.match(workflow, /MCP_PUBLISHER_VERSION: '1\.8\.1'/);
  assert.match(workflow, /a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc/);
  assert.match(workflow, /sha256sum --check/);
  assert.match(workflow, /secrets\.NPM_TOKEN/);

  assert.match(workflow, /- name: Check whether MCP Registry version already exists/);
  assert.match(workflow, /registry\.modelcontextprotocol\.io\/v0\.1\/servers/);
  assert.match(workflow, /if \[ "\$status" = '200' \]; then/);
  assert.match(workflow, /elif \[ "\$status" = '404' \]; then/);
  assert.match(workflow, /steps\.mcp_version\.outputs\.exists != 'true'/);

  const npmVisibilityIndex = workflow.indexOf('- name: Verify package is visible on npm');
  const mcpExistsIndex = workflow.indexOf('- name: Check whether MCP Registry version already exists');
  const mcpLoginIndex = workflow.indexOf('- name: Authenticate to MCP Registry with GitHub OIDC');
  const mcpPublishIndex = workflow.indexOf('- name: Publish to MCP Registry');

  assert.ok(npmVisibilityIndex >= 0);
  assert.ok(mcpExistsIndex > npmVisibilityIndex, 'MCP existence check must happen only after npm ownership metadata is visible');
  assert.ok(mcpLoginIndex > mcpExistsIndex, 'MCP auth must happen only when the exact version is absent');
  assert.ok(mcpPublishIndex > mcpLoginIndex, 'MCP publish must happen only after OIDC authentication');
  assert.match(workflow, /\.\/mcp-publisher login github-oidc/);
  assert.match(workflow, /\.\/mcp-publisher publish server\.json/);
});
