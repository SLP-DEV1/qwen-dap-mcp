import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { discoverCodeLldb } from '../adapters/codelldb.js';
import { buildCodeLldbDumpConfiguration } from '../adapters/codelldb-dump.js';
import { GuardedDapSession } from '../dap/guarded-session.js';
import { logger } from '../logger.js';

export type OpenDumpOptions = {
  dumpPath: string;
  program?: string;
  sourceMap?: Record<string, string>;
  adapterPath?: string;
  cwd?: string;
  requestTimeoutMs?: number;
  threadId?: number;
  stackLevels?: number;
  maxVariablesPerScope?: number;
  includeDisassembly?: boolean;
  includeModules?: boolean;
  moduleCount?: number;
};

export async function openDump(session: GuardedDapSession, options: OpenDumpOptions) {
  return session.runExclusiveLifecycle('open dump', async () => {
    // Validate the local dump/program paths before spawning an adapter. A bad
    // user path should never leave an otherwise idle CodeLLDB process behind.
    const configuration = buildCodeLldbDumpConfiguration({
      dumpPath: options.dumpPath,
      ...(options.program ? { program: options.program } : {}),
      ...(options.sourceMap ? { sourceMap: options.sourceMap } : {}),
    });
    const adapter = discoverCodeLldb({
      ...(options.adapterPath ? { explicitPath: options.adapterPath } : {}),
    });

    let adapterStarted = false;
    try {
      const capabilities = await session.start({
        command: adapter.command,
        adapterId: 'lldb',
        ...(options.cwd ? { cwd: options.cwd } : {}),
        requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      });
      adapterStarted = true;

      const attach = await session.attach(configuration);
      session.markPostmortem();

      const snapshot = await session.runtimeSnapshot({
        ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
        stackLevels: options.stackLevels ?? 20,
        maxVariablesPerScope: options.maxVariablesPerScope ?? 100,
        includeDisassembly: options.includeDisassembly ?? true,
        includeModules: options.includeModules ?? true,
        moduleCount: options.moduleCount ?? 100,
        includeExceptionInfo: true,
      });

      return {
        mode: 'postmortem' as const,
        readOnlyTarget: true,
        dumpPath: options.dumpPath,
        ...(options.program ? { program: options.program } : {}),
        adapter,
        capabilities,
        attach,
        snapshot,
        guidance: {
          canInspect: ['threads', 'stack', 'scopes', 'variables', 'registers', 'modules', 'memory', 'disassembly'],
          blockedOperations: ['continue', 'step', 'pause', 'data breakpoints'],
          cannotResume: true,
          note: 'A crash dump is frozen state. Live execution-control operations are rejected by the session guard.',
        },
      };
    } catch (error) {
      if (adapterStarted) {
        try {
          await session.reset();
        } catch (cleanupError) {
          logger.warn('Failed to clean up CodeLLDB after crash-dump setup failure', {
            cleanupError: cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
          });
        }
      }
      throw error;
    }
  });
}

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function wrap<TArgs extends Record<string, unknown>>(handler: (args: TArgs) => Promise<unknown> | unknown) {
  return async (args: TArgs) => {
    try {
      return result(await handler(args));
    } catch (error) {
      return errorResult(error);
    }
  };
}

export function registerDumpTools(server: McpServer, session: GuardedDapSession): void {
  server.registerTool(
    'debug_open_dump',
    {
      title: 'Open Native Crash Dump',
      description:
        'Open a local native core/minidump with CodeLLDB for read-only postmortem analysis. No target process is launched or attached. Returns an initial bounded debug snapshot.',
      inputSchema: z.object({
        dumpPath: z.string().min(1),
        program: z.string().min(1).optional(),
        sourceMap: z.record(z.string(), z.string()).optional(),
        adapterPath: z.string().min(1).optional(),
        cwd: z.string().optional(),
        requestTimeoutMs: z.number().int().min(1000).max(120000).default(30000),
        threadId: z.number().int().positive().optional(),
        stackLevels: z.number().int().positive().max(100).default(20),
        maxVariablesPerScope: z.number().int().positive().max(500).default(100),
        includeDisassembly: z.boolean().default(true),
        includeModules: z.boolean().default(true),
        moduleCount: z.number().int().positive().max(500).default(100),
      }),
    },
    wrap(async (options) => openDump(session, options as OpenDumpOptions)),
  );
}
