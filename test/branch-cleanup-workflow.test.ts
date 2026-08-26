import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../.github/workflows/cleanup-merged-branches.yml', import.meta.url);

test('merged-branch cleanup is bounded to safe same-repo stale heads', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /^\s{2}push:/m);
  assert.match(workflow, /^\s{6}- main$/m);
  assert.match(workflow, /^\s{2}workflow_dispatch:/m);
  assert.match(workflow, /^\s{2}contents: write$/m);
  assert.match(workflow, /^\s{2}pull-requests: read$/m);
  assert.match(workflow, /uses: actions\/github-script@v9/);

  assert.match(workflow, /if \(!pr\.merged_at\) continue;/);
  assert.match(workflow, /pr\.head\.repo\?\.full_name !== `\$\{owner\}\/\$\{repo\}`/);
  assert.match(workflow, /openHeads\.has\(branch\)/);
  assert.match(workflow, /current\.protected/);
  assert.match(workflow, /current\.sha !== expectedSha/);
  assert.match(workflow, /github\.rest\.git\.deleteRef/);

  const shaGuard = workflow.indexOf('current.sha !== expectedSha');
  const deleteCall = workflow.indexOf('github.rest.git.deleteRef');
  assert.ok(shaGuard >= 0 && deleteCall > shaGuard, 'exact-head verification must precede deletion');

  for (const legacy of ['noop-check', 'noop-temp', 'tmp-do-not-use', 'v0.6-release', 'v0.7-dump']) {
    assert.match(workflow, new RegExp(`'${legacy.replaceAll('.', '\\.')}'`));
  }
  assert.match(workflow, /basehead: `\$\{branch\}\.\.\.\$\{defaultBranch\}`/);
  assert.match(workflow, /comparison\.data\.status !== 'ahead' \|\| comparison\.data\.behind_by !== 0/);
});
