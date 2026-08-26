import type { DebugProtocol } from '@vscode/debugprotocol';

import { DapConnection, type DapAdapterStartOptions } from './connection.js';
import { DapError } from './errors.js';
import { assessSymbolHealth, type SymbolHealth } from './symbol-health.js';

const MAX_READ_MEMORY_BYTES = 1024 * 1024;
const MAX_DISASSEMBLY_INSTRUCTIONS = 10_000;
const MAX_RELATIVE_DAP_OFFSET = 2_147_483_647;

function assertSafeIntegerInRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new DapError(`${name} must be a safe integer between ${min} and ${max}; received ${String(value)}`);
  }
}

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
  adapterId?: string;
  capabilities?: DebugProtocol.Capabilities;
  recentEvents: readonly unknown[];
  recentAdapterStderr: readonly string[];
};

export type RuntimeSnapshotOptions = {
  threadId?: number;
  stackLevels?: number;
  maxVariablesPerScope?: number;
  includeDisassembly?: boolean;
  disassembleBefore?: number;
  disassembleAfter?: number;
  includeModules?: boolean;
  moduleCount?: number;
  includeExceptionInfo?: boolean;
};

export type RuntimeSnapshotCollectionError = {
  operation: 'locals' | 'registers' | 'disassembly' | 'modules' | 'exceptionInfo';
  message: string;
};

export type RuntimeSnapshot = {
  /** True when the captured state comes from a frozen core/minidump session. */
  postmortem?: boolean;
  stopped?: unknown;
  thread: DebugProtocol.Thread;
  stack: DebugProtocol.StackFrame[];
  frame: DebugProtocol.StackFrame;
  scopes: DebugProtocol.Scope[];
  locals: DebugProtocol.Variable[];
  registers: DebugProtocol.Variable[];
  symbolHealth: SymbolHealth;
  disassembly?: DebugProtocol.DisassembledInstruction[];
  modules?: DebugProtocol.Module[];
  exception?: DebugProtocol.ExceptionInfoResponse['body'];
  collectionErrors?: RuntimeSnapshotCollectionError[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dedupeVariables(variables: DebugProtocol.Variable[]): DebugProtocol.Variable[] {
  const seen = new Set<string>();
  const output: DebugProtocol.Variable[] = [];
  for (const variable of variables) {
    const key = `${variable.name}\u0000${variable.value}\u0000${variable.type ?? ''}\u0000${variable.variablesReference}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(variable);
  }
  return output;
}

export class DapSession {
  readonly connection = new DapConnection();

  private initialized = false;
  private configured = false;
  private activeRequest?: 'launch' | 'attach';
  private adapterId?: string;
  private capabilities?: DebugProtocol.Capabilities;
  private dataBreakpoints: DebugProtocol.DataBreakpoint[] = [];
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
      this.adapterId = options.adapterId;
      this.initialized = true;
      return this.capabilities;
    } catch (error) {
      await this.connection.stop();
      throw error;
    }
  }

  async launch(configuration: Record<string, unknown>, breakpoints: SourceBreakpointGroup[] = []): Promise<unknown> {
    return this.beginDebugRequest('launch', configuration, breakpoints);
  }

  async attach(configuration: Record<string, unknown>, breakpoints: SourceBreakpointGroup[] = []): Promise<unknown> {
    return this.beginDebugRequest('attach', configuration, breakpoints);
  }

  async setBreakpoints(source: string, lines: number[]): Promise<DebugProtocol.Breakpoint[]> {
    return this.setSourceBreakpoints(source, lines.map((line) => ({ line })));
  }

  async setSourceBreakpoints(source: string, breakpoints: DebugProtocol.SourceBreakpoint[]): Promise<DebugProtocol.Breakpoint[]> {
    this.assertInitialized();
    const response = await this.connection.sendRequest(
      'setBreakpoints',
      { source: { path: source }, breakpoints, sourceModified: false } satisfies DebugProtocol.SetBreakpointsArguments,
      this.requestTimeoutMs,
    );
    return ((response.body as DebugProtocol.SetBreakpointsResponse['body'] | undefined)?.breakpoints ?? []);
  }

  async setFunctionBreakpoints(breakpoints: DebugProtocol.FunctionBreakpoint[]): Promise<DebugProtocol.Breakpoint[]> {
    this.assertInitialized();
    this.assertCapability('supportsFunctionBreakpoints', 'setFunctionBreakpoints');
    const response = await this.connection.sendRequest(
      'setFunctionBreakpoints',
      { breakpoints } satisfies DebugProtocol.SetFunctionBreakpointsArguments,
      this.requestTimeoutMs,
    );
    return ((response.body as DebugProtocol.SetFunctionBreakpointsResponse['body'] | undefined)?.breakpoints ?? []);
  }

  async setInstructionBreakpoints(breakpoints: DebugProtocol.InstructionBreakpoint[]): Promise<DebugProtocol.Breakpoint[]> {
    this.assertInitialized();
    this.assertCapability('supportsInstructionBreakpoints', 'setInstructionBreakpoints');
    const response = await this.connection.sendRequest(
      'setInstructionBreakpoints',
      { breakpoints } satisfies DebugProtocol.SetInstructionBreakpointsArguments,
      this.requestTimeoutMs,
    );
    return ((response.body as DebugProtocol.SetInstructionBreakpointsResponse['body'] | undefined)?.breakpoints ?? []);
  }

  async dataBreakpointInfo(name: string, variablesReference?: number, frameId?: number): Promise<NonNullable<DebugProtocol.DataBreakpointInfoResponse['body']>> {
    this.assertConfigured();
    this.assertCapability('supportsDataBreakpoints', 'dataBreakpointInfo');
    const args: DebugProtocol.DataBreakpointInfoArguments = {
      name,
      ...(variablesReference === undefined ? {} : { variablesReference }),
      ...(frameId === undefined ? {} : { frameId }),
    };
    const response = await this.connection.sendRequest('dataBreakpointInfo', args, this.requestTimeoutMs);
    return (response.body ?? { dataId: null, description: name, canPersist: false }) as NonNullable<DebugProtocol.DataBreakpointInfoResponse['body']>;
  }

  async setDataBreakpoints(breakpoints: DebugProtocol.DataBreakpoint[]): Promise<DebugProtocol.Breakpoint[]> {
    this.assertConfigured();
    this.assertCapability('supportsDataBreakpoints', 'setDataBreakpoints');
    const response = await this.connection.sendRequest(
      'setDataBreakpoints',
      { breakpoints } satisfies DebugProtocol.SetDataBreakpointsArguments,
      this.requestTimeoutMs,
    );
    this.dataBreakpoints = breakpoints.map((breakpoint) => ({ ...breakpoint }));
    return ((response.body as DebugProtocol.SetDataBreakpointsResponse['body'] | undefined)?.breakpoints ?? []);
  }

  dataBreakpointConfiguration(): DebugProtocol.DataBreakpoint[] {
    return this.dataBreakpoints.map((breakpoint) => ({ ...breakpoint }));
  }

  async setExceptionBreakpoints(filters: string[], filterOptions?: DebugProtocol.ExceptionFilterOptions[]): Promise<DebugProtocol.Breakpoint[]> {
    this.assertInitialized();
    const args: DebugProtocol.SetExceptionBreakpointsArguments = {
      filters,
      ...(filterOptions === undefined ? {} : { filterOptions }),
    };
    const response = await this.connection.sendRequest('setExceptionBreakpoints', args, this.requestTimeoutMs);
    return ((response.body as DebugProtocol.SetExceptionBreakpointsResponse['body'] | undefined)?.breakpoints ?? []);
  }

  async pause(threadId: number, waitForStop = true, timeoutMs = 15_000): Promise<unknown> {
    this.assertConfigured();
    const stopped = waitForStop ? this.waitForThreadStop(threadId, timeoutMs) : undefined;
    if (stopped) void stopped.catch(() => undefined);

    const response = await this.connection.sendRequest(
      'pause',
      { threadId } satisfies DebugProtocol.PauseArguments,
      this.requestTimeoutMs,
    );
    if (!stopped) return { requestedAction: 'pause', response: response.body ?? {} };
    const event = await stopped;
    return {
      requestedAction: 'pause',
      response: response.body ?? {},
      stopped: event.body ?? {},
    };
  }

  async continueExecution(threadId: number, waitForStop = true, timeoutMs = 15_000): Promise<unknown> {
    this.assertConfigured();
    const stopped = waitForStop ? this.waitForThreadStop(threadId, timeoutMs) : undefined;
    if (stopped) void stopped.catch(() => undefined);

    const response = await this.connection.sendRequest(
      'continue',
      { threadId } satisfies DebugProtocol.ContinueArguments,
      this.requestTimeoutMs,
    );
    if (!stopped) return response.body ?? {};
    const event = await stopped;
    return { response: response.body ?? {}, stopped: event.body ?? {} };
  }

  async step(action: 'next' | 'stepIn' | 'stepOut', threadId: number, waitForStop = true, timeoutMs = 15_000): Promise<unknown> {
    this.assertConfigured();
    const stopped = waitForStop ? this.waitForThreadStop(threadId, timeoutMs) : undefined;
    if (stopped) void stopped.catch(() => undefined);

    const response = await this.connection.sendRequest(
      action,
      { threadId } satisfies DebugProtocol.NextArguments,
      this.requestTimeoutMs,
    );
    if (!stopped) return response.body ?? {};
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
    const response = await this.connection.sendRequest('stackTrace', { threadId, startFrame, levels } satisfies DebugProtocol.StackTraceArguments, this.requestTimeoutMs);
    return ((response.body as DebugProtocol.StackTraceResponse['body'] | undefined)?.stackFrames ?? []);
  }

  async scopes(frameId: number): Promise<DebugProtocol.Scope[]> {
    this.assertConfigured();
    const response = await this.connection.sendRequest('scopes', { frameId } satisfies DebugProtocol.ScopesArguments, this.requestTimeoutMs);
    return ((response.body as DebugProtocol.ScopesResponse['body'] | undefined)?.scopes ?? []);
  }

  async variables(variablesReference: number, start?: number, count?: number): Promise<DebugProtocol.Variable[]> {
    this.assertConfigured();
    if (!Number.isSafeInteger(variablesReference) || variablesReference <= 0) {
      throw new DapError(`variablesReference must be a positive safe integer; received ${String(variablesReference)}`);
    }
    const args: DebugProtocol.VariablesArguments = {
      variablesReference,
      ...(start === undefined ? {} : { start }),
      ...(count === undefined ? {} : { count }),
    };
    const response = await this.connection.sendRequest('variables', args, this.requestTimeoutMs);
    return ((response.body as DebugProtocol.VariablesResponse['body'] | undefined)?.variables ?? []);
  }

  async evaluate(expression: string, frameId?: number, context: DebugProtocol.EvaluateArguments['context'] = 'watch'): Promise<DebugProtocol.EvaluateResponse['body']> {
    this.assertConfigured();
    const args: DebugProtocol.EvaluateArguments = { expression, context, ...(frameId === undefined ? {} : { frameId }) };
    const response = await this.connection.sendRequest('evaluate', args, this.requestTimeoutMs);
    return (response.body ?? { result: '', variablesReference: 0 }) as DebugProtocol.EvaluateResponse['body'];
  }

  async modules(startModule = 0, moduleCount = 100): Promise<DebugProtocol.Module[]> {
    this.assertConfigured();
    this.assertCapability('supportsModulesRequest', 'modules');
    const response = await this.connection.sendRequest('modules', { startModule, moduleCount } satisfies DebugProtocol.ModulesArguments, this.requestTimeoutMs);
    return ((response.body as DebugProtocol.ModulesResponse['body'] | undefined)?.modules ?? []);
  }

  async disassemble(memoryReference: string, instructionCount = 20, instructionOffset = 0, offset = 0, resolveSymbols = true): Promise<DebugProtocol.DisassembledInstruction[]> {
    this.assertConfigured();
    this.assertCapability('supportsDisassembleRequest', 'disassemble');
    assertSafeIntegerInRange('instructionCount', instructionCount, 1, MAX_DISASSEMBLY_INSTRUCTIONS);
    assertSafeIntegerInRange('instructionOffset', instructionOffset, -MAX_RELATIVE_DAP_OFFSET, MAX_RELATIVE_DAP_OFFSET);
    assertSafeIntegerInRange('offset', offset, -MAX_RELATIVE_DAP_OFFSET, MAX_RELATIVE_DAP_OFFSET);
    const response = await this.connection.sendRequest(
      'disassemble',
      { memoryReference, instructionCount, instructionOffset, offset, resolveSymbols } satisfies DebugProtocol.DisassembleArguments,
      this.requestTimeoutMs,
    );
    return ((response.body as DebugProtocol.DisassembleResponse['body'] | undefined)?.instructions ?? []);
  }

  async readMemory(memoryReference: string, count: number, offset = 0): Promise<NonNullable<DebugProtocol.ReadMemoryResponse['body']>> {
    this.assertConfigured();
    this.assertCapability('supportsReadMemoryRequest', 'readMemory');
    assertSafeIntegerInRange('count', count, 1, MAX_READ_MEMORY_BYTES);
    assertSafeIntegerInRange('offset', offset, -MAX_RELATIVE_DAP_OFFSET, MAX_RELATIVE_DAP_OFFSET);
    const response = await this.connection.sendRequest('readMemory', { memoryReference, count, offset } satisfies DebugProtocol.ReadMemoryArguments, this.requestTimeoutMs);
    return (response.body ?? { address: memoryReference }) as NonNullable<DebugProtocol.ReadMemoryResponse['body']>;
  }

  async exceptionInfo(threadId: number): Promise<DebugProtocol.ExceptionInfoResponse['body']> {
    this.assertConfigured();
    this.assertCapability('supportsExceptionInfoRequest', 'exceptionInfo');
    const response = await this.connection.sendRequest('exceptionInfo', { threadId } satisfies DebugProtocol.ExceptionInfoArguments, this.requestTimeoutMs);
    return (response.body ?? { exceptionId: 'unknown', breakMode: 'unhandled' }) as DebugProtocol.ExceptionInfoResponse['body'];
  }

  async runtimeSnapshot(options: RuntimeSnapshotOptions = {}): Promise<RuntimeSnapshot> {
    this.assertConfigured();
    const threadList = await this.threads();
    if (threadList.length === 0) throw new DapError('The debugger returned no threads for debug_snapshot.');

    const lastStopped = [...this.connection.recentEvents].reverse().find((record) => record.event === 'stopped');
    const stoppedBody = lastStopped?.body as DebugProtocol.StoppedEvent['body'] | undefined;
    const selectedThreadId = options.threadId ?? stoppedBody?.threadId ?? threadList[0]?.id;
    const thread = threadList.find((candidate) => candidate.id === selectedThreadId) ?? threadList[0];
    if (!thread) throw new DapError('Unable to select a thread for debug_snapshot.');

    const stack = await this.stackTrace(thread.id, 0, options.stackLevels ?? 12);
    const frame = stack[0];
    if (!frame) throw new DapError(`Thread ${thread.id} has no stack frame for debug_snapshot.`);

    const frameScopes = await this.scopes(frame.id);
    const maxVariables = options.maxVariablesPerScope ?? 100;
    const collectionErrors: RuntimeSnapshotCollectionError[] = [];
    const localScopes = frameScopes
      .filter((scope) => /locals?|arguments?|parameters?/i.test(scope.name))
      .slice(0, 3);
    const registersScope = frameScopes.find((scope) => /register/i.test(scope.name));

    const localVariables: DebugProtocol.Variable[] = [];
    for (const scope of localScopes) {
      if (scope.variablesReference <= 0) continue;
      try {
        localVariables.push(...await this.variables(scope.variablesReference, 0, maxVariables));
      } catch (error) {
        collectionErrors.push({ operation: 'locals', message: `${scope.name}: ${errorMessage(error)}` });
      }
    }
    const locals = dedupeVariables(localVariables).slice(0, maxVariables * Math.max(1, localScopes.length));

    let registers: DebugProtocol.Variable[] = [];
    if (registersScope && registersScope.variablesReference > 0) {
      try {
        registers = dedupeVariables(await this.variables(registersScope.variablesReference, 0, maxVariables)).slice(0, maxVariables);
      } catch (error) {
        collectionErrors.push({ operation: 'registers', message: errorMessage(error) });
      }
    }

    let disassembly: DebugProtocol.DisassembledInstruction[] | undefined;
    if ((options.includeDisassembly ?? true) && this.capabilities?.supportsDisassembleRequest && frame.instructionPointerReference) {
      const before = options.disassembleBefore ?? 8;
      const after = options.disassembleAfter ?? 12;
      try {
        disassembly = await this.disassemble(frame.instructionPointerReference, before + after + 1, -before, 0, true);
      } catch (error) {
        collectionErrors.push({ operation: 'disassembly', message: errorMessage(error) });
      }
    }

    let loadedModules: DebugProtocol.Module[] | undefined;
    if ((options.includeModules ?? false) && this.capabilities?.supportsModulesRequest) {
      try {
        loadedModules = await this.modules(0, options.moduleCount ?? 50);
      } catch (error) {
        collectionErrors.push({ operation: 'modules', message: errorMessage(error) });
      }
    }

    let exception: DebugProtocol.ExceptionInfoResponse['body'] | undefined;
    if ((options.includeExceptionInfo ?? true) && stoppedBody?.reason === 'exception' && this.capabilities?.supportsExceptionInfoRequest) {
      try {
        exception = await this.exceptionInfo(thread.id);
      } catch (error) {
        collectionErrors.push({ operation: 'exceptionInfo', message: errorMessage(error) });
      }
    }

    return {
      ...(stoppedBody === undefined ? {} : { stopped: stoppedBody }),
      thread,
      stack,
      frame,
      scopes: frameScopes,
      locals,
      registers,
      symbolHealth: assessSymbolHealth(stack, loadedModules),
      ...(disassembly === undefined ? {} : { disassembly }),
      ...(loadedModules === undefined ? {} : { modules: loadedModules }),
      ...(exception === undefined ? {} : { exception }),
      ...(collectionErrors.length === 0 ? {} : { collectionErrors }),
    };
  }

  snapshot(): SessionSnapshot {
    return {
      adapterRunning: this.connection.isRunning,
      ...(this.connection.pid === undefined ? {} : { adapterPid: this.connection.pid }),
      initialized: this.initialized,
      configured: this.configured,
      ...(this.activeRequest === undefined ? {} : { activeRequest: this.activeRequest }),
      ...(this.adapterId === undefined ? {} : { adapterId: this.adapterId }),
      ...(this.capabilities === undefined ? {} : { capabilities: this.capabilities }),
      recentEvents: this.connection.recentEvents.slice(-25),
      recentAdapterStderr: this.connection.recentStderr.slice(-25),
    };
  }

  async disconnect(terminateDebuggee = true): Promise<void> {
    if (this.connection.isRunning && this.initialized) {
      try {
        await this.connection.sendRequest('disconnect', { terminateDebuggee } satisfies DebugProtocol.DisconnectArguments, Math.min(this.requestTimeoutMs, 5_000));
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
    this.adapterId = undefined;
    this.capabilities = undefined;
    this.dataBreakpoints = [];
  }

  private async beginDebugRequest(request: 'launch' | 'attach', configuration: Record<string, unknown>, breakpoints: SourceBreakpointGroup[]): Promise<unknown> {
    this.assertInitialized();
    this.configured = false;
    this.activeRequest = request;

    const debugRequestTimeoutMs = Math.max(this.requestTimeoutMs, 60_000);

    // GNU GDB 15+ follows the corrected DAP ordering implemented upstream:
    // initialize -> configuration requests -> configurationDone -> launch.
    // Source breakpoints are intentionally allowed to be pending before GDB
    // knows the executable. CodeLLDB/lldb-dap retain the traditional path
    // below where launch/attach starts first and initialized gates config.
    if (this.adapterId === 'gdb') {
      try {
        const breakpointResults: Array<{ source: string; breakpoints: DebugProtocol.Breakpoint[] }> = [];
        for (const group of breakpoints) {
          breakpointResults.push({ source: group.source, breakpoints: await this.setBreakpoints(group.source, group.lines) });
        }
        if (this.capabilities?.supportsConfigurationDoneRequest) {
          await this.connection.sendRequest('configurationDone', {}, this.requestTimeoutMs);
        }
        const response = await this.connection.sendRequest(request, configuration, debugRequestTimeoutMs);
        this.configured = true;
        return { request, response: response.body ?? {}, breakpoints: breakpointResults, capabilities: this.capabilities ?? {} };
      } catch (error) {
        this.configured = false;
        this.activeRequest = undefined;
        throw error;
      }
    }

    const initializedEvent = this.connection.waitForEvent('initialized', debugRequestTimeoutMs, undefined, true);
    const requestPromise = this.connection.sendRequest(request, configuration, debugRequestTimeoutMs);
    const requestFailure = new Promise<never>((_resolve, reject) => {
      void requestPromise.catch(reject);
    });

    try {
      // DAP launch/attach usually stays pending until configurationDone, but an
      // adapter is allowed to reject it immediately. Surface that actionable
      // request error instead of waiting up to 60s for an initialized event
      // that will never arrive.
      await Promise.race([initializedEvent, requestFailure]);

      const breakpointResults: Array<{ source: string; breakpoints: DebugProtocol.Breakpoint[] }> = [];
      for (const group of breakpoints) {
        breakpointResults.push({ source: group.source, breakpoints: await this.setBreakpoints(group.source, group.lines) });
      }
      if (this.capabilities?.supportsConfigurationDoneRequest) {
        await this.connection.sendRequest('configurationDone', {}, this.requestTimeoutMs);
      }

      const response = await requestPromise;
      this.configured = true;
      return { request, response: response.body ?? {}, breakpoints: breakpointResults, capabilities: this.capabilities ?? {} };
    } catch (error) {
      this.configured = false;
      this.activeRequest = undefined;
      throw error;
    }
  }

  private waitForThreadStop(threadId: number, timeoutMs: number): Promise<DebugProtocol.Event> {
    return this.connection.waitForEvent('stopped', timeoutMs, (event) => {
      const body = event.body as DebugProtocol.StoppedEvent['body'] | undefined;
      return body?.allThreadsStopped === true || body?.threadId === undefined || body.threadId === threadId;
    });
  }

  private assertCapability(capability: keyof DebugProtocol.Capabilities, requestName: string): void {
    if (!this.capabilities?.[capability]) throw new DapError(`The active DAP adapter does not advertise ${String(capability)} required for ${requestName}.`);
  }

  private assertInitialized(): void {
    if (!this.initialized || !this.connection.isRunning) throw new DapError('No initialized DAP session. Call debug_start first.');
  }

  private assertConfigured(): void {
    this.assertInitialized();
    if (!this.configured) throw new DapError('The debuggee has not been launched or attached yet.');
  }
}
