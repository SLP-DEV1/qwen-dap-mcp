import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { discoverCodeLldb } from '../adapters/codelldb.js';
import { buildCodeLldbDumpConfiguration } from '../adapters/codelldb-dump.js';
import { GuardedDapSession } from '../dap/guarded-session.js';
import { logger } from '../logger.js';
import { READ_ONLY_LOCAL_TOOL_ANNOTATIONS } from './tool-annotations.js';

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
        'Open a local native core/minidump with CodeLLDB and capture bounded postmortem evidence. Use this when the failure is already recorded and no target process should execute; use debug_run_to_stop or debug_this_crash mode=codelldb for a live reproduction instead. The tool starts only the local debugger adapter, never launches or resumes the crashed program, treats the dump as read-only, and returns the initial stack/locals/registers plus optional modules and disassembly.',
      annotations: READ_ONLY_LOCAL_TOOL_ANNOTATIONS,
      inputSchema: z.object({
        dumpPath: z.string().min(1).describe('Absolute or local path to the native core/minidump file to inspect.'),
        program: z.string().min(1).optional().describe('Optional path to the matching executable image, used by CodeLLDB to improve symbol/module resolution.'),
        sourceMap: z.record(z.string(), z.string()).optional().describe('Optional mapping from source paths recorded in symbols to local source paths.'),
        adapterPath: z.string().min(1).optional().describe('Optional explicit CodeLLDB executable path; omit to use normal CodeLLDB discovery.'),
        cwd: z.string().optional().describe('Working directory for the local CodeLLDB adapter process; this does not execute the crashed target.'),
        requestTimeoutMs: z.number().int().min(1000).max(120000).default(30000).describe('Per-request DAP timeout in milliseconds while opening and inspecting the dump.'),
        threadId: z.number().int().positive().optional().describe('Specific dump thread to inspect; omit to use the debugger-selected stopped/crashed thread.'),
        stackLevels: z.number().int().positive().max(100).default(20).describe('Maximum stack frames to include in the initial postmortem snapshot.'),
        maxVariablesPerScope: z.number().int().positive().max(500).default(100).describe('Maximum variables returned per scope in the initial snapshot.'),
        includeDisassembly: z.boolean().default(true).describe('Include best-effort instructions around the selected crash frame.'),
        includeModules: z.boolean().default(true).describe('Include loaded executable images and libraries recorded in the dump.'),
        moduleCount: z.number().int().positive().max(500).default(100).describe('Maximum number of modules to include when includeModules is true.'),
      }),
    },
    wrap(async (options) => openDump(session, options as OpenDumpOptions)),
  );
}
