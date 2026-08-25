import type { DebugProtocol } from '@vscode/debugprotocol';

import { DapError } from './errors.js';
import { DapSession, type StartSessionOptions } from './session.js';

/**
 * DapSession with an explicit frozen postmortem mode.
 *
 * CodeLLDB exposes core/minidump inspection through its normal DAP attach
 * surface, so the base session cannot infer that no live process exists.
 * This subclass records that semantic distinction and rejects operations that
 * only make sense for a resumable process.
 */
export class GuardedDapSession extends DapSession {
  private postmortem = false;

  override async start(options: StartSessionOptions): Promise<DebugProtocol.Capabilities> {
    this.postmortem = false;
    return super.start(options);
  }

  markPostmortem(): void {
    this.postmortem = true;
  }

  isPostmortem(): boolean {
    return this.postmortem;
  }

  override snapshot() {
    return {
      ...super.snapshot(),
      postmortem: this.postmortem,
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
