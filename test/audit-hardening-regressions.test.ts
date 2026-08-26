import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { DebugProtocol } from '@vscode/debugprotocol';

import { discoverCodeLldb } from '../src/adapters/codelldb.js';
import { DapTimeoutError } from '../src/dap/errors.js';
import { buildHolGuardBridgeEnvironment } from '../src/dap/hol-guard-policy.js';
import { createDapRequestPolicy } from '../src/dap/request-policy.js';
import { DapSession } from '../src/dap/session.js';
import { analyzeRuntimeSnapshot } from '../src/diagnostics/analyze-snapshot.js';
import { findWriter } from '../src/tools/find-writer.js';
import { registerDebugTools } from '../src/tools/register-debug-tools.js';
import { annotateToolRegistrar } from '../src/toolset.js';

const fixture = fileURLToPath(new URL('./fixtures/mock-dap-adapter.mjs', import.meta.url));

function mockStartOptions() {
  return {
    command: process.execPath,
    args: [fixture],
    adapterId: 'mock',
    requestTimeoutMs: 2_000,
  };
}

function symbolHealth() {
  return {
    status: 'good' as const,
    summary: 'fixture',
    stack: {
      totalFrames: 1,
      namedFrames: 1,
      sourceMappedFrames: 1,
      topFrameNamed: true,
      topFrameSourceMapped: true,
    },
    modules: {
      collected: false,
      totalModules: 0,
      withExplicitStatus: 0,
      symbolsAvailable: 0,
      symbolsMissing: 0,
      symbolsUnknown: 0,
    },
    limitations: [],
  };
}

function writerSnapshot(threadId: number, frameName: string) {
  const frame: DebugProtocol.StackFrame = {
    id: 100 + threadId,
    name: frameName,
    source: { name: `${frameName}.cpp`, path: `/tmp/${frameName}.cpp` },
    line: 12,
    column: 1,
    instructionPointerReference: '0x1000',
  };
  return {
    stopped: { reason: 'breakpoint', threadId },
    thread: { id: threadId, name: `thread-${threadId}` },
    stack: [frame],
    frame,
    scopes: [],
    locals: [],
    registers: [],
    symbolHealth: symbolHealth(),
    disassembly: [],
  };
}

test('debug_find_writer snapshots the thread that actually triggered the watchpoint', async () => {
  const connection = new EventEmitter();
  let snapshotCount = 0;
  let capturedThreadId: number | undefined;
  const previous: DebugProtocol.DataBreakpoint[] = [];

  const session = {
    isPostmortem: () => false,
    runExclusiveLifecycle: async <T>(_name: string, action: () => Promise<T>) => action(),
    runtimeSnapshot: async (options?: { threadId?: number }) => {
      snapshotCount += 1;
      if (snapshotCount === 1) return writerSnapshot(7, 'before');
      capturedThreadId = options?.threadId;
      return writerSnapshot(options?.threadId ?? 7, options?.threadId === 12 ? 'writer_on_thread_12' : 'wrong_thread');
    },
    dataBreakpointInfo: async () => ({
      dataId: 'watch-value',
      description: 'value',
      accessTypes: ['write'],
      canPersist: false,
    }),
    dataBreakpointConfiguration: () => previous.map((item) => ({ ...item })),
    setDataBreakpoints: async (breakpoints: DebugProtocol.DataBreakpoint[]) =>
      breakpoints.map((_item, index) => ({ verified: true, id: index + 1 })),
    connection,
    continueExecution: async () => {
      queueMicrotask(() => connection.emit('event', {
        seq: 1,
        type: 'event',
        event: 'stopped',
        body: { reason: 'data breakpoint', threadId: 12, allThreadsStopped: false },
      } satisfies DebugProtocol.Event));
      return {};
    },
    pause: async () => ({}),
    snapshot: () => ({ configured: true, adapterId: 'lldb-dap', capabilities: { supportsDataBreakpoints: true } }),
  } as never;

  const output = await findWriter(session, { name: 'value', accessType: 'write', timeoutMs: 1000 });
  assert.equal(capturedThreadId, 12);
  assert.equal(output.hitConfirmed, true);
  assert.equal(output.snapshot?.thread.id, 12);
  assert.equal(output.writerFrame?.name, 'writer_on_thread_12');
});

test('runtimeSnapshot does not reuse a stale stopped event after execution continued', async (t) => {
  const session = new DapSession();
  t.after(async () => session.reset());
  await session.start(mockStartOptions());
  await session.launch({ program: '/tmp/fake-app' });
  await session.connection.waitForEvent('stopped', 2_000, undefined, true);

  (session.connection as unknown as { handleMessage(message: DebugProtocol.ProtocolMessage): void }).handleMessage({
    seq: 50_000,
    type: 'event',
    event: 'continued',
    body: { threadId: 1, allThreadsContinued: true },
  } as DebugProtocol.Event);

  const snapshot = await session.runtimeSnapshot({ includeExceptionInfo: true });
  assert.equal(snapshot.stopped, undefined);
  assert.equal(snapshot.exception, undefined);
});

test('failed pause request removes its stopped-event waiter immediately', async (t) => {
  const session = new DapSession();
  t.after(async () => session.reset());
  await session.start(mockStartOptions());
  await session.launch({ program: '/tmp/fake-app' });

  const before = session.connection.listenerCount('event:stopped');
  await assert.rejects(session.pause(999, true, 5_000), /mock pause rejected/i);
  assert.equal(session.connection.listenerCount('event:stopped'), before);
  assert.equal(session.snapshot().stateUncertain, false);
});

test('timeout of a state-changing request marks session state uncertain and blocks further inspection until reset', async (t) => {
  const session = new DapSession();
  t.after(async () => session.reset());
  await session.start(mockStartOptions());
  await session.launch({ program: '/tmp/fake-app' });

  const original = session.connection.sendRequest.bind(session.connection);
  session.connection.sendRequest = (async (command: string, args?: unknown, timeoutMs?: number) => {
    if (command === 'evaluate') throw new DapTimeoutError("response to 'evaluate'", timeoutMs ?? 1);
    return original(command, args, timeoutMs);
  }) as typeof session.connection.sendRequest;

  await assert.rejects(session.evaluate('possibly_mutating_call()'), /timed out/i);
  assert.equal(session.snapshot().stateUncertain, true);
  await assert.rejects(session.threads(), /state is uncertain/i);
});

test('inspect-only policy permits only recognized postmortem attach shapes', async () => {
  const policy = createDapRequestPolicy('inspect-only');

  assert.deepEqual(await policy({ command: 'attach', args: { coreFile: '/tmp/crash.core', program: '/tmp/app' } }), { allow: true });
  assert.deepEqual(await policy({
    command: 'attach',
    args: {
      targetCreateCommands: ['target create -c "/tmp/crash.core" "/tmp/app"'],
      processCreateCommands: [],
    },
  }), { allow: true });

  assert.equal((await policy({ command: 'attach', args: { processId: 1234 } })).allow, false);
  assert.equal((await policy({ command: 'launch', args: { program: '/tmp/app' } })).allow, false);
  assert.equal((await policy({
    command: 'attach',
    args: { targetCreateCommands: ['process launch'], processCreateCommands: [] },
  })).allow, false);
});

function diagnosticSnapshot(stopped: DebugProtocol.StoppedEvent['body'], registers: DebugProtocol.Variable[] = []) {
  const frame: DebugProtocol.StackFrame = {
    id: 1,
    name: 'faulting_function',
    source: { name: 'main.cpp', path: '/repo/main.cpp' },
    line: 10,
    column: 1,
    instructionPointerReference: '0x1000',
  };
  return {
    stopped,
    thread: { id: 1, name: 'main' },
    stack: [frame],
    frame,
    scopes: [],
    locals: [],
    registers,
    symbolHealth: symbolHealth(),
    disassembly: [{ address: '0x1000', instruction: 'mov eax, dword ptr [rdi+8]' }],
  };
}

test('unknown debugger signal stops are not automatically classified as crashes', () => {
  const diagnosis = analyzeRuntimeSnapshot(diagnosticSnapshot({
    reason: 'signal',
    description: 'SIGTRAP',
    threadId: 1,
  }));
  assert.equal(diagnosis.classification.category, 'signal');
  assert.equal(diagnosis.classification.crashLikely, false);
  assert.equal(diagnosis.classification.confidence, 'low');
});

test('an unrelated zero register cannot create a high-confidence null-dereference hypothesis', () => {
  const diagnosis = analyzeRuntimeSnapshot(diagnosticSnapshot(
    { reason: 'exception', description: 'segmentation fault', threadId: 1 },
    [{ name: 'rcx', value: '0x0', type: 'uint64_t', variablesReference: 0 }],
  ));
  const hypothesis = diagnosis.hypotheses.find((item) => item.kind === 'null-dereference');
  assert.ok(hypothesis);
  assert.equal(hypothesis.confidence, 'low');
});

test('HOL Guard bridge environment cannot inherit Python import-path injection', () => {
  const environment = buildHolGuardBridgeEnvironment({
    PATH: '/usr/bin',
    HOME: '/home/fixture',
    HOL_GUARD_HOME: '/tmp/guard',
    PYTHONPATH: '/tmp/evil-imports',
    PYTHONHOME: '/tmp/evil-runtime',
  });
  assert.equal(environment.PATH, '/usr/bin');
  assert.equal(environment.HOL_GUARD_HOME, '/tmp/guard');
  assert.equal(environment.PYTHONPATH, undefined);
  assert.equal(environment.PYTHONHOME, undefined);
});

test('CodeLLDB extension auto-discovery rejects versions older than 1.11.0', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qwen-dap-codelldb-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = process.platform === 'win32' ? 'codelldb.exe' : 'codelldb';

  const oldDir = join(root, 'vadimcn.vscode-lldb-1.10.0', 'adapter');
  mkdirSync(oldDir, { recursive: true });
  writeFileSync(join(oldDir, executable), 'fixture');

  assert.throws(() => discoverCodeLldb({
    extensionRoots: [root],
    env: {},
    homeDirectory: root,
    allowPathFallback: false,
  }), /was not found/i);

  const supportedDir = join(root, 'vadimcn.vscode-lldb-1.11.0', 'adapter');
  mkdirSync(supportedDir, { recursive: true });
  writeFileSync(join(supportedDir, executable), 'fixture');

  const found = discoverCodeLldb({
    extensionRoots: [root],
    env: {},
    homeDirectory: root,
    allowPathFallback: false,
  });
  assert.equal(found.source, 'extension');
  assert.equal(found.extensionDirectory, join(root, 'vadimcn.vscode-lldb-1.11.0'));
});

test('full toolset injects explicit MCP behavior annotations for manual tools', () => {
  const definitions = new Map<string, { annotations?: Record<string, boolean> }>();
  const registrar = {
    registerTool(name: string, config: { annotations?: Record<string, boolean> }) {
      definitions.set(name, config);
      return { disable() {}, enable() {}, update() {}, remove() {} };
    },
  };

  registerDebugTools(annotateToolRegistrar(registrar as never), {} as never);

  for (const name of ['debug_start', 'debug_launch', 'debug_attach', 'debug_pause', 'debug_step', 'debug_evaluate']) {
    const annotations = definitions.get(name)?.annotations;
    assert.equal(annotations?.readOnlyHint, false, `${name} must not advertise read-only behavior`);
    assert.equal(annotations?.destructiveHint, true, `${name} can change debugger/target state`);
  }
  for (const name of ['debug_threads', 'debug_stack', 'debug_variables', 'debug_read_memory']) {
    const annotations = definitions.get(name)?.annotations;
    assert.equal(annotations?.readOnlyHint, true, `${name} is inspection-only`);
    assert.equal(annotations?.destructiveHint, false, `${name} should be non-destructive`);
  }
});
