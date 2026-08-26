import assert from 'node:assert/strict';
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';

import {
  buildGdbDapRemoteAttachConfiguration,
  discoverGdbDap,
} from '../src/adapters/gdb-dap.js';
import {
  buildLldbDapRemoteAttachConfiguration,
  discoverLldbDap,
} from '../src/adapters/lldb-dap.js';
import { DapSessionRegistry } from '../src/dap/session-registry.js';

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
    throw new Error('Unable to allocate a loopback TCP port for multi-session smoke.');
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

function readLldbServerPort(child: ChildProcess, timeoutMs = 15_000): Promise<number> {
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

const gdbPath = arg('--gdb');
const lldbDapPath = arg('--lldb-dap');
const gdbserverPath = arg('--gdbserver') ?? 'gdbserver';
const lldbServerPath = arg('--lldb-server') ?? 'lldb-server';
const gdbProgramArg = arg('--gdb-program');
const gdbSourceArg = arg('--gdb-source');
const lldbProgramArg = arg('--lldb-program');
const lldbSourceArg = arg('--lldb-source');

if (!gdbProgramArg || !gdbSourceArg || !lldbProgramArg || !lldbSourceArg) {
  throw new Error(
    'Usage: tsx test/multi-session-remote-real-smoke.ts '
      + '--gdb-program <exe> --gdb-source <cpp> --lldb-program <exe> --lldb-source <cpp> '
      + '[--gdb <gdb>] [--lldb-dap <lldb-dap>] [--gdbserver <gdbserver>] [--lldb-server <lldb-server>]',
  );
}

const gdbProgram = resolve(gdbProgramArg);
const gdbSource = resolve(gdbSourceArg);
const lldbProgram = resolve(lldbProgramArg);
const lldbSource = resolve(lldbSourceArg);
const gdbAdapter = discoverGdbDap({ ...(gdbPath ? { explicitPath: gdbPath } : {}) });
const lldbAdapter = discoverLldbDap({ ...(lldbDapPath ? { explicitPath: lldbDapPath } : {}) });

const gdbPort = await reserveLoopbackPort();
const gdbRemote = spawn(gdbserverPath, ['--once', `127.0.0.1:${gdbPort}`, gdbProgram], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let gdbRemoteOutput = '';
gdbRemote.stdout.on('data', (chunk) => { gdbRemoteOutput += chunk.toString(); });
gdbRemote.stderr.on('data', (chunk) => { gdbRemoteOutput += chunk.toString(); });

const lldbRemote = spawn(lldbServerPath, ['gdbserver', '--pipe', '3', '127.0.0.1:0', '--', lldbProgram], {
  stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
let lldbRemoteOutput = '';
(lldbRemote.stdout as Readable | null)?.on('data', (chunk) => { lldbRemoteOutput += chunk.toString(); });
(lldbRemote.stderr as Readable | null)?.on('data', (chunk) => { lldbRemoteOutput += chunk.toString(); });

const registry = new DapSessionRegistry({ maxSessions: 4 });
registry.create('gdb-remote');
registry.create('lldb-remote');
const routed = registry.createRoutedSession();

try {
  const [, lldbPort] = await Promise.all([
    waitForGdbserverReady(gdbRemote),
    readLldbServerPort(lldbRemote),
  ]);

  const gdbTask = registry.runWithSession('gdb-remote', async () => {
    assert.equal(registry.currentSessionId(), 'gdb-remote');
    const capabilities = await routed.start({
      command: gdbAdapter.command,
      args: gdbAdapter.args,
      adapterId: 'gdb',
      requestTimeoutMs: 30_000,
    });
    assert.equal(registry.currentSessionId(), 'gdb-remote');

    const attach = await routed.attach(
      buildGdbDapRemoteAttachConfiguration({ host: '127.0.0.1', port: gdbPort, program: gdbProgram }),
      [{ source: gdbSource, lines: [11] }],
    );
    const threads = await routed.threads();
    const threadId = threads[0]?.id;
    assert.ok(threadId, 'GDB multi-session target exposed no thread.');

    const stopped = await routed.continueExecution(threadId, true, 30_000) as {
      stopped?: { threadId?: number; reason?: string };
    };
    const stoppedThreadId = stopped.stopped?.threadId ?? threadId;
    const snapshot = await routed.runtimeSnapshot({
      threadId: stoppedThreadId,
      stackLevels: 20,
      maxVariablesPerScope: 100,
      includeDisassembly: capabilities.supportsDisassembleRequest === true,
      includeModules: capabilities.supportsModulesRequest === true,
      includeExceptionInfo: false,
    });
    const watched = await routed.evaluate('watched_value', snapshot.frame.id, 'watch');

    assert.equal(registry.currentSessionId(), 'gdb-remote');
    assert.match(snapshot.frame.name, /main/i, `Expected GDB remote breakpoint in main, got '${snapshot.frame.name}'.`);
    assert.match(watched.result, /7/, `Expected watched_value=7 in GDB session, got '${watched.result}'.`);
    assert.equal(registry.get('gdb-remote').snapshot().adapterId, 'gdb');
    assert.notEqual(registry.get('gdb-remote'), registry.get('lldb-remote'));

    return { attach, stop: stopped.stopped, frame: snapshot.frame, watchedValue: watched.result };
  });

  const lldbTask = registry.runWithSession('lldb-remote', async () => {
    assert.equal(registry.currentSessionId(), 'lldb-remote');
    const capabilities = await routed.start({
      command: lldbAdapter.command,
      adapterId: 'lldb-dap',
      requestTimeoutMs: 30_000,
    });
    assert.equal(registry.currentSessionId(), 'lldb-remote');

    const attach = await routed.attach(
      buildLldbDapRemoteAttachConfiguration({ host: '127.0.0.1', port: lldbPort, program: lldbProgram }),
      [{ source: lldbSource, lines: [8] }],
    );
    const threads = await routed.threads();
    const threadId = threads[0]?.id;
    assert.ok(threadId, 'LLDB multi-session target exposed no thread.');

    const stopped = await routed.continueExecution(threadId, true, 30_000) as {
      stopped?: { threadId?: number; reason?: string };
    };
    const stoppedThreadId = stopped.stopped?.threadId ?? threadId;
    const snapshot = await routed.runtimeSnapshot({
      threadId: stoppedThreadId,
      stackLevels: 20,
      maxVariablesPerScope: 100,
      includeDisassembly: capabilities.supportsDisassembleRequest === true,
      includeModules: capabilities.supportsModulesRequest === true,
      includeExceptionInfo: false,
    });
    const counter = await routed.evaluate('counter', snapshot.frame.id, 'watch');

    assert.equal(registry.currentSessionId(), 'lldb-remote');
    assert.match(snapshot.frame.name, /main/i, `Expected LLDB remote breakpoint in main, got '${snapshot.frame.name}'.`);
    assert.match(counter.result, /35/, `Expected counter=35 in LLDB session, got '${counter.result}'.`);
    assert.equal(registry.get('lldb-remote').snapshot().adapterId, 'lldb-dap');

    return { attach, stop: stopped.stopped, frame: snapshot.frame, counter: counter.result };
  });

  const [gdbResult, lldbResult] = await Promise.all([gdbTask, lldbTask]);

  assert.equal(registry.currentSessionId(), 'default');
  assert.equal(registry.activeRequests('gdb-remote'), 0);
  assert.equal(registry.activeRequests('lldb-remote'), 0);
  assert.equal(registry.get('default').snapshot().adapterRunning, false);

  console.log(JSON.stringify({
    ok: true,
    sessions: registry.list().map(({ sessionId, activeRequests, snapshot }) => ({
      sessionId,
      activeRequests,
      adapterId: snapshot.adapterId,
      configured: snapshot.configured,
    })),
    gdb: { endpoint: { host: '127.0.0.1', port: gdbPort }, ...gdbResult },
    lldb: { endpoint: { host: '127.0.0.1', port: lldbPort }, ...lldbResult },
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    diagnostic: 'multi-session-remote-smoke-failure',
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    sessions: registry.list(),
    gdbRemoteOutput,
    lldbRemoteOutput,
  }, null, 2));
  throw error;
} finally {
  await registry.closeAll(true);
  await Promise.all([stopChild(gdbRemote), stopChild(lldbRemote)]);
}
