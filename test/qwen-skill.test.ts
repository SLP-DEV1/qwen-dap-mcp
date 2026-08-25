import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const skillPath = fileURLToPath(
  new URL('../.qwen/skills/native-runtime-debug/SKILL.md', import.meta.url),
);

test('native-runtime-debug skill has valid frontmatter and core workflow references', async () => {
  const content = await readFile(skillPath, 'utf8');

  assert.match(content, /^---\r?\nname: native-runtime-debug\r?\n/m);
  assert.match(content, /description:\s*Diagnose native C\/C\+\+ runtime bugs/);
  assert.match(content, /\r?\n---\r?\n/);

  const requiredTools = [
    'debug_start_codelldb',
    'debug_launch_codelldb',
    'debug_snapshot',
    'debug_data_breakpoint_info',
    'debug_set_data_breakpoints',
    'debug_pause',
    'debug_disconnect',
  ];

  for (const tool of requiredTools) {
    assert.ok(content.includes(`\`${tool}\``), `Skill must reference ${tool}`);
  }

  assert.match(content, /authorized local targets/i);
  assert.match(content, /rebuild/i);
  assert.match(content, /verify/i);
});
