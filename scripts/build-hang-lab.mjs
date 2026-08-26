import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const labRoot = path.join(projectRoot, 'examples', 'hang-lab');
const buildRoot = path.join(labRoot, 'build');
const cases = ['deadlock'];

function commandExists(command) {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locator, [command], {
    stdio: 'ignore',
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

function selectCompiler() {
  const candidates = process.platform === 'win32'
    ? ['cl', 'clang++', 'g++']
    : ['clang++', 'g++'];
  const command = candidates.find(commandExists);
  if (!command) {
    throw new Error(
      `No supported C++ compiler found. Tried: ${candidates.join(', ')}. `
      + 'On Windows run this from a Visual Studio Developer PowerShell or install clang/g++.',
    );
  }
  return command;
}

function selectedCases() {
  const requested = process.argv.slice(2);
  if (requested.length === 0 || requested.includes('all')) return cases;
  for (const name of requested) {
    if (!cases.includes(name)) {
      throw new Error(`Unknown hang-lab case '${name}'. Available: ${cases.join(', ')}`);
    }
  }
  return requested;
}

function compileCase(compiler, name) {
  const source = path.join(labRoot, name, 'main.cpp');
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const output = path.join(buildRoot, `${name}${suffix}`);
  let args;

  if (compiler === 'cl') {
    const pdb = path.join(buildRoot, `${name}.pdb`);
    args = [
      '/nologo',
      '/std:c++17',
      '/Zi',
      '/Od',
      '/EHsc',
      `/Fe:${output}`,
      source,
      '/link',
      '/DEBUG',
      `/PDB:${pdb}`,
    ];
  } else {
    args = [
      '-std=c++17',
      '-g3',
      '-O0',
      '-fno-omit-frame-pointer',
      '-fno-optimize-sibling-calls',
      '-pthread',
      '-o',
      output,
      source,
    ];
  }

  const result = spawnSync(compiler, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Failed to compile ${name} with ${compiler}.\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      { cause: result.error },
    );
  }
  console.log(`Built hang case ${name}: ${output}`);
}

await mkdir(buildRoot, { recursive: true });
const compiler = selectCompiler();
console.log(`Hang Lab compiler: ${compiler}`);
for (const name of selectedCases()) compileCase(compiler, name);
