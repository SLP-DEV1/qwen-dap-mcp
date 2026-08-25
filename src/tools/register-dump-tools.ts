import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { discoverCodeLldb } from '../adapters/codelldb.js';
import { buildCodeLldbDumpConfiguration } from '../adapters/codelldb-dump.js';
import { GuardedDapSession } from '../dap/guarded-session.js';

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
    wrap(async ({
      dumpPath,
      program,
      sourceMap,
      adapterPath,
      cwd,
      requestTimeoutMs,
      threadId,
      stackLevels,
      maxVariablesPerScope,
      includeDisassembly,
      includeModules,
      moduleCount,
    }) => session.runExclusiveLifecycle('open dump', async () => {
      const adapter = discoverCodeLldb({
        ...(adapterPath ? { explicitPath: adapterPath as string } : {}),
      });
      const capabilities = await session.start({
        command: adapter.command,
        adapterId: 'lldb',
        ...(cwd ? { cwd: cwd as string } : {}),
        requestTimeoutMs: requestTimeoutMs as number,
      });

      const configuration = buildCodeLldbDumpConfiguration({
        dumpPath: dumpPath as string,
        ...(program ? { program: program as string } : {}),
        ...(sourceMap ? { sourceMap: sourceMap as Record<string, string> } : {}),
      });
      const attach = await session.attach(configuration);
      session.markPostmortem();

      const snapshot = await session.runtimeSnapshot({
        ...(threadId === undefined ? {} : { threadId: threadId as number }),
        stackLevels: stackLevels as number,
        maxVariablesPerScope: maxVariablesPerScope as number,
        includeDisassembly: includeDisassembly as boolean,
        includeModules: includeModules as boolean,
        moduleCount: moduleCount as number,
        includeExceptionInfo: true,
      });

      return {
        mode: 'postmortem',
        readOnlyTarget: true,
        dumpPath,
        ...(program ? { program } : {}),
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
    })),
  );
}
