import * as z from 'zod/v4';

import type { DapSessionRegistry } from '../dap/session-registry.js';

const sessionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  .describe('Optional DAP session ID. Omit to use the backward-compatible default session.');

type ToolRegistrar = {
  registerTool: (...args: any[]) => any;
};

function extendInputSchema(config: any): any {
  const inputSchema = config?.inputSchema;
  if (!inputSchema || typeof inputSchema.extend !== 'function') return config;
  return {
    ...config,
    inputSchema: inputSchema.extend({ sessionId: sessionIdSchema.optional() }),
  };
}

/**
 * Add an optional sessionId to existing debug tool schemas and bind each tool
 * invocation to that session for the lifetime of the async handler.
 *
 * debug_sessions itself is excluded because its sessionId field identifies the
 * session being managed rather than the session that should receive a routed
 * debugger operation.
 */
export function routeSessionToolRegistrar<T extends ToolRegistrar>(
  registrar: T,
  registry: DapSessionRegistry,
): T {
  return new Proxy(registrar, {
    get(target, property, receiver) {
      if (property === 'registerTool') {
        return (name: string, ...args: any[]) => {
          if (!name.startsWith('debug_') || name === 'debug_sessions') {
            return target.registerTool.call(target, name, ...args);
          }

          const config = extendInputSchema(args[0]);
          const handler = args[1];
          if (typeof handler !== 'function') {
            return target.registerTool.call(target, name, config, ...args.slice(1));
          }

          const routedHandler = async (rawArgs: unknown, ...handlerRest: unknown[]) => {
            const input = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
              ? rawArgs as Record<string, unknown>
              : {};
            const requestedSessionId = typeof input.sessionId === 'string' ? input.sessionId : undefined;
            const { sessionId: _sessionId, ...handlerArgs } = input;
            return registry.runWithSession(
              requestedSessionId,
              () => handler(handlerArgs, ...handlerRest),
            );
          };

          return target.registerTool.call(target, name, config, routedHandler, ...args.slice(2));
        };
      }

      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
