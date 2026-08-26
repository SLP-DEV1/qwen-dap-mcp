import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

import {
  buildGdbDapRemoteAttachConfiguration,
  discoverGdbDap,
} from '../src/adapters/gdb-dap.js';
import { GuardedDapSession } from '../src/dap/guarded-session.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveReady);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to allocate a loopback TCP port for gdbserver smoke.');
  }
  const port = address.port;
  await new Promise<void>((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed()));
  return port;
}

function waitForGdbserverReady(child: ChildProcessWithoutNullStreams, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolveReady, reject) => {
    let output = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for gdbserver. Output:\n${output}`)), timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolveReady(output);
    };
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (/Listening on port\s+\d+/i.test(output)) finish();
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(new Error(`gdbserver exited before accepting GDB (code=${String(code)}, signal=${String(signal)}). Output:\n${output}`));

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', onError);
    child.on('exit', onExit);
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

const adapterPath = arg('--adapter');
const gdbserverPath = arg('--gdbserver') ?? 'gdbserver';
const programArg = arg('--program');
const sourceArg = arg('--source');
if (!programArg || !sourceArg) {
  throw new Error('Usage: tsx test/gdbserver-real-smoke.ts --program <exe> --source <cpp> [--adapter <gdb>] [--gdbserver <gdbserver>]');
}

const program = resolve(programArg);
const source = resolve(sourceArg);
const port = await reserveLoopbackPort();
const remote = spawn(gdbserverPath, ['--once', `127.0.0.1:${port}`, program], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let remoteOutput = '';
remote.stdout.on('data', (chunk) => { remoteOutput += chunk.toString(); });
remote.stderr.on('data', (chunk) => { remoteOutput += chunk.toString(); });

const adapter = discoverGdbDap({ ...(adapterPath ? { explicitPath: adapterPath } : {}) });
const session = new GuardedDapSession();

try {
  await waitForGdbserverReady(remote);
  const capabilities = await session.start({
    command: adapter.command,
    args: adapter.args,
    adapterId: 'gdb',
    requestTimeoutMs: 30_000,
  });

  const attachResult = await session.attach(
    buildGdbDapRemoteAttachConfiguration({ host: '127.0.0.1', port, program }),
    [{ source, lines: [11] }],
  );

  const threads = await session.threads();
  const threadId = threads[0]?.id;
  assert.ok(threadId, 'GDB DAP remote attach exposed no thread.');

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
  const watched = await session.evaluate('watched_value', snapshot.frame.id, 'watch');
  assert.match(watched.result, /7/, `Expected watched_value=7 at remote breakpoint, got '${watched.result}'.`);

  console.log(JSON.stringify({
    ok: true,
    adapter,
    endpoint: { host: '127.0.0.1', port },
    attachResult,
    stop: stoppedAtBreakpoint.stopped,
    frame: snapshot.frame,
    watchedValue: watched.result,
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    diagnostic: 'gdbserver-remote-smoke-failure',
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    remoteOutput,
    state: session.snapshot(),
  }, null, 2));
  throw error;
} finally {
  await session.disconnect(true).catch(() => undefined);
  await stopChild(remote);
}
