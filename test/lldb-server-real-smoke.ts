import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';

import {
  buildLldbDapRemoteAttachConfiguration,
  discoverLldbDap,
} from '../src/adapters/lldb-dap.js';
import { DapSession } from '../src/dap/session.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readPort(child: ChildProcess, timeoutMs = 15_000): Promise<number> {
  const portPipe = child.stdio[3] as Readable | null;
  if (!portPipe) throw new Error('lldb-server smoke did not expose fd 3 for --pipe.');

  return new Promise((resolvePort, reject) => {
    let output = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for lldb-server selected port. Output='${output}'`)), timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      portPipe.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const finish = (error?: Error, port?: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolvePort(port!);
    };
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      const match = output.match(/\b(\d{1,5})\b/);
      if (!match) return;
      const port = Number(match[1]);
      if (port >= 1 && port <= 65535) finish(undefined, port);
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(new Error(`lldb-server exited before reporting a port (code=${String(code)}, signal=${String(signal)}).`));

    portPipe.on('data', onData);
    child.on('error', onError);
    child.on('exit', onExit);
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

const adapterPath = arg('--adapter');
const serverPath = arg('--server') ?? 'lldb-server';
const programArg = arg('--program');
const sourceArg = arg('--source');
if (!programArg || !sourceArg) {
  throw new Error('Usage: tsx test/lldb-server-real-smoke.ts --program <exe> --source <cpp> [--adapter <lldb-dap>] [--server <lldb-server>]');
}

const program = resolve(programArg);
const source = resolve(sourceArg);
const remote = spawn(serverPath, ['gdbserver', '--pipe', '3', '127.0.0.1:0', '--', program], {
  stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
let remoteOutput = '';
(remote.stdout as Readable | null)?.on('data', (chunk) => { remoteOutput += chunk.toString(); });
(remote.stderr as Readable | null)?.on('data', (chunk) => { remoteOutput += chunk.toString(); });

const adapter = discoverLldbDap({ ...(adapterPath ? { explicitPath: adapterPath } : {}) });
const session = new DapSession();

try {
  const port = await readPort(remote);
  const capabilities = await session.start({
    command: adapter.command,
    adapterId: 'lldb-dap',
    requestTimeoutMs: 30_000,
  });

  const attachResult = await session.attach(
    buildLldbDapRemoteAttachConfiguration({ host: '127.0.0.1', port, program }),
    [{ source, lines: [8] }],
  );

  const threads = await session.threads();
  const threadId = threads[0]?.id;
  assert.ok(threadId, 'lldb-dap remote attach exposed no thread.');

  const stoppedAtBreakpoint = await session.continueExecution(threadId, true, 30_000) as {
    stopped?: { threadId?: number; reason?: string };
  };
  const stoppedThreadId = stoppedAtBreakpoint.stopped?.threadId ?? threadId;
  const snapshot = await session.runtimeSnapshot({
    threadId: stoppedThreadId,
    stackLevels: 20,
    maxVariablesPerScope: 100,
    includeDisassembly: capabilities.supportsDisassembleRequest === true,
    includeModules: capabilities.supportsModulesRequest === true,
    includeExceptionInfo: false,
  });

  assert.match(snapshot.frame.name, /main/i, `Expected remote breakpoint in main, got '${snapshot.frame.name}'.`);
  const counter = await session.evaluate('counter', snapshot.frame.id, 'watch');
  assert.match(counter.result, /35/, `Expected counter=35 at remote breakpoint, got '${counter.result}'.`);

  console.log(JSON.stringify({
    ok: true,
    adapter,
    endpoint: { host: '127.0.0.1', port },
    attachResult,
    stop: stoppedAtBreakpoint.stopped,
    frame: snapshot.frame,
    counter: counter.result,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    diagnostic: 'lldb-server-remote-smoke-failure',
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    remoteOutput,
    state: session.snapshot(),
  }, null, 2));
  throw error;
} finally {
  await session.disconnect(true).catch(() => undefined);
  await stopChild(remote);
}
