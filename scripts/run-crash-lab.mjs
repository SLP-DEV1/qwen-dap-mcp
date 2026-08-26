import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const buildRoot = path.join(projectRoot, 'examples', 'crash-lab', 'build');
const cases = ['null-pointer', 'divide-by-zero', 'bad-call-target'];
const name = process.argv[2] ?? 'null-pointer';

if (!cases.includes(name)) {
  throw new Error(`Unknown crash-lab case '${name}'. Available: ${cases.join(', ')}`);
}

const executable = path.join(buildRoot, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
if (!existsSync(executable)) {
  throw new Error(`Missing ${executable}. Build it first with: npm run demo:build -- ${name}`);
}

console.log(`Reproducing expected crash: ${name}`);
const result = spawnSync(executable, [], {
  cwd: projectRoot,
  stdio: 'inherit',
  windowsHide: true,
  timeout: 15_000,
});

if (result.error) {
  if (result.error.code === 'ETIMEDOUT') {
    throw new Error(`${name} timed out instead of crashing`, { cause: result.error });
  }
  throw result.error;
}

if (result.status === 0 && result.signal === null) {
  throw new Error(`${name} exited cleanly; the expected crash did not reproduce`);
}

console.log(
  `Crash reproduced as expected (${result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`}).`,
);
