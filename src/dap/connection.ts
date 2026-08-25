import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { DebugProtocol } from '@vscode/debugprotocol';

import { DapError, DapRequestError, DapTimeoutError } from './errors.js';

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

export type DapEventRecord = {
  receivedAt: string;
  event: string;
  body?: unknown;
};

const HEADER_SEPARATOR = Buffer.from('\r\n\r\n');
const MAX_EVENT_HISTORY = 200;

export class DapConnection extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextSeq = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventHistory: DapEventRecord[] = [];
  private readonly stderrLines: string[] = [];

  get isRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
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

    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });

    this.child = child;
    this.buffer = Buffer.alloc(0);

    child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.captureStderr(chunk));

    child.on('error', (error) => {
      this.rejectAll(new DapError(`DAP adapter process error: ${error.message}`, { cause: error }));
      this.emit('adapterError', error);
    });

    child.on('exit', (code, signal) => {
      const detail = signal ? `signal ${signal}` : `exit code ${String(code)}`;
      this.rejectAll(new DapError(`DAP adapter exited with ${detail}`));
      this.emit('adapterExit', { code, signal });
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
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
    if (!child || child.exitCode !== null || child.killed) {
      this.child = undefined;
      return;
    }

    child.kill();
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);

    if (child.exitCode === null && !child.killed) {
      child.kill('SIGKILL');
    }
    this.child = undefined;
  }

  sendRequest(
    command: string,
    args?: unknown,
    timeoutMs = 15_000,
  ): Promise<DebugProtocol.Response> {
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
        if (predicate && !predicate(event)) {
          return;
        }
        cleanup();
        resolve(event);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new DapTimeoutError(`DAP event '${eventName}'`, timeoutMs));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off(eventKey, handler);
      };
      this.on(eventKey, handler);
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
        return;
      }

      const headerText = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(headerText);
      if (!match?.[1]) {
        this.buffer = this.buffer.subarray(headerEnd + HEADER_SEPARATOR.length);
        this.emit('protocolError', new DapError(`Invalid DAP header: ${headerText}`));
        continue;
      }

      const contentLength = Number.parseInt(match[1], 10);
      const payloadStart = headerEnd + HEADER_SEPARATOR.length;
      const payloadEnd = payloadStart + contentLength;
      if (this.buffer.length < payloadEnd) {
        return;
      }

      const payload = this.buffer.subarray(payloadStart, payloadEnd).toString('utf8');
      this.buffer = this.buffer.subarray(payloadEnd);

      try {
        const message = JSON.parse(payload) as DebugProtocol.ProtocolMessage;
        this.handleMessage(message);
      } catch (error) {
        this.emit(
          'protocolError',
          new DapError(`Failed to parse DAP JSON payload: ${payload.slice(0, 500)}`, {
            cause: error instanceof Error ? error : undefined,
          }),
        );
      }
    }
  }

  private handleMessage(message: DebugProtocol.ProtocolMessage): void {
    if (message.type === 'response') {
      const response = message as DebugProtocol.Response;
      const pending = this.pending.get(response.request_seq);
      if (!pending) {
        this.emit('orphanResponse', response);
        return;
      }

      clearTimeout(pending.timer);
      this.pending.delete(response.request_seq);

      if (response.success) {
        pending.resolve(response);
      } else {
        pending.reject(
          new DapRequestError(
            pending.command,
            response.message ?? 'Unknown adapter error',
            response.body,
          ),
        );
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
      message: `Reverse request '${request.command}' is not supported by qwen-dap-mcp MVP`,
    };
    this.writeMessage(response);
  }

  private captureStderr(chunk: string): void {
    const lines = chunk.split(/\r?\n/).filter(Boolean);
    this.stderrLines.push(...lines);
    if (this.stderrLines.length > 100) {
      this.stderrLines.splice(0, this.stderrLines.length - 100);
    }
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
