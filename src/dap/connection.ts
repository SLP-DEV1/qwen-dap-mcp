import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { DebugProtocol } from '@vscode/debugprotocol';

import { resolveExistingDirectory } from '../local-path.js';
import { logger } from '../logger.js';
import { DapError, DapRequestError, DapTimeoutError } from './errors.js';
import {
  createDapRequestPolicy,
  resolveDapPolicyMode,
  type DapPolicyMode,
  type DapRequestPolicy,
} from './request-policy.js';

type PendingRequest = {
  command: string;
  resolve: (response: DebugProtocol.Response) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type DapAdapterStartOptions = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
};

export type DapConnectionOptions = {
  requestPolicy?: DapRequestPolicy;
  policyMode?: DapPolicyMode;
};

export type DapEventRecord = {
  receivedAt: string;
  event: string;
  body?: unknown;
};

const HEADER_SEPARATOR = Buffer.from('\r\n\r\n');
const MAX_EVENT_HISTORY = 200;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_DAP_PAYLOAD_BYTES = 16 * 1024 * 1024;
const TERMINATE_GRACE_MS = 1_000;
const KILL_GRACE_MS = 2_000;

function childHasExited(child: Pick<ChildProcessWithoutNullStreams, 'exitCode' | 'signalCode'>): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(childHasExited(child)), timeoutMs);
    child.once('exit', onExit);
  });
}

export class DapConnection extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextSeq = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventHistory: DapEventRecord[] = [];
  private readonly stderrLines: string[] = [];
  private requestPolicy: DapRequestPolicy;

  constructor(options: DapConnectionOptions = {}) {
    super();
    this.requestPolicy = options.requestPolicy
      ?? createDapRequestPolicy(options.policyMode ?? resolveDapPolicyMode());
  }

  /** Replace the transport policy used for future outgoing DAP requests. */
  setRequestPolicy(policy: DapRequestPolicy): void {
    this.requestPolicy = policy;
  }

  get isRunning(): boolean {
    // ChildProcess.killed only means a signal was accepted by kill(); it says
    // nothing about whether the process has actually exited. signalCode is
    // populated for signal-terminated children while exitCode can remain null.
    return Boolean(this.child && !childHasExited(this.child));
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get recentEvents(): readonly DapEventRecord[] {
    return this.eventHistory;
  }

  get recentStderr(): readonly string[] {
    return this.stderrLines;
  }

  async start(options: DapAdapterStartOptions): Promise<void> {
    if (this.isRunning) {
      throw new DapError('A DAP adapter is already running');
    }

    const cwd = options.cwd
      ? resolveExistingDirectory(options.cwd, 'DAP adapter working directory')
      : undefined;
    logger.debug('Starting DAP adapter', { command: options.command, ...(cwd ? { cwd } : {}) });

    // Every adapter process is a fresh DAP transport. Never let events/stderr
    // from a previous debuggee influence thread selection or diagnostics.
    this.rejectAll(new DapError('DAP adapter session replaced'));
    this.child = undefined;
    this.buffer = Buffer.alloc(0);
    this.nextSeq = 1;
    this.eventHistory.length = 0;
    this.stderrLines.length = 0;

    const child = spawn(options.command, options.args ?? [], {
      cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });

    this.child = child;
    const isCurrentChild = () => this.child === child;

    child.stdout.on('data', (chunk: Buffer) => {
      if (!isCurrentChild()) return;
      this.onStdout(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (!isCurrentChild()) return;
      this.captureStderr(chunk);
    });
    child.stdin.on('error', (error) => {
      // A retired child can emit stream errors after a new adapter has already
      // started. Never let an old transport reject the new session's requests.
      if (!isCurrentChild()) return;
      const dapError = new DapError(`DAP adapter stdin error: ${error.message}`, { cause: error });
      logger.warn('DAP adapter stdin error', { pid: child.pid, error: dapError });
      this.rejectAll(dapError);
      this.emit('adapterError', dapError);
    });

    child.on('error', (error) => {
      if (!isCurrentChild()) {
        logger.debug('Ignoring error from retired DAP adapter', { pid: child.pid, error });
        return;
      }
      logger.error('DAP adapter process error', { command: options.command, error });
      const dapError = new DapError(`DAP adapter process error: ${error.message}`, { cause: error });
      this.rejectAll(dapError);
      this.emit('adapterError', dapError);
    });

    child.on('exit', (code, signal) => {
      if (!isCurrentChild()) {
        logger.debug('Ignoring exit from retired DAP adapter', { pid: child.pid, code, signal });
        return;
      }
      logger.info('DAP adapter exited', { pid: child.pid, code, signal });
      const detail = signal ? `signal ${signal}` : `exit code ${String(code)}`;
      this.rejectAll(new DapError(`DAP adapter exited with ${detail}`));
      this.child = undefined;
      this.emit('adapterExit', { code, signal });
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        logger.info('DAP adapter started', {
          pid: child.pid,
          command: options.command,
          ...(cwd ? { cwd } : {}),
        });
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        if (this.child === child) this.child = undefined;
        reject(new DapError(`Failed to start DAP adapter '${options.command}': ${error.message}`, { cause: error }));
      };
      const cleanup = () => {
        child.off('spawn', onSpawn);
        child.off('error', onError);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;

    if (!childHasExited(child)) {
      logger.debug('Stopping DAP adapter', { pid: child.pid });
      if (!child.killed) child.kill();

      const exitedNormally = await waitForChildExit(child, TERMINATE_GRACE_MS);
      if (!exitedNormally && !childHasExited(child)) {
        logger.warn('DAP adapter did not exit after termination signal; escalating', { pid: child.pid });
        child.kill('SIGKILL');
        const exitedAfterKill = await waitForChildExit(child, KILL_GRACE_MS);
        if (!exitedAfterKill && !childHasExited(child)) {
          logger.error('DAP adapter still has not reported exit after SIGKILL', { pid: child.pid });
        }
      }
    }

    this.rejectAll(new DapError('DAP adapter stopped'));
    if (this.child === child) this.child = undefined;
  }

  sendRequest(
    command: string,
    args?: unknown,
    timeoutMs = 15_000,
  ): Promise<DebugProtocol.Response> {
    let decision;
    try {
      decision = this.requestPolicy({ command, ...(args === undefined ? {} : { args }) });
    } catch (error) {
      return Promise.reject(new DapError(`DAP request policy failed closed for '${command}'`, {
        cause: error instanceof Error ? error : undefined,
      }));
    }

    if (!decision.allow) {
      logger.warn('Blocked outgoing DAP request by policy', { command, reason: decision.reason });
      return Promise.reject(new DapError(`DAP request '${command}' blocked by policy: ${decision.reason}`));
    }

    const child = this.child;
    if (!child || !this.isRunning) {
      return Promise.reject(new DapError('DAP adapter is not running'));
    }

    const seq = this.nextSeq++;
    const request: DebugProtocol.Request = {
      seq,
      type: 'request',
      command,
      ...(args === undefined ? {} : { arguments: args }),
    };

    return new Promise<DebugProtocol.Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new DapTimeoutError(`response to '${command}'`, timeoutMs));
      }, timeoutMs);

      this.pending.set(seq, { command, resolve, reject, timer });

      try {
        this.writeMessage(request);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(seq);
        reject(error instanceof Error ? error : new DapError(String(error)));
      }
    });
  }

  waitForEvent(
    eventName: string,
    timeoutMs = 15_000,
    predicate?: (event: DebugProtocol.Event) => boolean,
  ): Promise<DebugProtocol.Event> {
    return new Promise((resolve, reject) => {
      const eventKey = `event:${eventName}`;
      const handler = (event: DebugProtocol.Event) => {
        if (predicate && !predicate(event)) return;
        cleanup();
        resolve(event);
      };
      const onAdapterExit = () => {
        cleanup();
        reject(new DapError(`DAP adapter exited while waiting for event '${eventName}'`));
      };
      const onAdapterError = (error: unknown) => {
        cleanup();
        reject(error instanceof Error
          ? error
          : new DapError(`DAP adapter failed while waiting for event '${eventName}'`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new DapTimeoutError(`DAP event '${eventName}'`, timeoutMs));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off(eventKey, handler);
        this.off('adapterExit', onAdapterExit);
        this.off('adapterError', onAdapterError);
      };
      this.on(eventKey, handler);
      this.on('adapterExit', onAdapterExit);
      this.on('adapterError', onAdapterError);
    });
  }

  private writeMessage(message: DebugProtocol.ProtocolMessage): void {
    const child = this.child;
    if (!child || !this.isRunning) {
      throw new DapError('DAP adapter is not running');
    }

    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'ascii');
    child.stdin.write(Buffer.concat([header, payload]));
  }

  private onStdout(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd < 0) {
        if (this.buffer.length > MAX_HEADER_BYTES) {
          const error = new DapError(`DAP header exceeded ${MAX_HEADER_BYTES} bytes without a terminator`);
          this.buffer = Buffer.alloc(0);
          logger.warn('DAP protocol error', { error });
          this.rejectAll(error);
          this.emit('protocolError', error);
        }
        return;
      }

      if (headerEnd > MAX_HEADER_BYTES) {
        const error = new DapError(`DAP header exceeded ${MAX_HEADER_BYTES} bytes before its terminator`);
        this.buffer = Buffer.alloc(0);
        logger.warn('DAP protocol error', { error });
        this.rejectAll(error);
        this.emit('protocolError', error);
        return;
      }

      const headerText = this.buffer.subarray(0, headerEnd).toString('ascii');
      const lengthMatches = [...headerText.matchAll(/(?:^|\r\n)Content-Length:\s*(\d+)\s*(?=\r\n|$)/gi)];
      const contentLengthText = lengthMatches[0]?.[1];
      if (!contentLengthText || lengthMatches.length !== 1) {
        this.buffer = this.buffer.subarray(headerEnd + HEADER_SEPARATOR.length);
        const error = new DapError(
          lengthMatches.length > 1
            ? 'Invalid DAP header: multiple Content-Length fields are not allowed'
            : `Invalid DAP header: ${headerText.slice(0, 500)}`,
        );
        logger.warn('DAP protocol error', { error });
        this.rejectAll(error);
        this.emit('protocolError', error);
        continue;
      }

      const contentLength = Number.parseInt(contentLengthText, 10);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > MAX_DAP_PAYLOAD_BYTES) {
        const error = new DapError(`DAP Content-Length ${contentLengthText} exceeds the ${MAX_DAP_PAYLOAD_BYTES}-byte safety limit`);
        this.buffer = Buffer.alloc(0);
        logger.warn('DAP protocol error', { error });
        this.rejectAll(error);
        this.emit('protocolError', error);
        return;
      }

      const payloadStart = headerEnd + HEADER_SEPARATOR.length;
      const payloadEnd = payloadStart + contentLength;
      if (this.buffer.length < payloadEnd) return;

      const payload = this.buffer.subarray(payloadStart, payloadEnd).toString('utf8');
      this.buffer = this.buffer.subarray(payloadEnd);

      let message: DebugProtocol.ProtocolMessage;
      try {
        message = JSON.parse(payload) as DebugProtocol.ProtocolMessage;
      } catch (error) {
        const protocolError = new DapError(`Failed to parse DAP JSON payload: ${payload.slice(0, 500)}`, {
          cause: error instanceof Error ? error : undefined,
        });
        logger.warn('DAP protocol error', { error: protocolError });
        this.rejectAll(protocolError);
        this.emit('protocolError', protocolError);
        continue;
      }

      try {
        this.handleMessage(message);
      } catch (error) {
        const protocolError = error instanceof DapError
          ? error
          : new DapError(`Failed to handle DAP message type '${String(message.type)}'`, {
              cause: error instanceof Error ? error : undefined,
            });
        logger.warn('DAP protocol error', { error: protocolError });
        this.rejectAll(protocolError);
        this.emit('protocolError', protocolError);
      }
    }
  }

  private handleMessage(message: DebugProtocol.ProtocolMessage): void {
    if (message.type === 'response') {
      const response = message as DebugProtocol.Response;
      const pending = this.pending.get(response.request_seq);
      if (!pending) {
        logger.debug('Received orphan DAP response', { requestSeq: response.request_seq, command: response.command });
        this.emit('orphanResponse', response);
        return;
      }

      clearTimeout(pending.timer);
      this.pending.delete(response.request_seq);

      if (response.success) {
        pending.resolve(response);
      } else {
        pending.reject(new DapRequestError(
          pending.command,
          response.message ?? 'Unknown adapter error',
          response.body,
        ));
      }
      return;
    }

    if (message.type === 'event') {
      const event = message as DebugProtocol.Event;
      const record: DapEventRecord = {
        receivedAt: new Date().toISOString(),
        event: event.event,
        ...(event.body === undefined ? {} : { body: event.body }),
      };
      this.eventHistory.push(record);
      if (this.eventHistory.length > MAX_EVENT_HISTORY) {
        this.eventHistory.splice(0, this.eventHistory.length - MAX_EVENT_HISTORY);
      }
      this.emit('event', event);
      this.emit(`event:${event.event}`, event);
      return;
    }

    if (message.type === 'request') {
      const request = message as DebugProtocol.Request;
      this.emit('reverseRequest', request);
      this.sendUnsupportedReverseRequest(request);
    }
  }

  private sendUnsupportedReverseRequest(request: DebugProtocol.Request): void {
    const response: DebugProtocol.Response = {
      seq: this.nextSeq++,
      type: 'response',
      request_seq: request.seq,
      command: request.command,
      success: false,
      message: `Reverse request '${request.command}' is not supported by qwen-dap-mcp`,
    };
    this.writeMessage(response);
  }

  private captureStderr(chunk: string): void {
    const lines = chunk.split(/\r?\n/).filter(Boolean);
    this.stderrLines.push(...lines);
    if (this.stderrLines.length > 100) {
      this.stderrLines.splice(0, this.stderrLines.length - 100);
    }
    logger.debug('DAP adapter wrote to stderr', { lineCount: lines.length });
    this.emit('adapterStderr', chunk);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
