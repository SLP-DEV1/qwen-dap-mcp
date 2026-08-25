import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import {
  buildCodeLldbAttachConfiguration,
  buildCodeLldbLaunchConfiguration,
  discoverCodeLldb,
} from '../adapters/codelldb.js';
import { DapSession } from '../dap/session.js';

const jsonRecord = z.record(z.string(), z.unknown());
const breakpointGroupSchema = z.object({
  source: z.string().min(1).describe('Absolute or adapter-resolvable source file path'),
  lines: z.array(z.number().int().positive()).min(1),
});

function result(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

function wrap<TArgs extends Record<string, unknown>>(
  handler: (args: TArgs) => Promise<unknown> | unknown,
) {
  return async (args: TArgs) => {
    try {
      return result(await handler(args));
    } catch (error) {
      return errorResult(error);
    }
  };
}

export function registerDebugTools(server: McpServer, session: DapSession): void {
  server.registerTool(
    'debug_codelldb_info',
    {
      title: 'Locate CodeLLDB',
      description:
        'Locate a CodeLLDB >= 1.11.0 adapter from an explicit path, CODELLDB_PATH, common VS Code-compatible extension directories, or PATH.',
      inputSchema: z.object({
        adapterPath: z.string().min(1).optional(),
      }),
    },
    wrap(async ({ adapterPath }) =>
      discoverCodeLldb({ ...(adapterPath ? { explicitPath: adapterPath as string } : {}) }),
    ),
  );

  server.registerTool(
    'debug_start_codelldb',
    {
      title: 'Start CodeLLDB',
      description:
        'Auto-discover and initialize CodeLLDB using DAP over stdio. CodeLLDB 1.11.0 or newer is required.',
      inputSchema: z.object({
        adapterPath: z.string().min(1).optional(),
        cwd: z.string().optional(),
        requestTimeoutMs: z.number().int().min(1000).max(120000).optional(),
      }),
    },
    wrap(async ({ adapterPath, cwd, requestTimeoutMs }) => {
      const adapter = discoverCodeLldb({
        ...(adapterPath ? { explicitPath: adapterPath as string } : {}),
      });
      const capabilities = await session.start({
        command: adapter.command,
        adapterId: 'lldb',
        ...(cwd ? { cwd: cwd as string } : {}),
        ...(requestTimeoutMs ? { requestTimeoutMs: requestTimeoutMs as number } : {}),
      });
      return { adapter, capabilities, status: session.snapshot() };
    }),
  );

  server.registerTool(
    'debug_launch_codelldb',
    {
      title: 'Launch with CodeLLDB',
      description:
        'Launch a native program through an initialized CodeLLDB session. Uses terminal=console so no runInTerminal reverse request is required.',
      inputSchema: z.object({
        program: z.string().min(1),
        args: z.array(z.string()).optional(),
        cwd: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
        stopOnEntry: z.boolean().default(false),
        breakpoints: z.array(breakpointGroupSchema).optional(),
      }),
    },
    wrap(async ({ program, args, cwd, env, stopOnEntry, breakpoints }) =>
      session.launch(
        buildCodeLldbLaunchConfiguration({
          program: program as string,
          ...(args ? { args: args as string[] } : {}),
          ...(cwd ? { cwd: cwd as string } : {}),
          ...(env ? { env: env as Record<string, string> } : {}),
          stopOnEntry: stopOnEntry as boolean,
        }),
        (breakpoints ?? []) as Array<{ source: string; lines: number[] }>,
      ),
    ),
  );

  server.registerTool(
    'debug_attach_codelldb',
    {
      title: 'Attach with CodeLLDB',
      description: 'Attach an initialized CodeLLDB session to an authorized local native process by PID.',
      inputSchema: z.object({
        pid: z.number().int().positive(),
        program: z.string().min(1).optional(),
        stopOnEntry: z.boolean().default(true),
        breakpoints: z.array(breakpointGroupSchema).optional(),
      }),
    },
    wrap(async ({ pid, program, stopOnEntry, breakpoints }) =>
      session.attach(
        buildCodeLldbAttachConfiguration({
          pid: pid as number,
          ...(program ? { program: program as string } : {}),
          stopOnEntry: stopOnEntry as boolean,
        }),
        (breakpoints ?? []) as Array<{ source: string; lines: number[] }>,
      ),
    ),
  );

  server.registerTool(
    'debug_start',
    {
      title: 'Start DAP Adapter',
      description:
        'Start a local Debug Adapter Protocol process and initialize a debug session. The adapter is spawned directly without a shell.',
      inputSchema: z.object({
        adapterCommand: z.string().min(1).describe('Executable path or command for the DAP adapter'),
        adapterArgs: z.array(z.string()).optional(),
        adapterId: z.string().min(1).describe('DAP adapter identifier, e.g. cppdbg, lldb, python'),
        cwd: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
        requestTimeoutMs: z.number().int().min(1000).max(120000).optional(),
      }),
    },
    wrap(async ({ adapterCommand, adapterArgs, adapterId, cwd, env, requestTimeoutMs }) => {
      const capabilities = await session.start({
        command: adapterCommand as string,
        adapterId: adapterId as string,
        ...(adapterArgs ? { args: adapterArgs as string[] } : {}),
        ...(cwd ? { cwd: cwd as string } : {}),
        ...(env ? { env: env as Record<string, string> } : {}),
        ...(requestTimeoutMs ? { requestTimeoutMs: requestTimeoutMs as number } : {}),
      });
      return { capabilities, status: session.snapshot() };
    }),
  );

  server.registerTool(
    'debug_launch',
    {
      title: 'Launch Debuggee',
      description:
        'Send a DAP launch request, wait for initialization, configure optional source breakpoints, and complete DAP configuration.',
      inputSchema: z.object({
        configuration: jsonRecord.describe('Adapter-specific DAP launch arguments'),
        breakpoints: z.array(breakpointGroupSchema).optional(),
      }),
    },
    wrap(async ({ configuration, breakpoints }) =>
      session.launch(
        configuration as Record<string, unknown>,
        (breakpoints ?? []) as Array<{ source: string; lines: number[] }>,
      ),
    ),
  );

  server.registerTool(
    'debug_attach',
    {
      title: 'Attach Debugger',
      description:
        'Send a DAP attach request to an authorized local target, configure optional source breakpoints, and complete DAP configuration.',
      inputSchema: z.object({
        configuration: jsonRecord.describe('Adapter-specific DAP attach arguments'),
        breakpoints: z.array(breakpointGroupSchema).optional(),
      }),
    },
    wrap(async ({ configuration, breakpoints }) =>
      session.attach(
        configuration as Record<string, unknown>,
        (breakpoints ?? []) as Array<{ source: string; lines: number[] }>,
      ),
    ),
  );

  server.registerTool(
    'debug_set_breakpoints',
    {
      title: 'Set Source Breakpoints',
      description: 'Replace source breakpoints for one file in the active DAP session.',
      inputSchema: breakpointGroupSchema,
    },
    wrap(async ({ source, lines }) => ({
      source,
      breakpoints: await session.setBreakpoints(source as string, lines as number[]),
    })),
  );

  server.registerTool(
    'debug_continue',
    {
      title: 'Continue Execution',
      description: 'Continue a paused thread and optionally wait for the next stopped event.',
      inputSchema: z.object({
        threadId: z.number().int().positive(),
        waitForStop: z.boolean().default(true),
        timeoutMs: z.number().int().min(1000).max(120000).default(15000),
      }),
    },
    wrap(async ({ threadId, waitForStop, timeoutMs }) =>
      session.continueExecution(threadId as number, waitForStop as boolean, timeoutMs as number),
    ),
  );

  server.registerTool(
    'debug_step',
    {
      title: 'Step Execution',
      description: 'Step over, into, or out of the current frame and optionally wait for the next stopped event.',
      inputSchema: z.object({
        action: z.enum(['next', 'stepIn', 'stepOut']),
        threadId: z.number().int().positive(),
        waitForStop: z.boolean().default(true),
        timeoutMs: z.number().int().min(1000).max(120000).default(15000),
      }),
    },
    wrap(async ({ action, threadId, waitForStop, timeoutMs }) =>
      session.step(
        action as 'next' | 'stepIn' | 'stepOut',
        threadId as number,
        waitForStop as boolean,
        timeoutMs as number,
      ),
    ),
  );

  server.registerTool(
    'debug_threads',
    {
      title: 'List Threads',
      description: 'List threads in the current debuggee.',
    },
    async () => {
      try {
        return result(await session.threads());
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'debug_stack',
    {
      title: 'Read Stack Trace',
      description: 'Read stack frames for a thread.',
      inputSchema: z.object({
        threadId: z.number().int().positive(),
        startFrame: z.number().int().nonnegative().default(0),
        levels: z.number().int().positive().max(200).default(20),
      }),
    },
    wrap(async ({ threadId, startFrame, levels }) =>
      session.stackTrace(threadId as number, startFrame as number, levels as number),
    ),
  );

  server.registerTool(
    'debug_scopes',
    {
      title: 'Read Frame Scopes',
      description: 'Read scopes such as Locals, Arguments, or Registers for a stack frame.',
      inputSchema: z.object({ frameId: z.number().int() }),
    },
    wrap(async ({ frameId }) => session.scopes(frameId as number)),
  );

  server.registerTool(
    'debug_variables',
    {
      title: 'Read Variables',
      description: 'Expand a DAP variablesReference returned by a scope, variable, or evaluation result.',
      inputSchema: z.object({
        variablesReference: z.number().int().nonnegative(),
        start: z.number().int().nonnegative().optional(),
        count: z.number().int().positive().max(1000).optional(),
      }),
    },
    wrap(async ({ variablesReference, start, count }) =>
      session.variables(
        variablesReference as number,
        start as number | undefined,
        count as number | undefined,
      ),
    ),
  );

  server.registerTool(
    'debug_evaluate',
    {
      title: 'Evaluate Debugger Expression',
      description:
        'Evaluate an expression in the debugger. Depending on the adapter/language, expressions may have side effects; use only with authorized targets.',
      inputSchema: z.object({
        expression: z.string().min(1),
        frameId: z.number().int().optional(),
        context: z.enum(['watch', 'repl', 'hover', 'clipboard', 'variables']).default('watch'),
      }),
    },
    wrap(async ({ expression, frameId, context }) =>
      session.evaluate(
        expression as string,
        frameId as number | undefined,
        context as 'watch' | 'repl' | 'hover' | 'clipboard' | 'variables',
      ),
    ),
  );

  server.registerTool(
    'debug_status',
    {
      title: 'Debug Session Status',
      description: 'Return current adapter/session state plus recent DAP events and adapter stderr.',
    },
    async () => result(session.snapshot()),
  );

  server.registerTool(
    'debug_events',
    {
      title: 'Recent DAP Events',
      description: 'Return recent asynchronous DAP events such as stopped, output, thread, and terminated.',
      inputSchema: z.object({ limit: z.number().int().positive().max(200).default(25) }),
    },
    wrap(async ({ limit }) => session.connection.recentEvents.slice(-(limit as number))),
  );

  server.registerTool(
    'debug_disconnect',
    {
      title: 'Disconnect Debugger',
      description: 'Disconnect the active DAP session and stop the adapter process.',
      inputSchema: z.object({ terminateDebuggee: z.boolean().default(true) }),
    },
    wrap(async ({ terminateDebuggee }) => {
      await session.disconnect(terminateDebuggee as boolean);
      return { disconnected: true };
    }),
  );
}
