import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { DapSessionRegistry } from '../dap/session-registry.js';
import { structuredResult } from './agent-output.js';
import { SESSION_TEARDOWN_ANNOTATIONS } from './tool-annotations.js';

const sessionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

const sessionEntrySchema = z.object({
  sessionId: z.string(),
  isDefault: z.boolean(),
  snapshot: z.object({}).catchall(z.unknown()),
});

const debugSessionsOutputSchema = z.object({
  action: z.enum(['list', 'create', 'close']),
  defaultSessionId: z.string(),
  maxSessions: z.number().int().positive(),
  sessionId: z.string().optional(),
  removed: z.boolean().optional(),
  sessions: z.array(sessionEntrySchema),
}).catchall(z.unknown());

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

export function registerSessionTools(server: McpServer, registry: DapSessionRegistry): void {
  server.registerTool(
    'debug_sessions',
    {
      title: 'Manage Debug Sessions',
      description:
        'List, create, or close isolated DAP sessions. Existing debug tools accept optional sessionId; omit it to keep using the backward-compatible default session.',
      inputSchema: z.object({
        action: z.enum(['list', 'create', 'close']).default('list'),
        sessionId: sessionIdSchema.optional().describe('Requested ID for create, or target ID for close.'),
        terminateDebuggee: z.boolean().default(true).describe('For close: request debugger termination of the live target before removing the session.'),
      }),
      outputSchema: debugSessionsOutputSchema,
      annotations: SESSION_TEARDOWN_ANNOTATIONS,
    },
    async ({ action, sessionId, terminateDebuggee }) => {
      try {
        let resultSessionId: string | undefined;
        let removed: boolean | undefined;

        if (action === 'create') {
          resultSessionId = registry.create(sessionId).sessionId;
        } else if (action === 'close') {
          if (!sessionId) throw new Error('sessionId is required when action="close".');
          const result = await registry.close(sessionId, terminateDebuggee);
          resultSessionId = result.sessionId;
          removed = result.removed;
        }

        return structuredResult({
          action,
          defaultSessionId: registry.defaultSessionId,
          maxSessions: registry.maxSessions,
          ...(resultSessionId === undefined ? {} : { sessionId: resultSessionId }),
          ...(removed === undefined ? {} : { removed }),
          sessions: registry.list(),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
