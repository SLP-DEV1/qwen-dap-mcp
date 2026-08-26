import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);
const bridge = path.join(projectRoot, 'scripts', 'hol-guard-dap-policy.py');
const python = process.env.QWEN_DAP_MCP_HOL_GUARD_PYTHON
  || process.env.PYTHON
  || (process.platform === 'win32' ? 'python' : 'python3');

function runBridge(payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [bridge], {
      cwd: projectRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`HOL Guard smoke timed out. stdout=${stdout}\nstderr=${stderr}`));
    }, 30_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`HOL Guard bridge exited ${code}. stdout=${stdout}\nstderr=${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`HOL Guard bridge returned invalid JSON: ${stdout}`, { cause: error }));
      }
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

const root = await mkdtemp(path.join(tmpdir(), 'qwen-dap-hol-guard-'));
try {
  const guardHome = path.join(root, 'guard-home');
  const workspace = path.join(root, 'workspace');
  await Promise.all([mkdir(guardHome), mkdir(workspace)]);
  const env = {
    ...process.env,
    HOL_GUARD_HOME: guardHome,
    // Keep the smoke hermetic: the local approval center is enough and no
    // cloud sync is required for this compatibility contract.
    HOL_GUARD_HOOK_FAST_PATH: '0',
  };
  const payload = {
    kind: 'adapter-start',
    command: 'fixture-debug-adapter',
    args: ['--stdio'],
    cwd: workspace,
    adapterCommand: 'fixture-debug-adapter',
    adapterArgs: ['--stdio'],
    envKeys: ['PATH'],
    envHash: `sha256:${'0'.repeat(64)}`,
  };

  const decision = await runBridge(payload, env);
  assert.equal(typeof decision.guardVersion, 'string');
  assert.match(decision.guardVersion, /^\d+\.\d+/);
  assert.equal(typeof decision.action, 'string');
  assert.equal(typeof decision.reason, 'string');
  assert.equal(typeof decision.allow, 'boolean');

  // A pristine HOL Guard install defaults to balanced/prompt. The synthetic
  // execute_dap_adapter_start tool is intentionally classified as command
  // execution, so this exercises the real approval queue rather than a fake
  // evaluator. If HOL Guard's safe default changes in a future release, an
  // allow/warn remains valid but must still have traversed the real bridge.
  if (['review', 'require-reapproval'].includes(decision.action)) {
    assert.equal(decision.allow, false);
    assert.equal(typeof decision.approvalRequestId, 'string');
    assert.ok(decision.approvalRequestId.length > 8);
    assert.equal(typeof decision.reviewCommand, 'string');
    assert.match(decision.reviewCommand, /hol-guard approvals approve/);
    assert.equal(typeof decision.approvalCenterUrl, 'string');
    assert.match(decision.approvalCenterUrl, /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/);
  } else {
    assert.ok(['allow', 'warn', 'block', 'sandbox-required'].includes(decision.action));
    assert.equal(decision.allow, ['allow', 'warn'].includes(decision.action));
  }

  console.log(`HOL Guard ${decision.guardVersion} compatibility smoke passed (${decision.action}).`);
} finally {
  await rm(root, { recursive: true, force: true });
}
