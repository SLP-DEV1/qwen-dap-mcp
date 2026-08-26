import { AsyncLocalStorage } from 'node:async_hooks';

import { DapError } from './errors.js';
import { GuardedDapSession } from './guarded-session.js';

export const DEFAULT_DAP_SESSION_ID = 'default';
export const DEFAULT_MAX_DAP_SESSIONS = 8;

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type DapSessionRegistryEntry = {
  sessionId: string;
  isDefault: boolean;
  activeRequests: number;
  snapshot: ReturnType<GuardedDapSession['snapshot']>;
};

export type DapSessionRegistryOptions = {
  defaultSessionId?: string;
  maxSessions?: number;
  sessionFactory?: () => GuardedDapSession;
};

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Owns independent guarded DAP sessions and binds one session ID to the
 * lifetime of a single async MCP request.
 *
 * The AsyncLocalStorage context is deliberately request-local: there is no
 * process-global "selected session" that concurrent MCP calls can race.
 * Existing callers that omit sessionId continue to use the default session.
 */
export class DapSessionRegistry {
  readonly defaultSessionId: string;
  readonly maxSessions: number;

  private readonly sessions = new Map<string, GuardedDapSession>();
  private readonly activeRequestCounts = new Map<string, number>();
  private readonly sessionContext = new AsyncLocalStorage<string>();
  private readonly sessionFactory: () => GuardedDapSession;
  private generatedSessionCounter = 0;

  constructor(options: DapSessionRegistryOptions = {}) {
    this.defaultSessionId = options.defaultSessionId ?? DEFAULT_DAP_SESSION_ID;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_DAP_SESSIONS;
    this.sessionFactory = options.sessionFactory ?? (() => new GuardedDapSession());

    this.assertSessionId(this.defaultSessionId);
    if (!Number.isSafeInteger(this.maxSessions) || this.maxSessions < 1 || this.maxSessions > 64) {
      throw new DapError(`maxSessions must be an integer between 1 and 64; received ${String(this.maxSessions)}`);
    }

    this.sessions.set(this.defaultSessionId, this.sessionFactory());
  }

  create(requestedSessionId?: string): { sessionId: string; session: GuardedDapSession } {
    if (this.sessions.size >= this.maxSessions) {
      throw new DapError(
        `Cannot create another DAP session: the configured limit of ${this.maxSessions} sessions has been reached. Close an unused session first.`,
      );
    }

    const sessionId = requestedSessionId ?? this.nextGeneratedSessionId();
    this.assertSessionId(sessionId);
    if (this.sessions.has(sessionId)) {
      throw new DapError(`DAP session '${sessionId}' already exists.`);
    }

    const session = this.sessionFactory();
    this.sessions.set(sessionId, session);
    return { sessionId, session };
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get(sessionId?: string): GuardedDapSession {
    const resolvedId = sessionId ?? this.sessionContext.getStore() ?? this.defaultSessionId;
    const session = this.sessions.get(resolvedId);
    if (!session) {
      const available = [...this.sessions.keys()].join(', ');
      throw new DapError(
        `Unknown DAP session '${resolvedId}'. Available sessions: ${available || '(none)'}. Create it with debug_sessions first.`,
      );
    }
    return session;
  }

  currentSessionId(): string {
    return this.sessionContext.getStore() ?? this.defaultSessionId;
  }

  activeRequests(sessionId: string): number {
    this.get(sessionId);
    return this.activeRequestCounts.get(sessionId) ?? 0;
  }

  runWithSession<T>(sessionId: string | undefined, action: () => T): T {
    const resolvedId = sessionId ?? this.defaultSessionId;
    this.get(resolvedId);
    this.incrementActiveRequests(resolvedId);

    let result: T;
    try {
      result = this.sessionContext.run(resolvedId, action);
    } catch (error) {
      this.decrementActiveRequests(resolvedId);
      throw error;
    }

    if (isPromiseLike(result)) {
      return Promise.resolve(result).finally(() => {
        this.decrementActiveRequests(resolvedId);
      }) as T;
    }

    this.decrementActiveRequests(resolvedId);
    return result;
  }

  list(): DapSessionRegistryEntry[] {
    return [...this.sessions.entries()].map(([sessionId, session]) => ({
      sessionId,
      isDefault: sessionId === this.defaultSessionId,
      activeRequests: this.activeRequestCounts.get(sessionId) ?? 0,
      snapshot: session.snapshot(),
    }));
  }

  async close(sessionId: string, terminateDebuggee = true): Promise<{ sessionId: string; removed: boolean }> {
    const session = this.get(sessionId);
    const activeRequests = this.activeRequestCounts.get(sessionId) ?? 0;
    if (activeRequests > 0) {
      throw new DapError(
        `Cannot close DAP session '${sessionId}' while ${activeRequests} routed debug request${activeRequests === 1 ? ' is' : 's are'} still active. Wait for the request to finish first.`,
      );
    }

    await session.disconnect(terminateDebuggee);

    if (sessionId === this.defaultSessionId) {
      return { sessionId, removed: false };
    }

    this.sessions.delete(sessionId);
    this.activeRequestCounts.delete(sessionId);
    return { sessionId, removed: true };
  }

  /**
   * Best-effort server-shutdown cleanup. This intentionally bypasses the
   * user-facing busy-session close guard because shutdown must not leave
   * adapter processes owned by this MCP server behind. By default the bridge
   * detaches/stops adapters without asking debuggers to terminate debuggees.
   */
  async closeAll(terminateDebuggees = false): Promise<void> {
    const entries = [...this.sessions.entries()];
    await Promise.allSettled(
      entries.map(async ([sessionId, session]) => {
        await session.disconnect(terminateDebuggees);
        if (sessionId !== this.defaultSessionId) {
          this.sessions.delete(sessionId);
          this.activeRequestCounts.delete(sessionId);
        }
      }),
    );
  }

  /**
   * Return a stable object that dynamically delegates every property/method to
   * the session bound to the current async request. Methods are bound to the
   * real GuardedDapSession instance so private fields and lifecycle guards keep
   * their normal semantics.
   */
  createRoutedSession(): GuardedDapSession {
    const stableTarget = this.get(this.defaultSessionId);
    return new Proxy(stableTarget, {
      get: (_target, property) => {
        const session = this.get();
        const value = Reflect.get(session, property, session) as unknown;
        return typeof value === 'function' ? value.bind(session) : value;
      },
      set: (_target, property, value) => {
        const session = this.get();
        return Reflect.set(session, property, value, session);
      },
    });
  }

  private incrementActiveRequests(sessionId: string): void {
    this.activeRequestCounts.set(sessionId, (this.activeRequestCounts.get(sessionId) ?? 0) + 1);
  }

  private decrementActiveRequests(sessionId: string): void {
    const current = this.activeRequestCounts.get(sessionId) ?? 0;
    if (current <= 1) {
      this.activeRequestCounts.delete(sessionId);
      return;
    }
    this.activeRequestCounts.set(sessionId, current - 1);
  }

  private nextGeneratedSessionId(): string {
    do {
      this.generatedSessionCounter += 1;
    } while (this.sessions.has(`session-${this.generatedSessionCounter}`));
    return `session-${this.generatedSessionCounter}`;
  }

  private assertSessionId(sessionId: string): void {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new DapError(
        `Invalid DAP session ID '${sessionId}'. Use 1-64 characters: letters, digits, dot, underscore, or hyphen; the first character must be alphanumeric.`,
      );
    }
  }
}
