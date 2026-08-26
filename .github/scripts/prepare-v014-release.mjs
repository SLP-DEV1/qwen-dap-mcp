import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const VERSION = '0.14.0';

execFileSync('npm', ['version', VERSION, '--no-git-tag-version'], { stdio: 'inherit' });

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const extension = readJson('qwen-extension.json');
extension.version = VERSION;
writeJson('qwen-extension.json', extension);

const server = readJson('server.json');
server.version = VERSION;
for (const entry of server.packages ?? []) {
  if (entry.registryType === 'npm' && entry.identifier === '@slp-dev1/qwen-dap-mcp') {
    entry.version = VERSION;
  }
}
writeJson('server.json', server);

const changelogPath = 'CHANGELOG.md';
let changelog = readFileSync(changelogPath, 'utf8');
if (!changelog.includes(`## ${VERSION} - 2026-08-26`)) {
  const anchor = '## Unreleased\n';
  if (!changelog.includes(anchor)) throw new Error('CHANGELOG Unreleased anchor missing');
  const releaseNotes = `\n## ${VERSION} - 2026-08-26\n\n### Added\n\n- Added first-class GNU GDB 14+ DAP support through \`gdb --interpreter=dap\`, including discovery/version gating, native launch, authorized PID/remote attach, and frozen core-file inspection.\n- Added \`debug_find_writer\` to the compact default agent toolset for runtime write provenance via native DAP data breakpoints or a bounded GDB \`watch\`/\`rwatch\`/\`awatch\` fallback.\n- Added MCP v2 \`outputSchema\` contracts and validated \`structuredContent\` for all ten default agent tools while preserving the existing JSON text content for older clients.\n- Added deterministic runtime \`symbolHealth\` reporting with \`good | partial | poor | unknown\` states derived from stack names, source/line mappings, and explicit module symbol evidence without inventing a numeric score.\n\n### Fixed / hardened\n\n- Fixed Issue #44 lifecycle and validation findings: explicit session shutdown now wakes event waiters, malformed DAP framing/JSON fails closed, filtered agent tools return stable no-op handles, raw memory/disassembly inputs are bounded, and invalid \`QWEN_DAP_MCP_TOOLSET\` values warn and fall back to the safe \`agent\` surface.\n- Preserved configured data breakpoints around temporary writer tracing and clean up only the temporary watch created by \`debug_find_writer\`.\n- Hardened GDB watch-expression handling by bounding expression length and rejecting control characters, conditional fallback watches, and unsafe cleanup ambiguity.\n\n### Verified\n\n- \`npm run check\` passes with 130/130 tests, TypeScript build, and self-contained Qwen extension packaging.\n- Real Ubuntu GNU GDB 15.1 DAP smoke passes, including a real watchpoint stop through the high-level writer-tracing path.\n- Real upstream \`lldb-dap\` Linux smoke and the standard CI matrix pass on the final v0.14 feature head.\n- Regression coverage verifies every default agent tool declares an MCP v2 output schema and exercises all four \`symbolHealth\` states.\n`;
  changelog = changelog.replace(anchor, `${anchor}${releaseNotes}`);
  writeFileSync(changelogPath, changelog, 'utf8');
}

console.log(`Prepared qwen-dap-mcp ${VERSION}`);
