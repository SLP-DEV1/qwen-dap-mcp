import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { DebugProtocol } from '@vscode/debugprotocol';

import { resolveExistingDirectory } from '../local-path.js';
import { logger } from '../logger.js';
import { DapError, DapRequestError, DapTimeoutError } from './errors.js';
import { currentDapOperationContext } from './operation-context.js';
import {
  createDapRequestPolicy,
  resolveDapPolicyMode,
  type DapPolicyMode,
  type DapRequestPolicy,
} from './request-policy.js';

type PendingRequest = {
  command: string;
  generation: number;
  resolve: (response: DebugProtocol.Response) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
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

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown }).then === 'function';
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
  private transportGeneration = 0;
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
    return Boolean(this.child && !childHasExited(this.child));
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get generation(): number {
    return this.transportGeneration;
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

    this.rejectAll(new DapError('DAP adapter session replaced'));
    this.transportGeneration += 1;
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
      this.transportGeneration += 1;
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

    this.transportGeneration += 1;
    this.rejectAll(new DapError('DAP adapter stopped'));

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

    if (this.child === child) {
      this.child = undefined;
      this.emit('adapterExit', { code: child.exitCode, signal: child.signalCode, forcedStop: true });
    }
  }

  async sendRequest(
    command: string,
    args?: unknown,
    timeoutMs = 15_000,
  ): Promise<DebugProtocol.Response> {
    const operation = currentDapOperationContext();
    operation?.throwIfAborted();

    let decision;
    try {
      const policyResult = this.requestPolicy({ command, ...(args === undefined ? {} : { args }) });
      decision = isPromiseLike(policyResult) ? await policyResult : policyResult;
    } catch (error) {
      throw new DapError(`DAP request policy failed closed for '${command}'`, {
        cause: error instanceof Error ? error : undefined,
      });
    }

    operation?.throwIfAborted();

    if (!decision.allow) {
      logger.warn('Blocked outgoing DAP request by policy', { command, reason: decision.reason });
      throw new DapError(`DAP request '${command}' blocked by policy: ${decision.reason}`);
    }

    const child = this.child;
    if (!child || !this.isRunning) {
      throw new DapError('DAP adapter is not running');
    }

    const seq = this.nextSeq++;
    const generation = this.transportGeneration;
    const effectiveTimeoutMs = operation?.remainingMs(timeoutMs) ?? timeoutMs;
    const request: DebugProtocol.Request = {
      seq,
      type: 'request',
      command,
      ...(args === undefined ? {} : { arguments: args }),
    };

    return new Promise<DebugProtocol.Response>((resolve, reject) => {
      let abortHandler: (() => void) | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        if (abortHandler && operation) operation.signal.removeEventListener('abort', abortHandler);
      };
      const rejectPending = (error: Error) => {
        const pending = this.pending.get(seq);
        if (!pending || pending.generation !== generation) return;
        this.pending.delete(seq);
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        rejectPending(new DapTimeoutError(`response to '${command}'`, effectiveTimeoutMs));
      }, effectiveTimeoutMs);

      this.pending.set(seq, { command, generation, resolve, reject, timer, cleanup });

      if (operation) {
        abortHandler = () => {
          rejectPending(new DapError(`DAP request '${command}' cancelled by ${operation.label}`));
        };
        operation.signal.addEventListener('abort', abortHandler, { once: true });
        if (operation.signal.aborted) {
          abortHandler();
          return;
        }
      }

      try {
        this.writeMessage(request);
      } catch (error) {
        rejectPending(error instanceof Error ? error : new DapError(String(error)));
      }
    });
  }

  waitForEvent(
    eventName: string,
    timeoutMs = 15_000,
    predicate?: (event: DebugProtocol.Event) => boolean,
    includeRecent = false,
  ): Promise<DebugProtocol.Event> {
    const operation = currentDapOperationContext();
    operation?.throwIfAborted();
    const effectiveTimeoutMs = operation?.remainingMs(timeoutMs) ?? timeoutMs;

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
      const onAbort = () => {
        cleanup();
        reject(new DapError(`DAP event wait '${eventName}' cancelled${operation ? ` by ${operation.label}` : ''}`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new DapTimeoutError(`DAP event '${eventName}'`, effectiveTimeoutMs));
      }, effectiveTimeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off(eventKey, handler);
        this.off('adapterExit', onAdapterExit);
        this.off('adapterError', onAdapterError);
        operation?.signal.removeEventListener('abort', onAbort);
      };
      this.on(eventKey, handler);
      this.on('adapterExit', onAdapterExit);
      this.on('adapterError', onAdapterError);
      operation?.signal.addEventListener('abort', onAbort, { once: true });

      if (operation?.signal.aborted) {
        onAbort();
        return;
      }

      if (includeRecent) {
        const recent = [...this.eventHistory].reverse().find((record) => {
          if (record.event !== eventName) return false;
          const candidate = {
            seq: 0,
            type: 'event' as const,
            event: record.event,
            ...(record.body === undefined ? {} : { body: record.body }),
          } satisfies DebugProtocol.Event;
          return !predicate || predicate(candidate);
        });
        if (recent) {
          handler({
            seq: 0,
            type: 'event',
            event: recent.event,
            ...(recent.body === undefined ? {} : { body: recent.body }),
          });
        }
      }
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
          this.failProtocol(error);
        }
        return;
      }

      if (headerEnd > MAX_HEADER_BYTES) {
        const error = new DapError(`DAP header exceeded ${MAX_HEADER_BYTES} bytes before its terminator`);
        this.failProtocol(error);
        return;
      }

      const headerText = this.buffer.subarray(0, headerEnd).toString('ascii');
      const lengthMatches = [...headerText.matchAll(/(?:^|\r\n)Content-Length:\s*(\d+)\s*(?=\r\n|$)/gi)];
      const contentLengthText = lengthMatches[0]?.[1];
      if (!contentLengthText || lengthMatches.length !== 1) {
        const error = new DapError(
          lengthMatches.length > 1
            ? 'Invalid DAP header: multiple Content-Length fields are not allowed'
            : `Invalid DAP header: ${headerText.slice(0, 500)}`,
        );
        this.failProtocol(error);
        return;
      }

      const contentLength = Number.parseInt(contentLengthText, 10);
      if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > MAX_DAP_PAYLOAD_BYTES) {
        const error = new DapError(`DAP Content-Length ${contentLengthText} exceeds the ${MAX_DAP_PAYLOAD_BYTES}-byte safety limit`);
        this.failProtocol(error);
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
        this.failProtocol(protocolError);
        return;
      }

      try {
        this.handleMessage(message);
      } catch (error) {
        const protocolError = error instanceof DapError
          ? error
          : new DapError(`Failed to handle DAP message type '${String(message.type)}'`, {
              cause: error instanceof Error ? error : undefined,
            });
        this.failProtocol(protocolError);
        return;
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

      if (pending.generation !== this.transportGeneration) {
        pending.cleanup();
        this.pending.delete(response.request_seq);
        logger.debug('Ignoring late DAP response from a retired transport generation', {
          requestSeq: response.request_seq,
          command: response.command,
          requestGeneration: pending.generation,
          activeGeneration: this.transportGeneration,
        });
        this.emit('orphanResponse', response);
        return;
      }

      pending.cleanup();
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

  private failProtocol(error: DapError): void {
    this.buffer = Buffer.alloc(0);
    this.transportGeneration += 1;
    logger.warn('Fatal DAP protocol error; retiring adapter transport', { error });
    this.rejectAll(error);
    this.emit('protocolError', error);
    this.emit('adapterError', error);
    if (typeof this.child?.kill === 'function') {
      void this.stop().catch((stopError) => {
        logger.warn('Failed while retiring DAP adapter after protocol error', { error: stopError });
      });
    } else {
      this.child = undefined;
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }
}
