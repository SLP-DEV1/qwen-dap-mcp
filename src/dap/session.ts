import type { DebugProtocol } from '@vscode/debugprotocol';

import { DapConnection, type DapAdapterStartOptions } from './connection.js';
import { DapError } from './errors.js';

export type SourceBreakpointGroup = {
  source: string;
  lines: number[];
};

export type StartSessionOptions = DapAdapterStartOptions & {
  adapterId: string;
  requestTimeoutMs?: number;
};

export type SessionSnapshot = {
  adapterRunning: boolean;
  adapterPid?: number;
  initialized: boolean;
  configured: boolean;
  activeRequest?: 'launch' | 'attach';
  capabilities?: DebugProtocol.Capabilities;
  recentEvents: readonly unknown[];
  recentAdapterStderr: readonly string[];
};

export class DapSession {
  readonly connection = new DapConnection();

  private initialized = false;
  private configured = false;
  private activeRequest?: 'launch' | 'attach';
  private capabilities?: DebugProtocol.Capabilities;
  private requestTimeoutMs = 15_000;

  async start(options: StartSessionOptions): Promise<DebugProtocol.Capabilities> {
    await this.reset();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;

    await this.connection.start({
      command: options.command,
      ...(options.args ? { args: options.args } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
    });

    try {
      const response = await this.connection.sendRequest(
        'initialize',
        {
          clientID: 'qwen-dap-mcp',
          clientName: 'qwen-dap-mcp',
          adapterID: options.adapterId,
          pathFormat: 'path',
          linesStartAt1: true,
          columnsStartAt1: true,
          supportsVariableType: true,
          supportsVariablePaging: true,
          supportsRunInTerminalRequest: false,
          supportsMemoryReferences: true,
          supportsProgressReporting: true,
          supportsInvalidatedEvent: true,
          supportsMemoryEvent: true,
          locale: 'en',
        } satisfies DebugProtocol.InitializeRequestArguments,
        this.requestTimeoutMs,
      );

      this.capabilities = (response.body ?? {}) as DebugProtocol.Capabilities;
      this.initialized = true;
      return this.capabilities;
    } catch (error) {
      await this.connection.stop();
      throw error;
    }
  }

  async launch(
    configuration: Record<string, unknown>,
    breakpoints: SourceBreakpointGroup[] = [],
  ): Promise<unknown> {
    return this.beginDebugRequest('launch', configuration, breakpoints);
  }

  async attach(
    configuration: Record<string, unknown>,
    breakpoints: SourceBreakpointGroup[] = [],
  ): Promise<unknown> {
    return this.beginDebugRequest('attach', configuration, breakpoints);
  }

  async setBreakpoints(
    source: string,
    lines: number[],
  ): Promise<DebugProtocol.Breakpoint[]> {
    this.assertInitialized();
    const response = await this.connection.sendRequest(
      'setBreakpoints',
      {
        source: { path: source },
        breakpoints: lines.map((line) => ({ line })),
        sourceModified: false,
      } satisfies DebugProtocol.SetBreakpointsArguments,
      this.requestTimeoutMs,
    );
    return ((response.body as DebugProtocol.SetBreakpointsResponse['body'] | undefined)?.breakpoints ?? []);
  }

  async continueExecution(threadId: number, waitForStop = true, timeoutMs = 15_000): Promise<unknown> {
    this.assertConfigured();
    const stopped = waitForStop
      ? this.connection.waitForEvent(
          'stopped',
          timeoutMs,
          (event) => {
            const body = event.body as DebugProtocol.StoppedEvent['body'] | undefined;
            return body?.allThreadsStopped === true || body?.threadId === undefined || body.threadId === threadId;
          },
        )
      : undefined;

    const response = await this.connection.sendRequest(
      'continue',
      { threadId } satisfies DebugProtocol.ContinueArguments,
      this.requestTimeoutMs,
    );

    if (!stopped) {
      return response.body ?? {};
    }

    const event = await stopped;
    return { response: response.body ?? {}, stopped: event.body ?? {} };
  }

  async step(
    action: 'next' | 'stepIn' | 'stepOut',
    threadId: number,
    waitForStop = true,
    timeoutMs = 15_000,
  ): Promise<unknown> {
    this.assertConfigured();
    const stopped = waitForStop
      ? this.connection.waitForEvent(
          'stopped',
          timeoutMs,
          (event) => {
            const body = event.body as DebugProtocol.StoppedEvent['body'] | undefined;
            return body?.allThreadsStopped === true || body?.threadId === undefined || body.threadId === threadId;
          },
        )
      : undefined;

    const response = await this.connection.sendRequest(
      action,
      { threadId } satisfies DebugProtocol.NextArguments,
      this.requestTimeoutMs,
    );

    if (!stopped) {
      return response.body ?? {};
    }

    const event = await stopped;
    return { response: response.body ?? {}, stopped: event.body ?? {} };
  }

  async threads(): Promise<DebugProtocol.Thread[]> {
    this.assertConfigured();
    const response = await this.connection.sendRequest('threads', {}, this.requestTimeoutMs);
    return ((response.body as DebugProtocol.ThreadsResponse['body'] | undefined)?.threads ?? []);
  }

  async stackTrace(threadId: number, startFrame = 0, levels = 20): Promise<DebugProtocol.StackFrame[]> {
    this.assertConfigured();
    const response = await this.connection.sendRequest(
      'stackTrace',
      { threadId, startFrame, levels } satisfies DebugProtocol.StackTraceArguments,
      this.requestTimeoutMs,
    );
    return ((response.body as DebugProtocol.StackTraceResponse['body'] | undefined)?.stackFrames ?? []);
  }

  async scopes(frameId: number): Promise<DebugProtocol.Scope[]> {
    this.assertConfigured();
    const response = await this.connection.sendRequest(
      'scopes',
      { frameId } satisfies DebugProtocol.ScopesArguments,
      this.requestTimeoutMs,
    );
    return ((response.body as DebugProtocol.ScopesResponse['body'] | undefined)?.scopes ?? []);
  }

  async variables(variablesReference: number, start?: number, count?: number): Promise<DebugProtocol.Variable[]> {
    this.assertConfigured();
    const args: DebugProtocol.VariablesArguments = {
      variablesReference,
      ...(start === undefined ? {} : { start }),
      ...(count === undefined ? {} : { count }),
    };
    const response = await this.connection.sendRequest('variables', args, this.requestTimeoutMs);
    return ((response.body as DebugProtocol.VariablesResponse['body'] | undefined)?.variables ?? []);
  }

  async evaluate(expression: string, frameId?: number, context: DebugProtocol.EvaluateArguments['context'] = 'watch'):
    Promise<DebugProtocol.EvaluateResponse['body']> {
    this.assertConfigured();
    const args: DebugProtocol.EvaluateArguments = {
      expression,
      context,
      ...(frameId === undefined ? {} : { frameId }),
    };
    const response = await this.connection.sendRequest('evaluate', args, this.requestTimeoutMs);
    return (response.body ?? { result: '', variablesReference: 0 }) as DebugProtocol.EvaluateResponse['body'];
  }

  snapshot(): SessionSnapshot {
    return {
      adapterRunning: this.connection.isRunning,
      ...(this.connection.pid === undefined ? {} : { adapterPid: this.connection.pid }),
      initialized: this.initialized,
      configured: this.configured,
      ...(this.activeRequest === undefined ? {} : { activeRequest: this.activeRequest }),
      ...(this.capabilities === undefined ? {} : { capabilities: this.capabilities }),
      recentEvents: this.connection.recentEvents.slice(-25),
      recentAdapterStderr: this.connection.recentStderr.slice(-25),
    };
  }

  async disconnect(terminateDebuggee = true): Promise<void> {
    if (this.connection.isRunning && this.initialized) {
      try {
        await this.connection.sendRequest(
          'disconnect',
          { terminateDebuggee } satisfies DebugProtocol.DisconnectArguments,
          Math.min(this.requestTimeoutMs, 5_000),
        );
      } catch {
        // The adapter may terminate before acknowledging disconnect.
      }
    }
    await this.reset();
  }

  async reset(): Promise<void> {
    await this.connection.stop();
    this.initialized = false;
    this.configured = false;
    this.activeRequest = undefined;
    this.capabilities = undefined;
  }

  private async beginDebugRequest(
    request: 'launch' | 'attach',
    configuration: Record<string, unknown>,
    breakpoints: SourceBreakpointGroup[],
  ): Promise<unknown> {
    this.assertInitialized();
    this.configured = false;
    this.activeRequest = request;

    const initializedEvent = this.connection.waitForEvent('initialized', this.requestTimeoutMs);
    const requestPromise = this.connection.sendRequest(request, configuration, Math.max(this.requestTimeoutMs, 60_000));

    await initializedEvent;

    const breakpointResults: Array<{ source: string; breakpoints: DebugProtocol.Breakpoint[] }> = [];
    for (const group of breakpoints) {
      breakpointResults.push({
        source: group.source,
        breakpoints: await this.setBreakpoints(group.source, group.lines),
      });
    }

    if (this.capabilities?.supportsConfigurationDoneRequest) {
      await this.connection.sendRequest('configurationDone', {}, this.requestTimeoutMs);
    }

    const response = await requestPromise;
    this.configured = true;

    return {
      request,
      response: response.body ?? {},
      breakpoints: breakpointResults,
      capabilities: this.capabilities ?? {},
    };
  }

  private assertInitialized(): void {
    if (!this.initialized || !this.connection.isRunning) {
      throw new DapError('No initialized DAP session. Call debug_start first.');
    }
  }

  private assertConfigured(): void {
    this.assertInitialized();
    if (!this.configured) {
      throw new DapError('The debuggee has not been launched or attached yet.');
    }
  }
}
