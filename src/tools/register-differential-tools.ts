import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { compareRuntimeSnapshots } from '../diagnostics/runtime-diff.js';
import { DapError } from '../dap/errors.js';
import { runWithDapOperationContext } from '../dap/operation-context.js';
import type { DapSessionRegistry } from '../dap/session-registry.js';
import type { RuntimeSnapshotOptions } from '../dap/session.js';
import { debugCompareRunsOutputSchema, structuredResult } from './agent-output.js';
import { READ_ONLY_LOCAL_TOOL_ANNOTATIONS } from './tool-annotations.js';

const sessionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  .describe('Existing DAP session ID created with debug_sessions.');

const defaultSnapshotOptions = {
  stackLevels: 20,
  maxVariablesPerScope: 100,
  includeDisassembly: false,
  disassembleBefore: 8,
  disassembleAfter: 12,
  includeModules: true,
  moduleCount: 100,
  includeExceptionInfo: true,
} as const;

const snapshotSchema = z.object({
  threadId: z.number().int().positive().optional().describe('Stopped DAP thread to inspect; omit to use each session-selected stopped thread.'),
  stackLevels: z.number().int().positive().max(100).default(defaultSnapshotOptions.stackLevels).describe('Maximum stack frames captured from each session.'),
  maxVariablesPerScope: z.number().int().positive().max(500).default(defaultSnapshotOptions.maxVariablesPerScope).describe('Maximum variables captured per relevant scope in each session.'),
  includeDisassembly: z.boolean().default(defaultSnapshotOptions.includeDisassembly).describe('Include bounded disassembly in the raw snapshots. The semantic v0.17 diff does not compare raw instruction addresses.'),
  disassembleBefore: z.number().int().nonnegative().max(100).default(defaultSnapshotOptions.disassembleBefore),
  disassembleAfter: z.number().int().nonnegative().max(100).default(defaultSnapshotOptions.disassembleAfter),
  includeModules: z.boolean().default(defaultSnapshotOptions.includeModules).describe('Collect loaded modules so added/removed images can be compared.'),
  moduleCount: z.number().int().positive().max(500).default(defaultSnapshotOptions.moduleCount),
  includeExceptionInfo: z.boolean().default(defaultSnapshotOptions.includeExceptionInfo).describe('Collect exception information from both stopped sessions when supported.'),
}).describe('Bounded evidence capture settings applied independently to both sessions.');

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

async function captureSessionSnapshot(
  sessions: DapSessionRegistry,
  sessionId: string,
  options: RuntimeSnapshotOptions,
) {
  return sessions.runWithSession(sessionId, async () => {
    const session = sessions.get();
    const snapshot = await session.runtimeSnapshot(options);
    return {
      sessionId,
      snapshot,
      status: session.snapshot(),
    };
  });
}

export function registerDifferentialTools(server: McpServer, sessions: DapSessionRegistry): void {
  server.registerTool(
    'debug_compare_runs',
    {
      description:
        'Compare bounded runtime evidence from two existing stopped DAP sessions. Use this for baseline or known-good versus candidate or failing differential debugging after both sessions have reached comparable stops. It compares stack identities, locals, registers, exception state, symbol health, and modules semantically; non-null raw address-only changes are marked unstable rather than causal evidence. Do not use it to launch, resume, or alter either target; prepare both runtime states with the normal lifecycle tools first.',
      inputSchema: z.object({
        baselineSessionId: sessionIdSchema.describe('Session representing the known-good or baseline runtime state.'),
        candidateSessionId: sessionIdSchema.describe('Session representing the failing or changed runtime state.'),
        timeoutMs: z.number().int().min(250).max(120_000).default(30_000).describe('Aggregate deadline for collecting both snapshots. Cancellation propagates to pending DAP requests/event waits in this operation context.'),
        snapshot: snapshotSchema.default(defaultSnapshotOptions),
      }).superRefine((value, context) => {
        if (value.baselineSessionId === value.candidateSessionId) {
          context.addIssue({
            code: 'custom',
            path: ['candidateSessionId'],
            message: 'baselineSessionId and candidateSessionId must identify two different sessions.',
          });
        }
      }),
      outputSchema: debugCompareRunsOutputSchema,
      annotations: READ_ONLY_LOCAL_TOOL_ANNOTATIONS,
    },
    async ({ baselineSessionId, candidateSessionId, timeoutMs, snapshot }) => {
      try {
        if (!sessions.has(baselineSessionId)) {
          throw new DapError(`Unknown baseline DAP session '${baselineSessionId}'. Create it with debug_sessions first.`);
        }
        if (!sessions.has(candidateSessionId)) {
          throw new DapError(`Unknown candidate DAP session '${candidateSessionId}'. Create it with debug_sessions first.`);
        }

        const options: RuntimeSnapshotOptions = {
          ...snapshot,
          includeDisassembly: snapshot.includeDisassembly ?? false,
          includeModules: snapshot.includeModules ?? true,
          includeExceptionInfo: snapshot.includeExceptionInfo ?? true,
        };

        return await runWithDapOperationContext(
          { label: `compare-runs:${baselineSessionId}:${candidateSessionId}`, timeoutMs },
          async (operation) => {
            const [baseline, candidate] = await Promise.all([
              captureSessionSnapshot(sessions, baselineSessionId, options),
              captureSessionSnapshot(sessions, candidateSessionId, options),
            ]);
            operation.throwIfAborted();

            return structuredResult({
              baselineSessionId,
              candidateSessionId,
              evidenceBudget: {
                timeoutMs,
                sessions: 2,
                stackLevels: snapshot.stackLevels,
                maxVariablesPerScope: snapshot.maxVariablesPerScope,
                includeDisassembly: snapshot.includeDisassembly,
                disassemblyInstructionsPerSession: snapshot.includeDisassembly
                  ? snapshot.disassembleBefore + snapshot.disassembleAfter + 1
                  : 0,
                includeModules: snapshot.includeModules,
                moduleCountPerSession: snapshot.includeModules ? snapshot.moduleCount : 0,
                includeExceptionInfo: snapshot.includeExceptionInfo,
              },
              baseline,
              candidate,
              diff: compareRuntimeSnapshots(baseline.snapshot, candidate.snapshot),
              guidance: [
                'Treat firstMeaningfulDifference as a prioritization hint, not proof that the value caused the failure.',
                'Prefer changed/added/removed semantic values over unstable raw-address differences.',
                'If the suspicious value needs temporal evidence, follow up with writer/value tracing rather than inferring causality from this static comparison alone.',
              ],
            });
          },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
