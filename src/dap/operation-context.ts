import { AsyncLocalStorage } from 'node:async_hooks';

import { DapError } from './errors.js';

export type DapOperationContextOptions = {
  label?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const DEADLINE_ABORT_SKEW_MS = 5;
let nextOperationId = 0;
const operationStorage = new AsyncLocalStorage<DapOperationContext>();

function abortReason(signal: AbortSignal): string {
  const reason = signal.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason;
  return 'operation cancelled';
}

export class DapOperationContext {
  readonly id: number;
  readonly label: string;
  readonly signal: AbortSignal;
  readonly deadlineAt?: number;

  private readonly controller = new AbortController();
  private readonly timeout?: NodeJS.Timeout;
  private readonly detachParent?: () => void;

  constructor(options: DapOperationContextOptions = {}, parent?: DapOperationContext) {
    this.id = ++nextOperationId;
    this.label = options.label?.trim() || `operation-${this.id}`;

    const now = Date.now();
    const explicitDeadline = options.timeoutMs === undefined
      ? undefined
      : now + Math.max(1, options.timeoutMs);
    const parentDeadline = parent?.deadlineAt;
    this.deadlineAt = explicitDeadline === undefined
      ? parentDeadline
      : parentDeadline === undefined
        ? explicitDeadline
        : Math.min(explicitDeadline, parentDeadline);

    this.signal = this.controller.signal;

    const inheritedSignal = options.signal ?? parent?.signal;
    if (inheritedSignal) {
      const onAbort = () => this.abort(abortReason(inheritedSignal));
      inheritedSignal.addEventListener('abort', onAbort, { once: true });
      this.detachParent = () => inheritedSignal.removeEventListener('abort', onAbort);
      if (inheritedSignal.aborted) onAbort();
    }

    if (this.deadlineAt !== undefined && !this.signal.aborted) {
      // Fire the aggregate operation abort just before child request/event timers
      // derived from the same deadline. This keeps one authoritative cancellation
      // reason while remaining conservatively inside the requested deadline.
      const delay = Math.max(1, this.deadlineAt - Date.now() - DEADLINE_ABORT_SKEW_MS);
      this.timeout = setTimeout(() => {
        this.abort(`deadline exceeded for ${this.label}`);
      }, delay);
    }
  }

  remainingMs(requestedMs: number): number {
    const boundedRequested = Math.max(1, requestedMs);
    if (this.deadlineAt === undefined) return boundedRequested;
    return Math.max(1, Math.min(boundedRequested, this.deadlineAt - Date.now()));
  }

  throwIfAborted(): void {
    if (!this.signal.aborted) return;
    throw new DapError(`DAP ${this.label} cancelled: ${abortReason(this.signal)}`);
  }

  abort(reason = 'operation cancelled'): void {
    if (this.signal.aborted) return;
    this.controller.abort(new DapError(reason));
  }

  dispose(): void {
    if (this.timeout) clearTimeout(this.timeout);
    this.detachParent?.();
  }
}

export function currentDapOperationContext(): DapOperationContext | undefined {
  return operationStorage.getStore();
}

export async function runWithDapOperationContext<T>(
  options: DapOperationContextOptions,
  action: (context: DapOperationContext) => Promise<T> | T,
): Promise<T> {
  const context = new DapOperationContext(options, currentDapOperationContext());
  try {
    context.throwIfAborted();
    return await operationStorage.run(context, () => action(context));
  } finally {
    context.dispose();
  }
}
