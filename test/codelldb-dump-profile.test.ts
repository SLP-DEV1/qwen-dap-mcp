import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import type { DebugProtocol } from '@vscode/debugprotocol';

import { buildCodeLldbDumpConfiguration } from '../src/adapters/codelldb-dump.js';
import { GuardedDapSession } from '../src/dap/guarded-session.js';
import type { SourceBreakpointGroup, StartSessionOptions } from '../src/dap/session.js';
import { openDump } from '../src/tools/register-dump-tools.js';

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

test('rejects LLDB command control characters before filesystem access', () => {
  assert.throws(
    () => buildCodeLldbDumpConfiguration({ dumpPath: `fake\nsettings set target.run-args injected.dmp` }),
    /must not contain NUL, carriage-return, or newline/i,
  );
  assert.throws(
    () => buildCodeLldbDumpConfiguration({ dumpPath: 'fake.dmp', program: `app\rquit.exe` }),
    /must not contain NUL, carriage-return, or newline/i,
  );
});

test('openDump validates the dump before adapter discovery or startup', async () => {
  const session = new GuardedDapSession();
  const missing = resolve('definitely-missing-preflight-crash.dmp');

  await assert.rejects(
    openDump(session, { dumpPath: missing }),
    /Crash dump does not exist/,
  );

  assert.equal(session.snapshot().adapterRunning, false);
  assert.equal(session.snapshot().initialized, false);
});

test('openDump resets an adapter it owns when attach fails after startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qwen-dap-dump-cleanup-'));
  const dumpPath = join(root, 'crash.dmp');
  await writeFile(dumpPath, 'fake-dump');

  class FailingAttachSession extends GuardedDapSession {
    resetCalls = 0;

    override async start(_options: StartSessionOptions): Promise<DebugProtocol.Capabilities> {
      return {};
    }

    override async attach(
      _configuration: Record<string, unknown>,
      _breakpoints: SourceBreakpointGroup[] = [],
    ): Promise<unknown> {
      throw new Error('synthetic attach failure');
    }

    override async reset(): Promise<void> {
      this.resetCalls += 1;
    }
  }

  const session = new FailingAttachSession();
  await assert.rejects(
    openDump(session, { dumpPath, adapterPath: process.execPath }),
    /synthetic attach failure/,
  );
  assert.equal(session.resetCalls, 1);
});
