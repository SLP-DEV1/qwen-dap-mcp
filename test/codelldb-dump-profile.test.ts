import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { buildCodeLldbDumpConfiguration } from '../src/adapters/codelldb-dump.js';

test('builds a CodeLLDB postmortem attach configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qwen-dap-dump-'));
  const dumpPath = join(root, 'crash.dmp');
  const program = join(root, 'app.exe');
  await writeFile(dumpPath, 'fake-dump');
  await writeFile(program, 'fake-program');

  const config = buildCodeLldbDumpConfiguration({
    dumpPath,
    program,
    sourceMap: { 'C:/build/src': 'D:/work/src' },
  });

  assert.equal(config.type, 'lldb');
  assert.equal(config.request, 'attach');
  assert.deepEqual(config.processCreateCommands, []);
  assert.deepEqual(config.sourceMap, { 'C:/build/src': 'D:/work/src' });

  const commands = config.targetCreateCommands as string[];
  assert.equal(commands.length, 1);
  assert.match(commands[0] ?? '', /^target create -c /);
  assert.match(commands[0] ?? '', /crash\.dmp/);
  assert.match(commands[0] ?? '', /app\.exe/);
});

test('rejects a missing crash dump before starting CodeLLDB', () => {
  assert.throws(
    () => buildCodeLldbDumpConfiguration({ dumpPath: resolve('definitely-missing-crash.dmp') }),
    /Crash dump does not exist/,
  );
});
