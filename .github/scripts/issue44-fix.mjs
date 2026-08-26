import { readFileSync, writeFileSync } from 'node:fs';

function read(path) {
  return readFileSync(path, 'utf8');
}

function write(path, value) {
  writeFileSync(path, value, 'utf8');
}

function replaceOnce(text, oldValue, newValue, label) {
  const index = text.indexOf(oldValue);
  if (index < 0) throw new Error(`Missing patch anchor: ${label}`);
  if (text.indexOf(oldValue, index + oldValue.length) >= 0) {
    throw new Error(`Patch anchor is ambiguous: ${label}`);
  }
  return text.slice(0, index) + newValue + text.slice(index + oldValue.length);
}

// Findings 2 + 5: observable filtering, stable no-op handle, safe env fallback.
{
  const path = 'src/toolset.ts';
  let text = read(path);
  if (!text.includes("import { logger } from './logger.js';")) {
    text = "import { logger } from './logger.js';\n\n" + text;
  }
  text = replaceOnce(
    text,
    "  throw new Error(\n    `Invalid QWEN_DAP_MCP_TOOLSET '${value}'. Expected 'agent' or 'full'.`,\n  );",
    "  logger.warn('Invalid QWEN_DAP_MCP_TOOLSET; falling back to the safe agent toolset', { value });\n  return 'agent';",
    'toolset fallback',
  );
  text = replaceOnce(
    text,
    "type ToolRegistrar = {\n  // McpServer.registerTool is overloaded/generic; this preserves its call\n  // surface while filtering only by the first tool-name argument.\n  registerTool: (...args: any[]) => any;\n};",
    "type ToolRegistrar = {\n  // McpServer.registerTool is overloaded/generic; this preserves its call\n  // surface while filtering only by the first tool-name argument.\n  registerTool: (...args: any[]) => any;\n};\n\nconst FILTERED_TOOL_HANDLE = Object.freeze({\n  disable: () => undefined,\n  enable: () => undefined,\n  update: (..._args: any[]) => undefined,\n  remove: () => undefined,\n});",
    'filtered tool handle',
  );
  text = replaceOnce(
    text,
    "          if (!toolsetAllows(mode, name)) return undefined;\n          return target.registerTool.call(target, name, ...args);",
    "          if (!toolsetAllows(mode, name)) {\n            logger.debug('Tool registration filtered by active toolset', { mode, tool: name });\n            return FILTERED_TOOL_HANDLE;\n          }\n          return target.registerTool.call(target, name, ...args);",
    'filtered registration',
  );
  write(path, text);
}

// Findings 1 + 3: deterministic event waiter rejection and fail-closed protocol handling.
{
  const path = 'src/dap/connection.ts';
  let text = read(path);
  text = replaceOnce(
    text,
    "    this.rejectAll(new DapError('DAP adapter stopped'));\n    if (this.child === child) this.child = undefined;",
    "    this.rejectAll(new DapError('DAP adapter stopped'));\n    if (this.child === child) {\n      this.child = undefined;\n      // A direct stop can retire the transport before Node reports an exit.\n      // Wake event waiters deterministically instead of leaving them to timeout.\n      this.emit('adapterExit', { code: child.exitCode, signal: child.signalCode, forcedStop: true });\n    }",
    'explicit stop waiter wakeup',
  );

  const fatalPatterns = [
    [
      "          this.buffer = Buffer.alloc(0);\n          logger.warn('DAP protocol error', { error });\n          this.rejectAll(error);\n          this.emit('protocolError', error);",
      "          this.failProtocol(error);",
    ],
    [
      "        this.buffer = Buffer.alloc(0);\n        logger.warn('DAP protocol error', { error });\n        this.rejectAll(error);\n        this.emit('protocolError', error);",
      "        this.failProtocol(error);",
    ],
    [
      "        this.buffer = this.buffer.subarray(headerEnd + HEADER_SEPARATOR.length);\n        const error = new DapError(\n          lengthMatches.length > 1\n            ? 'Invalid DAP header: multiple Content-Length fields are not allowed'\n            : `Invalid DAP header: ${headerText.slice(0, 500)}`,\n        );\n        logger.warn('DAP protocol error', { error });\n        this.rejectAll(error);\n        this.emit('protocolError', error);\n        continue;",
      "        const error = new DapError(\n          lengthMatches.length > 1\n            ? 'Invalid DAP header: multiple Content-Length fields are not allowed'\n            : `Invalid DAP header: ${headerText.slice(0, 500)}`,\n        );\n        this.failProtocol(error);\n        return;",
    ],
    [
      "        logger.warn('DAP protocol error', { error: protocolError });\n        this.rejectAll(protocolError);\n        this.emit('protocolError', protocolError);\n        continue;",
      "        this.failProtocol(protocolError);\n        return;",
    ],
    [
      "        logger.warn('DAP protocol error', { error: protocolError });\n        this.rejectAll(protocolError);\n        this.emit('protocolError', protocolError);",
      "        this.failProtocol(protocolError);\n        return;",
    ],
  ];

  for (const [oldValue, newValue] of fatalPatterns) {
    if (text.includes(oldValue)) text = text.replace(oldValue, newValue);
  }

  const helperAnchor = "  private rejectAll(error: Error): void {";
  if (!text.includes('private failProtocol(error: DapError): void')) {
    text = replaceOnce(
      text,
      helperAnchor,
      "  /**\n   * DAP framing/JSON errors are fatal for this transport. Once message\n   * boundaries are untrustworthy, attempting stream resynchronization can\n   * pair a response with the wrong request. Fail closed and retire the adapter.\n   */\n  private failProtocol(error: DapError): void {\n    this.buffer = Buffer.alloc(0);\n    logger.warn('Fatal DAP protocol error; retiring adapter transport', { error });\n    this.rejectAll(error);\n    this.emit('protocolError', error);\n    this.emit('adapterError', error);\n    void this.stop().catch((stopError) => {\n      logger.warn('Failed while retiring DAP adapter after protocol error', { error: stopError });\n    });\n  }\n\n" + helperAnchor,
      'protocol failure helper',
    );
  }
  write(path, text);
}

// Finding 4: bounds on raw memory/disassembly parameters.
{
  const path = 'src/dap/session.ts';
  let text = read(path);
  if (!text.includes('const MAX_READ_MEMORY_BYTES')) {
    text = replaceOnce(
      text,
      'export type SourceBreakpointGroup = {',
      "const MAX_READ_MEMORY_BYTES = 1024 * 1024;\nconst MAX_DISASSEMBLY_INSTRUCTIONS = 10_000;\nconst MAX_RELATIVE_DAP_OFFSET = 2_147_483_647;\n\nfunction assertSafeIntegerInRange(name: string, value: number, min: number, max: number): void {\n  if (!Number.isSafeInteger(value) || value < min || value > max) {\n    throw new DapError(`${name} must be a safe integer between ${min} and ${max}; received ${String(value)}`);\n  }\n}\n\nexport type SourceBreakpointGroup = {",
      'session numeric bounds',
    );
  }
  text = replaceOnce(
    text,
    "  async disassemble(memoryReference: string, instructionCount = 20, instructionOffset = 0, offset = 0, resolveSymbols = true): Promise<DebugProtocol.DisassembledInstruction[]> {\n    this.assertConfigured();\n    this.assertCapability('supportsDisassembleRequest', 'disassemble');",
    "  async disassemble(memoryReference: string, instructionCount = 20, instructionOffset = 0, offset = 0, resolveSymbols = true): Promise<DebugProtocol.DisassembledInstruction[]> {\n    this.assertConfigured();\n    this.assertCapability('supportsDisassembleRequest', 'disassemble');\n    assertSafeIntegerInRange('instructionCount', instructionCount, 1, MAX_DISASSEMBLY_INSTRUCTIONS);\n    assertSafeIntegerInRange('instructionOffset', instructionOffset, -MAX_RELATIVE_DAP_OFFSET, MAX_RELATIVE_DAP_OFFSET);\n    assertSafeIntegerInRange('offset', offset, -MAX_RELATIVE_DAP_OFFSET, MAX_RELATIVE_DAP_OFFSET);",
    'disassemble validation',
  );
  text = replaceOnce(
    text,
    "  async readMemory(memoryReference: string, count: number, offset = 0): Promise<NonNullable<DebugProtocol.ReadMemoryResponse['body']>> {\n    this.assertConfigured();\n    this.assertCapability('supportsReadMemoryRequest', 'readMemory');",
    "  async readMemory(memoryReference: string, count: number, offset = 0): Promise<NonNullable<DebugProtocol.ReadMemoryResponse['body']>> {\n    this.assertConfigured();\n    this.assertCapability('supportsReadMemoryRequest', 'readMemory');\n    assertSafeIntegerInRange('count', count, 1, MAX_READ_MEMORY_BYTES);\n    assertSafeIntegerInRange('offset', offset, -MAX_RELATIVE_DAP_OFFSET, MAX_RELATIVE_DAP_OFFSET);",
    'readMemory validation',
  );
  write(path, text);
}

// Update existing toolset expectations.
{
  const path = 'test/toolset.test.ts';
  let text = read(path);
  text = replaceOnce(
    text,
    "  assert.throws(\n    () => resolveToolsetMode('tiny'),\n    /Expected 'agent' or 'full'/,\n  );",
    "  assert.equal(resolveToolsetMode('tiny'), 'agent');",
    'toolset fallback test',
  );
  text = replaceOnce(
    text,
    '  assert.equal(hidden, undefined);',
    "  assert.equal(typeof hidden.disable, 'function');\n  assert.equal(typeof hidden.enable, 'function');\n  assert.equal(typeof hidden.update, 'function');\n  assert.equal(typeof hidden.remove, 'function');",
    'filtered tool handle test',
  );
  write(path, text);
}

write('test/issue44-hardening.test.ts', `import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { DapConnection } from '../src/dap/connection.js';
import { DapSession } from '../src/dap/session.js';
import { filterToolRegistrar, resolveToolsetMode } from '../src/toolset.js';

type TestableConnection = DapConnection & { onStdout(chunk: Buffer): void };

function fakeChild(exited = false) {
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: boolean;
    kill(signal?: NodeJS.Signals): boolean;
    stdin: { write(chunk: Buffer): boolean };
  };
  child.exitCode = exited ? 0 : null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  child.stdin = { write: () => true };
  return child;
}

test('explicit connection stop rejects in-flight event waiters without relying on a child exit callback', async () => {
  const connection = new DapConnection();
  (connection as unknown as { child: unknown }).child = fakeChild(true);
  const waiter = connection.waitForEvent('stopped', 10_000);
  await connection.stop();
  await assert.rejects(waiter, /adapter exited while waiting for event 'stopped'/i);
});

test('malformed DAP framing is fatal and rejects event waiters immediately', async () => {
  const connection = new DapConnection() as TestableConnection;
  const waiter = connection.waitForEvent('stopped', 10_000);
  connection.onStdout(Buffer.from('X-Test: missing-length\\r\\n\\r\\n{}', 'ascii'));
  await assert.rejects(waiter, /invalid DAP header/i);
  assert.equal(connection.recentEvents.length, 0);
});

test('invalid toolset values fall back to agent and hidden tools return a stable no-op handle', () => {
  assert.equal(resolveToolsetMode('definitely-not-a-toolset'), 'agent');
  const registered: string[] = [];
  const registrar = { registerTool(name: string) { registered.push(name); return { name }; } };
  const agent = filterToolRegistrar(registrar, 'agent');
  const handle = agent.registerTool('debug_evaluate');
  assert.deepEqual(registered, []);
  assert.equal(typeof handle.disable, 'function');
  assert.equal(typeof handle.enable, 'function');
  assert.equal(typeof handle.update, 'function');
  assert.equal(typeof handle.remove, 'function');
  assert.doesNotThrow(() => { handle.disable(); handle.enable(); handle.update({ enabled: false }); handle.remove(); });
});

test('raw memory and disassembly inputs are bounded before reaching the adapter', async () => {
  const session = new DapSession();
  (session.connection as unknown as { child: unknown }).child = fakeChild(false);
  const internals = session as unknown as { initialized: boolean; configured: boolean; capabilities: Record<string, boolean> };
  internals.initialized = true;
  internals.configured = true;
  internals.capabilities = { supportsReadMemoryRequest: true, supportsDisassembleRequest: true };
  let requests = 0;
  session.connection.sendRequest = (async () => { requests += 1; throw new Error('validation should prevent adapter request'); }) as typeof session.connection.sendRequest;

  await assert.rejects(session.readMemory('0x1000', 0), /count must be a safe integer between 1 and 1048576/i);
  await assert.rejects(session.readMemory('0x1000', 1048577), /count must be a safe integer/i);
  await assert.rejects(session.readMemory('0x1000', 4, Number.NaN), /offset must be a safe integer/i);
  await assert.rejects(session.disassemble('0x1000', 0), /instructionCount must be a safe integer between 1 and 10000/i);
  await assert.rejects(session.disassemble('0x1000', 10001), /instructionCount must be a safe integer/i);
  await assert.rejects(session.disassemble('0x1000', 4, 2147483648), /instructionOffset must be a safe integer/i);
  assert.equal(requests, 0);
  (session.connection as unknown as { child: unknown }).child = undefined;
});
`);
