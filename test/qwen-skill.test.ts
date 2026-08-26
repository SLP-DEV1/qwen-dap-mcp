import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectSkillPath = fileURLToPath(
  new URL('../.qwen/skills/native-runtime-debug/SKILL.md', import.meta.url),
);
const extensionSkillPath = fileURLToPath(
  new URL('../skills/native-runtime-debug/SKILL.md', import.meta.url),
);
const extensionManifestPath = fileURLToPath(
  new URL('../qwen-extension.json', import.meta.url),
);
const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const builtServerPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));

function validateSkill(content: string): void {
  assert.match(content, /^---\r?\nname: native-runtime-debug\r?\n/m);
  assert.match(content, /description:\s*Diagnose native C\/C\+\+ runtime bugs/);
  assert.match(content, /\r?\n---\r?\n/);

  const requiredTools = [
    'debug_this_crash',
    'debug_diagnose_stop',
    'debug_source_disassembly',
    'debug_run_to_stop',
    'debug_start_codelldb',
    'debug_launch_codelldb',
    'debug_snapshot',
    'debug_data_breakpoint_info',
    'debug_set_data_breakpoints',
    'debug_pause',
    'debug_disconnect',
  ];

  for (const tool of requiredTools) {
    assert.ok(content.includes(tool), `Skill must reference ${tool}`);
  }

  const requiredDiagnosisConcepts = [
    'projectFrame',
    'frameSelection',
    'operandAnalysis',
    'callChain',
    'rootCauseBacktrack',
    'fixWorkflow',
    'verificationBaseline',
    'verificationQuality',
    'faultCorrelation',
    'changed-failure',
    'inconclusive',
  ];

  for (const concept of requiredDiagnosisConcepts) {
    assert.ok(content.includes(concept), `Skill must explain ${concept}`);
  }

  const requiredAutonomousConcepts = [
    'protocolVersion',
    'workflow.autonomousAgent',
    'rootFingerprint',
    'activeFingerprint',
    'nextActions',
    'requires',
    'propose-fix',
    'agentState',
    'needs-reproduction',
    'budget-exhausted',
    'broaden-diagnosis',
  ];

  for (const concept of requiredAutonomousConcepts) {
    assert.ok(content.includes(concept), `Skill must explain autonomous concept ${concept}`);
  }

  assert.match(content, /workflow\s*=\s*\{[\s\S]*?stage\s*:\s*["']autonomous["']/i);
  assert.match(content, /workflow\s*=\s*\{[\s\S]*?stage\s*:\s*["']autonomous["'][\s\S]*?agentState\s*:/i);
  assert.match(content, /workflow\s*=\s*\{[\s\S]*?stage\s*:\s*["']verify["'][\s\S]*?baseline\s*:/i);
  assert.match(content, /authorized local targets/i);
  assert.match(content, /confidence/i);
  assert.match(content, /rebuild/i);
  assert.match(content, /reproduce/i);
  assert.match(content, /clean successful terminal outcome/i);
  assert.match(content, /do \*\*not\*\* automatically revert/i);
  assert.match(content, /external-unverified/i);
}

test('project and extension native-runtime-debug skills stay identical and valid', async () => {
  const [projectSkill, extensionSkill] = await Promise.all([
    readFile(projectSkillPath, 'utf8'),
    readFile(extensionSkillPath, 'utf8'),
  ]);

  validateSkill(projectSkill);
  validateSkill(extensionSkill);
  assert.equal(extensionSkill, projectSkill, 'Bundled extension Skill must match the project Skill');
});

test('Qwen extension manifest starts the built local MCP server and matches package version', async () => {
  const [manifestText, packageText] = await Promise.all([
    readFile(extensionManifestPath, 'utf8'),
    readFile(packagePath, 'utf8'),
  ]);

  const manifest = JSON.parse(manifestText) as {
    name?: string;
    version?: string;
    mcpServers?: Record<string, { command?: string; args?: string[]; cwd?: string; trust?: unknown }>;
  };
  const pkg = JSON.parse(packageText) as { version?: string; files?: string[] };

  assert.equal(manifest.name, 'qwen-dap-mcp');
  assert.equal(manifest.version, pkg.version);

  const server = manifest.mcpServers?.['qwen-dap-mcp'];
  assert.ok(server, 'Extension must expose the qwen-dap-mcp MCP server');
  assert.equal(server.command, 'node');
  assert.deepEqual(server.args, ['${extensionPath}${/}dist${/}index.js']);
  assert.equal(server.cwd, '${extensionPath}');
  assert.equal(server.trust, undefined, 'Extension must not bypass Qwen MCP trust review');

  await access(builtServerPath, constants.R_OK);

  assert.ok(pkg.files?.includes('dist'), 'npm package must include built runtime files');
  assert.ok(pkg.files?.includes('qwen-extension.json'), 'npm package must include the Qwen extension manifest');
  assert.ok(pkg.files?.includes('skills'), 'npm package must include bundled Qwen Skills');
});
