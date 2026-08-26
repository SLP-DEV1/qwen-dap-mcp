import { AsyncLocalStorage } from 'node:async_hooks';
import type { DebugProtocol } from '@vscode/debugprotocol';

import { DapError } from './errors.js';
import {
  createGuardedDapRequestPolicy,
  createHolGuardEvaluator,
  requireHolGuardAdapterStart,
  type HolGuardEvaluator,
} from './hol-guard-policy.js';
import { normalizePostmortemSnapshot } from './postmortem-normalization.js';
import type { DapPolicyMode } from './request-policy.js';
import {
  DapSession,
  type RuntimeSnapshot,
  type RuntimeSnapshotOptions,
  type SourceBreakpointGroup,
  type StartSessionOptions,
} from './session.js';

export type GuardedDapSessionOptions = {
  holGuardEvaluator?: HolGuardEvaluator;
  dapPolicyMode?: DapPolicyMode;
};

/**
 * DapSession with an explicit frozen postmortem mode, serialized lifecycle,
 * and optional HOL Guard enforcement at the two process/code-execution choke
 * points: outgoing mutating DAP requests and adapter process start.
 *
 * CodeLLDB exposes core/minidump inspection through its normal DAP attach
 * surface, so the base session cannot infer that no live process exists.
 * This subclass records that semantic distinction and rejects operations that
 * only make sense for a resumable process.
 *
 * Lifecycle mutations are serialized across independent MCP requests. The
 * AsyncLocalStorage owner makes the gate reentrant so compound operations such
 * as open-dump -> start -> reset -> attach can safely call guarded methods.
 */
export class GuardedDapSession extends DapSession {
  private postmortem = false;
  private readonly lifecycleContext = new AsyncLocalStorage<symbol>();
  private activeLifecycleOperation?: { owner: symbol; name: string };
  private readonly holGuardEvaluator: HolGuardEvaluator;

  constructor(options: GuardedDapSessionOptions = {}) {
    super();
    this.holGuardEvaluator = options.holGuardEvaluator ?? createHolGuardEvaluator();
    this.connection.setRequestPolicy(
      createGuardedDapRequestPolicy(this.holGuardEvaluator, options.dapPolicyMode),
    );
  }

  override async start(options: StartSessionOptions): Promise<DebugProtocol.Capabilities> {
    return this.runExclusiveLifecycle('start', async () => {
      // DapConnection.start() directly spawns the adapter and intentionally sits
      // outside sendRequest(). Gate it here before reset/spawn can create a side
      // effect. Environment values are not forwarded to the policy bridge.
      requireHolGuardAdapterStart(this.holGuardEvaluator, {
        command: options.command,
        ...(options.args ? { args: options.args } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
      this.postmortem = false;
      return super.start(options);
    });
  }

  override async launch(
    configuration: Record<string, unknown>,
    breakpoints: SourceBreakpointGroup[] = [],
  ): Promise<unknown> {
    return this.runExclusiveLifecycle('launch', () => super.launch(configuration, breakpoints));
  }

  override async attach(
    configuration: Record<string, unknown>,
    breakpoints: SourceBreakpointGroup[] = [],
  ): Promise<unknown> {
    return this.runExclusiveLifecycle('attach', () => super.attach(configuration, breakpoints));
  }

  override async disconnect(terminateDebuggee = true): Promise<void> {
    return this.runExclusiveLifecycle('disconnect', async () => {
      await super.disconnect(terminateDebuggee);
      this.postmortem = false;
    });
  }

  override async reset(): Promise<void> {
    return this.runExclusiveLifecycle('reset', async () => {
      await super.reset();
      this.postmortem = false;
    });
  }

  /**
   * Run one lifecycle transaction exclusively.
   *
   * Nested lifecycle calls from the same async transaction are allowed. A
   * competing MCP request receives a deterministic error instead of racing the
   * shared DAP connection and session state.
   */
  async runExclusiveLifecycle<T>(operation: string, action: () => Promise<T>): Promise<T> {
    const currentOwner = this.lifecycleContext.getStore();
    const active = this.activeLifecycleOperation;

    if (active) {
      if (currentOwner === active.owner) {
        return action();
      }
      throw new DapError(
        `Cannot ${operation} while lifecycle operation '${active.name}' is already in progress. Wait for it to finish before changing the shared DAP session.`,
      );
    }

    const owner = Symbol(operation);
    this.activeLifecycleOperation = { owner, name: operation };
    return this.lifecycleContext.run(owner, async () => {
      try {
        return await action();
      } finally {
        if (this.activeLifecycleOperation?.owner === owner) {
          this.activeLifecycleOperation = undefined;
        }
      }
    });
  }

  markPostmortem(): void {
    this.postmortem = true;
  }

  isPostmortem(): boolean {
    return this.postmortem;
  }

  override async runtimeSnapshot(options: RuntimeSnapshotOptions = {}): Promise<RuntimeSnapshot> {
    const snapshot = await super.runtimeSnapshot(options);
    return this.postmortem ? normalizePostmortemSnapshot(snapshot) : snapshot;
  }

  override snapshot() {
    return {
      ...super.snapshot(),
      postmortem: this.postmortem,
      ...(this.activeLifecycleOperation === undefined
        ? {}
        : { lifecycleOperation: this.activeLifecycleOperation.name }),
    };
  }

  override async pause(threadId: number, waitForStop = true, timeoutMs = 15_000): Promise<unknown> {
    this.assertLiveOperation('pause');
    return super.pause(threadId, waitForStop, timeoutMs);
  }

  override async continueExecution(threadId: number, waitForStop = true, timeoutMs = 15_000): Promise<unknown> {
    this.assertLiveOperation('continue');
    return super.continueExecution(threadId, waitForStop, timeoutMs);
  }

  override async step(
    action: 'next' | 'stepIn' | 'stepOut',
    threadId: number,
    waitForStop = true,
    timeoutMs = 15_000,
  ): Promise<unknown> {
    this.assertLiveOperation(action);
    return super.step(action, threadId, waitForStop, timeoutMs);
  }

  override async dataBreakpointInfo(
    name: string,
    variablesReference?: number,
    frameId?: number,
  ): Promise<NonNullable<DebugProtocol.DataBreakpointInfoResponse['body']>> {
    this.assertLiveOperation('dataBreakpointInfo');
    return super.dataBreakpointInfo(name, variablesReference, frameId);
  }

  override async setDataBreakpoints(
    breakpoints: DebugProtocol.DataBreakpoint[],
  ): Promise<DebugProtocol.Breakpoint[]> {
    this.assertLiveOperation('setDataBreakpoints');
    return super.setDataBreakpoints(breakpoints);
  }

  private assertLiveOperation(operation: string): void {
    if (this.postmortem) {
      throw new DapError(
        `Cannot ${operation} in a postmortem crash-dump session. The dump is frozen state; inspect it with debug_snapshot, stack, variables, registers, modules, memory, or disassembly instead.`,
      );
    }
  }
}
