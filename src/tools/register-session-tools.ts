import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { DapSessionRegistry } from '../dap/session-registry.js';
import { debugSessionsOutputSchema, structuredResult } from './agent-output.js';
import { SESSION_TEARDOWN_ANNOTATIONS } from './tool-annotations.js';

const sessionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

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
        'Use this tool to list, create, or close isolated DAP sessions before routing other debugger tools with sessionId. Omit sessionId on normal debug tools only when the backward-compatible default session is intended; do not use a global session selector for concurrent work.',
      inputSchema: z.object({
        action: z.enum(['list', 'create', 'close']).default('list').describe('Management action: list current sessions, create a new isolated session, or close one session.'),
        sessionId: sessionIdSchema.optional().describe('Requested ID for create, or target ID for close. Omit on create to generate a bounded session-N identifier.'),
        terminateDebuggee: z.boolean().default(true).describe('For close only: request debugger termination of the live target before resetting/removing the session.'),
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
