import { builtinModules } from 'node:module';
import { chmod, cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const outputRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(projectRoot, 'release', 'extension');

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(candidate, parent) {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function assertSafeOutputRoot(candidate) {
  const resolved = path.resolve(candidate);
  const filesystemRoot = comparablePath(path.parse(resolved).root);
  const comparableOutput = comparablePath(resolved);
  const comparableProject = comparablePath(projectRoot);
  const comparableRelease = comparablePath(path.join(projectRoot, 'release'));

  if (comparableOutput === filesystemRoot) {
    throw new Error(`Refusing to use filesystem root as extension output: ${resolved}`);
  }
  if (comparableOutput === comparableProject || comparableProject.startsWith(`${comparableOutput}${path.sep}`)) {
    throw new Error(`Refusing to use the project root or one of its ancestors as extension output: ${resolved}`);
  }

  // The script recursively deletes outputRoot before rebuilding it. If a
  // caller chooses a directory inside the repository, only the dedicated
  // generated release subtree is safe to remove. This prevents accidental
  // invocations such as `... build-extension-package.mjs src` from deleting
  // source, tests, .git metadata, skills, or other checked-in content.
  if (isPathInside(comparableOutput, comparableProject) && !isPathInside(comparableOutput, comparableRelease)) {
    throw new Error(
      `Refusing to use a project directory outside the generated release subtree as extension output: ${resolved}`,
    );
  }
}

assertSafeOutputRoot(outputRoot);

const packageJson = JSON.parse(
  await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
);
const extensionManifest = JSON.parse(
  await readFile(path.join(projectRoot, 'qwen-extension.json'), 'utf8'),
);
const registryManifest = JSON.parse(
  await readFile(path.join(projectRoot, 'server.json'), 'utf8'),
);

const registryPackage = registryManifest.packages?.find(
  (entry) => entry?.registryType === 'npm' && entry?.identifier === packageJson.name,
);
const alignedVersions = [
  ['package.json', packageJson.version],
  ['qwen-extension.json', extensionManifest.version],
  ['server.json', registryManifest.version],
  ['server.json npm package', registryPackage?.version],
];
const mismatchedVersions = alignedVersions.filter(([, version]) => version !== packageJson.version);
if (mismatchedVersions.length > 0) {
  throw new Error(
    `Version mismatch: ${alignedVersions.map(([name, version]) => `${name}=${String(version)}`).join(', ')}`,
  );
}
if (registryManifest.name !== packageJson.mcpName) {
  throw new Error(
    `MCP name mismatch: package.json mcpName=${String(packageJson.mcpName)}, server.json name=${String(registryManifest.name)}`,
  );
}
if (!registryPackage) {
  throw new Error(`server.json must publish npm package ${packageJson.name}`);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.join(outputRoot, 'dist'), { recursive: true });

const result = await build({
  entryPoints: [path.join(projectRoot, 'dist', 'index.js')],
  outfile: path.join(outputRoot, 'dist', 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  metafile: true,
});

const builtinNames = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/, '')]),
);
for (const output of Object.values(result.metafile.outputs)) {
  for (const item of output.imports) {
    if (!item.external) continue;
    const importName = item.path.replace(/^node:/, '');
    if (!builtinNames.has(importName)) {
      throw new Error(`Bundled extension still depends on external package: ${item.path}`);
    }
  }
}

await Promise.all([
  cp(path.join(projectRoot, 'skills'), path.join(outputRoot, 'skills'), {
    recursive: true,
  }),
  cp(
    path.join(projectRoot, 'qwen-extension.json'),
    path.join(outputRoot, 'qwen-extension.json'),
  ),
  cp(path.join(projectRoot, 'README.md'), path.join(outputRoot, 'README.md')),
  cp(path.join(projectRoot, 'CHANGELOG.md'), path.join(outputRoot, 'CHANGELOG.md')),
  cp(path.join(projectRoot, 'LICENSE'), path.join(outputRoot, 'LICENSE')),
  cp(path.join(projectRoot, 'NOTICE'), path.join(outputRoot, 'NOTICE')),
]);

const releasePackageJson = {
  name: packageJson.name,
  version: packageJson.version,
  description: packageJson.description,
  type: 'module',
  private: true,
  engines: packageJson.engines,
  license: packageJson.license,
};
await writeFile(
  path.join(outputRoot, 'package.json'),
  `${JSON.stringify(releasePackageJson, null, 2)}\n`,
  'utf8',
);
await chmod(path.join(outputRoot, 'dist', 'index.js'), 0o755);

async function assertNoLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const stats = await lstat(entryPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Extension package must not contain symlinks: ${entryPath}`);
    }
    if (stats.isDirectory()) {
      await assertNoLinks(entryPath);
    }
  }
}

await assertNoLinks(outputRoot);

const syntaxCheck = spawnSync(
  process.execPath,
  ['--check', path.join(outputRoot, 'dist', 'index.js')],
  { encoding: 'utf8' },
);
if (syntaxCheck.status !== 0) {
  throw new Error(
    `Bundled server failed node --check:\n${syntaxCheck.stdout}\n${syntaxCheck.stderr}`,
  );
}

console.log(
  `Prepared self-contained Qwen extension ${packageJson.name}@${packageJson.version} at ${outputRoot}`,
);
