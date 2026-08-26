import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import { AGENT_TOOL_NAMES } from '../src/toolset.js';
import { packageVersion } from '../src/version.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

async function text(relativePath: string): Promise<string> {
  return readFile(path.join(projectRoot, relativePath), 'utf8');
}

test('public tool docs track the compact agent surface', async () => {
  const [readme, toolsets] = await Promise.all([
    text('README.md'),
    text('docs/toolsets.md'),
  ]);

  assert.equal(AGENT_TOOL_NAMES.size, 14);
  for (const toolName of AGENT_TOOL_NAMES) {
    assert.match(readme, new RegExp(`\\b${toolName}\\b`), `README.md is missing ${toolName}`);
    assert.match(toolsets, new RegExp(`\\b${toolName}\\b`), `docs/toolsets.md is missing ${toolName}`);
  }

  assert.match(toolsets, /baselineSessionId/);
  assert.match(toolsets, /candidateSessionId/);
});

test('changelog contains the currently published package version', async () => {
  const changelog = await text('CHANGELOG.md');
  assert.match(changelog, new RegExp(`^## ${packageVersion.replace(/\\./g, '\\.')} - \\d{4}-\\d{2}-\\d{2}$`, 'm'));
});

test('llms.txt documentation references resolve to repository files', async () => {
  const llms = await text('llms.txt');
  const references = [...llms.matchAll(/^- (docs\/[A-Za-z0-9._/-]+\.md):/gm)].map((match) => match[1]);

  assert.ok(references.length > 0, 'llms.txt should list maintained docs/*.md references');
  for (const relativePath of references) {
    await assert.doesNotReject(
      access(path.join(projectRoot, relativePath)),
      `llms.txt references missing file ${relativePath}`,
    );
  }
});
