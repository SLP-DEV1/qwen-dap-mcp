import { readFile } from 'node:fs/promises';
import path from 'node:path';

const input = process.argv[2];
if (!input) {
  throw new Error('Usage: npm run benchmark:report -- <results.json>');
}

const document = JSON.parse(await readFile(path.resolve(input), 'utf8'));
if (document?.schemaVersion !== 1 || !Array.isArray(document.runs)) {
  throw new Error('Benchmark results must contain schemaVersion=1 and a runs array');
}

const groups = new Map();
for (const [index, run] of document.runs.entries()) {
  if (!run || typeof run !== 'object') throw new Error(`runs[${index}] must be an object`);
  if (typeof run.case !== 'string' || run.case.length === 0) throw new Error(`runs[${index}].case must be a string`);
  if (typeof run.mode !== 'string' || run.mode.length === 0) throw new Error(`runs[${index}].mode must be a string`);
  if (typeof run.solved !== 'boolean') throw new Error(`runs[${index}].solved must be boolean`);
  if (typeof run.verified !== 'boolean') throw new Error(`runs[${index}].verified must be boolean`);
  if (run.verified && !run.solved) {
    throw new Error(`runs[${index}] cannot be verified=true while solved=false`);
  }

  const group = groups.get(run.mode) ?? { mode: run.mode, total: 0, solved: 0, verified: 0 };
  group.total += 1;
  if (run.solved) group.solved += 1;
  if (run.verified) group.verified += 1;
  groups.set(run.mode, group);
}

function rate(value, total) {
  return total === 0 ? '0.0%' : `${((value / total) * 100).toFixed(1)}%`;
}

const rows = [...groups.values()].sort((a, b) => a.mode.localeCompare(b.mode));
if (rows.length === 0) {
  console.log('No benchmark runs recorded.');
  process.exit(0);
}

console.log('| mode | runs | solved | verified | solve rate | verification rate |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
for (const row of rows) {
  console.log(
    `| ${row.mode} | ${row.total} | ${row.solved} | ${row.verified} | ${rate(row.solved, row.total)} | ${rate(row.verified, row.total)} |`,
  );
}
