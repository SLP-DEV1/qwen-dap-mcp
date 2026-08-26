import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const buildRoot = path.join(projectRoot, 'examples', 'hang-lab', 'build');
const cases = ['deadlock'];
const name = process.argv[2] ?? 'deadlock';

if (!cases.includes(name)) {
  throw new Error(`Unknown hang-lab case '${name}'. Available: ${cases.join(', ')}`);
}

const executable = path.join(buildRoot, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
if (!existsSync(executable)) {
  throw new Error(`Missing ${executable}. Build it first with: npm run demo:hang:build -- ${name}`);
}

console.log(`Reproducing expected hang: ${name}`);
const result = spawnSync(executable, [], {
  cwd: projectRoot,
  stdio: 'inherit',
  windowsHide: true,
  timeout: 2_000,
});

if (result.error?.code === 'ETIMEDOUT') {
  console.log('Hang reproduced as expected: process remained blocked until the bounded timeout.');
  process.exit(0);
}
if (result.error) throw result.error;
if (result.status === 0 && result.signal === null) {
  throw new Error(`${name} exited cleanly; the expected hang did not reproduce`);
}
throw new Error(
  `${name} terminated unexpectedly instead of remaining hung (${result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`})`,
);
