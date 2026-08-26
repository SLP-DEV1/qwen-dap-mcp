import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import {
  buildCodeLldbAttachConfiguration,
  buildCodeLldbLaunchConfiguration,
  discoverCodeLldb,
} from '../adapters/codelldb.js';
import { DapError } from '../dap/errors.js';
import { DapSession } from '../dap/session.js';
import {
  DEBUG_SESSION_CONTROL_ANNOTATIONS,
  READ_ONLY_LOCAL_TOOL_ANNOTATIONS,
  SESSION_TEARDOWN_ANNOTATIONS,
} from './tool-annotations.js';
import { debugContinueOutputSchema, debugDisconnectOutputSchema, debugSnapshotOutputSchema, debugStatusOutputSchema, structuredResult } from './agent-output.js';

const jsonRecord = z.record(z.string(), z.unknown());
const breakpointGroupSchema = z.object({
  source: z.string().min(1).describe('Absolute or adapter-resolvable source file path'),
  lines: z.array(z.number().int().positive()).min(1),
});
const sourceBreakpointSchema = z.object({
  line: z.number().int().positive(),
  column: z.number().int().positive().optional(),
  condition: z.string().min(1).optional(),
  hitCondition: z.string().min(1).optional(),
  logMessage: z.string().min(1).optional(),
});
const functionBreakpointSchema = z.object({
  name: z.string().min(1),
  condition: z.string().min(1).optional(),
  hitCondition: z.string().min(1).optional(),
});
const instructionBreakpointSchema = z.object({
  instructionReference: z.string().min(1),
  offset: z.number().int().optional(),
  condition: z.string().min(1).optional(),
  hitCondition: z.string().min(1).optional(),
});
const dataBreakpointSchema = z.object({
  dataId: z.string().min(1),
  accessType: z.enum(['read', 'write', 'readWrite']).optional(),
  condition: z.string().min(1).optional(),
  hitCondition: z.string().min(1).optional(),
});
const exceptionFilterOptionSchema = z.object({
  filterId: z.string().min(1),
  condition: z.string().optional(),
});

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

function wrapStructured<TArgs extends Record<string, unknown>>(handler: (args: TArgs) => Promise<unknown> | unknown) {
  return async (args: TArgs) => {
    try {
      return structuredResult(await handler(args));
    } catch (error) {
      return errorResult(error);
    }
  };
}

function decodeBase64Strict(data: string): Buffer {
  const compact = data.replace(/\s+/g, '');
  if (compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new DapError('DAP readMemory returned malformed base64 data');
  }
  return Buffer.from(compact, 'base64');
}

export function formatMemoryResult(
  memory: Record<string, unknown> & { data?: string },
  requestedCount: number,
): Record<string, unknown> {
  if (!memory.data) return memory;
  const bytes = decodeBase64Strict(memory.data);
  if (bytes.length > requestedCount) {
    throw new DapError(
      `DAP readMemory returned ${bytes.length} bytes, exceeding the requested ${requestedCount}-byte bound`,
    );
  }
  const hex = bytes.toString('hex').match(/.{1,2}/g)?.join(' ');
  return { ...memory, ...(hex ? { hex } : {}) };
}

export function registerDebugTools(server: McpServer, session: DapSession): void {
  server.registerTool(
    'debug_codelldb_info',
    {
      title: 'Locate CodeLLDB',
      description: 'Locate a CodeLLDB >= 1.11.0 adapter from an explicit path, CODELLDB_PATH, common VS Code-compatible extension directories, or PATH.',
      inputSchema: z.object({ adapterPath: z.string().min(1).optional() }),
    },
    wrap(async ({ adapterPath }) => discoverCodeLldb({ ...(adapterPath ? { explicitPath: adapterPath as string } : {}) })),
  );

  server.registerTool(
    'debug_start_codelldb',
    {
      title: 'Start CodeLLDB',
      description: 'Auto-discover and initialize CodeLLDB using DAP over stdio. CodeLLDB 1.11.0 or newer is required.',
      inputSchema: z.object({
        adapterPath: z.string().min(1).optional(),
        cwd: z.string().optional(),
        requestTimeoutMs: z.number().int().min(1000).max(120000).optional(),
      }),
    },
    wrap(async ({ adapterPath, cwd, requestTimeoutMs }) => {
      const adapter = discoverCodeLldb({ ...(adapterPath ? { explicitPath: adapterPath as string } : {}) });
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
      description: 'Launch a native program through an initialized CodeLLDB session. Uses terminal=console so no runInTerminal reverse request is required.',
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
      )),
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
      )),
  );

  server.registerTool(
    'debug_start',
    {
      title: 'Start DAP Adapter',
      description: 'Start a local Debug Adapter Protocol process and initialize a debug session. The adapter is spawned directly without a shell.',
      inputSchema: z.object({
        adapterCommand: z.string().min(1),
        adapterArgs: z.array(z.string()).optional(),
        adapterId: z.string().min(1),
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
      description: 'Send a DAP launch request, wait for initialization, configure optional source breakpoints, and complete DAP configuration.',
      inputSchema: z.object({ configuration: jsonRecord, breakpoints: z.array(breakpointGroupSchema).optional() }),
    },
    wrap(async ({ configuration, breakpoints }) => session.launch(
      configuration as Record<string, unknown>,
      (breakpoints ?? []) as Array<{ source: string; lines: number[] }>,
    )),
  );

  server.registerTool(
    'debug_attach',
    {
      title: 'Attach Debugger',
      description: 'Send a DAP attach request to an authorized local target and complete DAP configuration.',
      inputSchema: z.object({ configuration: jsonRecord, breakpoints: z.array(breakpointGroupSchema).optional() }),
    },
    wrap(async ({ configuration, breakpoints }) => session.attach(
      configuration as Record<string, unknown>,
      (breakpoints ?? []) as Array<{ source: string; lines: number[] }>,
    )),
  );

  server.registerTool(
    'debug_set_breakpoints',
    {
      title: 'Set Source Breakpoints',
      description: 'Replace simple line breakpoints for one source file.',
      inputSchema: breakpointGroupSchema,
    },
    wrap(async ({ source, lines }) => ({ source, breakpoints: await session.setBreakpoints(source as string, lines as number[]) })),
  );

  server.registerTool(
    'debug_set_source_breakpoints',
    {
      title: 'Set Advanced Source Breakpoints',
      description: 'Replace source breakpoints for one file, including optional condition, hit condition, column and log message.',
      inputSchema: z.object({ source: z.string().min(1), breakpoints: z.array(sourceBreakpointSchema) }),
    },
    wrap(async ({ source, breakpoints }) => ({
      source,
      breakpoints: await session.setSourceBreakpoints(source as string, breakpoints as never[]),
    })),
  );

  server.registerTool(
    'debug_set_function_breakpoints',
    {
      title: 'Set Function Breakpoints',
      description: 'Replace function breakpoints when supported by the active DAP adapter.',
      inputSchema: z.object({ breakpoints: z.array(functionBreakpointSchema) }),
    },
    wrap(async ({ breakpoints }) => session.setFunctionBreakpoints(breakpoints as never[])),
  );

  server.registerTool(
    'debug_set_instruction_breakpoints',
    {
      title: 'Set Instruction Breakpoints',
      description: 'Replace instruction breakpoints at DAP instruction references when supported by the adapter.',
      inputSchema: z.object({ breakpoints: z.array(instructionBreakpointSchema) }),
    },
    wrap(async ({ breakpoints }) => session.setInstructionBreakpoints(breakpoints as never[])),
  );

  server.registerTool(
    'debug_data_breakpoint_info',
    {
      title: 'Resolve Data Breakpoint',
      description: 'Ask the debugger for a stable dataId and supported access modes for a variable/property before creating a watchpoint.',
      inputSchema: z.object({
        name: z.string().min(1),
        variablesReference: z.number().int().positive().optional(),
        frameId: z.number().int().optional(),
      }),
    },
    wrap(async ({ name, variablesReference, frameId }) => session.dataBreakpointInfo(
      name as string,
      variablesReference as number | undefined,
      frameId as number | undefined,
    )),
  );

  server.registerTool(
    'debug_set_data_breakpoints',
    {
      title: 'Set Data Breakpoints',
      description: 'Replace data breakpoints/watchpoints using dataIds returned by debug_data_breakpoint_info.',
      inputSchema: z.object({ breakpoints: z.array(dataBreakpointSchema) }),
    },
    wrap(async ({ breakpoints }) => session.setDataBreakpoints(breakpoints as never[])),
  );

  server.registerTool(
    'debug_set_exception_breakpoints',
    {
      title: 'Configure Exception Breakpoints',
      description: 'Configure adapter-defined exception filters, optionally with filter conditions.',
      inputSchema: z.object({
        filters: z.array(z.string()).default([]),
        filterOptions: z.array(exceptionFilterOptionSchema).optional(),
      }),
    },
    wrap(async ({ filters, filterOptions }) => session.setExceptionBreakpoints(
      filters as string[],
      filterOptions as never[] | undefined,
    )),
  );

  server.registerTool(
    'debug_pause',
    {
      title: 'Pause Execution',
      description: 'Pause a running thread and optionally wait for the resulting stopped event.',
      inputSchema: z.object({
        threadId: z.number().int().positive(),
        waitForStop: z.boolean().default(true),
        timeoutMs: z.number().int().min(1000).max(120000).default(15000),
      }),
    },
    wrap(async ({ threadId, waitForStop, timeoutMs }) => session.pause(
      threadId as number,
      waitForStop as boolean,
      timeoutMs as number,
    )),
  );

  server.registerTool(
    'debug_continue',
    {
      title: 'Continue Execution',
      description: 'Resume one paused thread in a live debug session. Use this after inspecting a stopped state when execution should proceed to the next stop or termination; do not use it for crash dumps because postmortem targets cannot resume. This changes debuggee execution state and may allow the target to perform normal application side effects before the next stop.',
      annotations: DEBUG_SESSION_CONTROL_ANNOTATIONS,
      outputSchema: debugContinueOutputSchema,
      inputSchema: z.object({
        threadId: z.number().int().positive().describe('DAP thread identifier to resume; obtain it from debug_snapshot, debug_status, or a stopped event.'),
        waitForStop: z.boolean().default(true).describe('When true, wait for the next stopped event before returning; when false, return after the continue request is accepted.'),
        timeoutMs: z.number().int().min(1000).max(120000).default(15000).describe('Maximum time in milliseconds to wait for the next stopped event when waitForStop is true.'),
      }),
    },
    wrapStructured(async ({ threadId, waitForStop, timeoutMs }) => session.continueExecution(
      threadId as number,
      waitForStop as boolean,
      timeoutMs as number,
    )),
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
    wrap(async ({ action, threadId, waitForStop, timeoutMs }) => session.step(
      action as 'next' | 'stepIn' | 'stepOut',
      threadId as number,
      waitForStop as boolean,
      timeoutMs as number,
    )),
  );

  server.registerTool('debug_threads', { title: 'List Threads', description: 'List threads in the current debuggee.' }, async () => {
    try { return result(await session.threads()); } catch (error) { return errorResult(error); }
  });

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
    wrap(async ({ threadId, startFrame, levels }) => session.stackTrace(threadId as number, startFrame as number, levels as number)),
  );

  server.registerTool(
    'debug_scopes',
    { title: 'Read Frame Scopes', description: 'Read scopes such as Locals, Arguments, or Registers for a stack frame.', inputSchema: z.object({ frameId: z.number().int() }) },
    wrap(async ({ frameId }) => session.scopes(frameId as number)),
  );

  server.registerTool(
    'debug_variables',
    {
      title: 'Read Variables',
      description: 'Expand a positive DAP variablesReference returned by a scope, variable, or evaluation result.',
      inputSchema: z.object({
        variablesReference: z.number().int().positive(),
        start: z.number().int().nonnegative().optional(),
        count: z.number().int().positive().max(1000).optional(),
      }),
    },
    wrap(async ({ variablesReference, start, count }) => session.variables(
      variablesReference as number,
      start as number | undefined,
      count as number | undefined,
    )),
  );

  server.registerTool(
    'debug_evaluate',
    {
      title: 'Evaluate Debugger Expression',
      description: 'Evaluate an expression in the debugger. Expressions may have side effects depending on debugger/language.',
      inputSchema: z.object({
        expression: z.string().min(1),
        frameId: z.number().int().optional(),
        context: z.enum(['watch', 'repl', 'hover', 'clipboard', 'variables']).default('watch'),
      }),
    },
    wrap(async ({ expression, frameId, context }) => session.evaluate(
      expression as string,
      frameId as number | undefined,
      context as 'watch' | 'repl' | 'hover' | 'clipboard' | 'variables',
    )),
  );

  server.registerTool(
    'debug_modules',
    {
      title: 'List Loaded Modules',
      description: 'List loaded executable images and libraries.',
      inputSchema: z.object({ startModule: z.number().int().nonnegative().default(0), moduleCount: z.number().int().positive().max(1000).default(100) }),
    },
    wrap(async ({ startModule, moduleCount }) => session.modules(startModule as number, moduleCount as number)),
  );

  server.registerTool(
    'debug_disassemble',
    {
      title: 'Disassemble Memory',
      description: 'Disassemble instructions around a DAP memoryReference.',
      inputSchema: z.object({
        memoryReference: z.string().min(1),
        instructionCount: z.number().int().positive().max(500).default(20),
        instructionOffset: z.number().int().min(-500).max(500).default(0),
        offset: z.number().int().min(-1048576).max(1048576).default(0),
        resolveSymbols: z.boolean().default(true),
      }),
    },
    wrap(async ({ memoryReference, instructionCount, instructionOffset, offset, resolveSymbols }) => session.disassemble(
      memoryReference as string,
      instructionCount as number,
      instructionOffset as number,
      offset as number,
      resolveSymbols as boolean,
    )),
  );

  server.registerTool(
    'debug_read_memory',
    {
      title: 'Read Debuggee Memory',
      description: 'Read a bounded memory range through DAP. Returns base64 plus a hexadecimal rendering and rejects adapter responses larger than the requested bound.',
      inputSchema: z.object({
        memoryReference: z.string().min(1),
        count: z.number().int().positive().max(65536),
        offset: z.number().int().min(-16777216).max(16777216).default(0),
      }),
    },
    wrap(async ({ memoryReference, count, offset }) => {
      const memory = await session.readMemory(memoryReference as string, count as number, offset as number);
      return formatMemoryResult(memory as Record<string, unknown> & { data?: string }, count as number);
    }),
  );

  server.registerTool(
    'debug_exception_info',
    { title: 'Read Exception Information', description: 'Read structured exception information for a stopped thread.', inputSchema: z.object({ threadId: z.number().int().positive() }) },
    wrap(async ({ threadId }) => session.exceptionInfo(threadId as number)),
  );

  server.registerTool(
    'debug_snapshot',
    {
      title: 'Capture Runtime Debug Snapshot',
      description: 'Capture bounded evidence from the current stopped debug state without resuming execution. Use this when an agent needs raw stack, locals, registers, exception details, modules, or nearby instructions; prefer debug_diagnose_stop when you also want ranked crash hypotheses and project-frame selection. This is read-only with respect to the debuggee and returns best-effort evidence plus collection errors for optional data that an adapter cannot provide.',
      annotations: READ_ONLY_LOCAL_TOOL_ANNOTATIONS,
      outputSchema: debugSnapshotOutputSchema,
      inputSchema: z.object({
        threadId: z.number().int().positive().optional().describe('Stopped DAP thread to inspect; omit to use the session-selected stopped thread.'),
        stackLevels: z.number().int().positive().max(100).default(12).describe('Maximum number of stack frames to include, from the selected thread top downward.'),
        maxVariablesPerScope: z.number().int().positive().max(500).default(100).describe('Maximum variables returned per inspected scope, bounding output size.'),
        includeDisassembly: z.boolean().default(true).describe('Include best-effort instructions around the selected frame instruction pointer when supported.'),
        disassembleBefore: z.number().int().nonnegative().max(100).default(8).describe('Number of instructions before the current instruction to request when disassembly is enabled.'),
        disassembleAfter: z.number().int().nonnegative().max(100).default(12).describe('Number of instructions after the current instruction to request when disassembly is enabled.'),
        includeModules: z.boolean().default(false).describe('Include a bounded list of loaded executable images and libraries.'),
        moduleCount: z.number().int().positive().max(500).default(50).describe('Maximum loaded modules to return when includeModules is true.'),
        includeExceptionInfo: z.boolean().default(true).describe('Include structured exception information for the stopped thread when the adapter supports it.'),
      }),
    },
    wrapStructured(async ({ threadId, stackLevels, maxVariablesPerScope, includeDisassembly, disassembleBefore, disassembleAfter, includeModules, moduleCount, includeExceptionInfo }) =>
      session.runtimeSnapshot({
        ...(threadId === undefined ? {} : { threadId: threadId as number }),
        stackLevels: stackLevels as number,
        maxVariablesPerScope: maxVariablesPerScope as number,
        includeDisassembly: includeDisassembly as boolean,
        disassembleBefore: disassembleBefore as number,
        disassembleAfter: disassembleAfter as number,
        includeModules: includeModules as boolean,
        moduleCount: moduleCount as number,
        includeExceptionInfo: includeExceptionInfo as boolean,
      })),
  );

  server.registerTool('debug_status', {
    title: 'Debug Session Status',
    description: 'Inspect debugger lifecycle state, the selected stop, recent DAP events, and bounded adapter stderr without changing target execution. Use this to determine whether a session is initialized, running, stopped, postmortem, exited, or failed before choosing another debug tool; it is diagnostic only and does not resume, launch, attach, or terminate the debuggee.',
    annotations: READ_ONLY_LOCAL_TOOL_ANNOTATIONS,
    outputSchema: debugStatusOutputSchema,
  }, async () => structuredResult(session.snapshot()));

  server.registerTool(
    'debug_events',
    { title: 'Recent DAP Events', description: 'Return recent asynchronous DAP events.', inputSchema: z.object({ limit: z.number().int().positive().max(200).default(25) }) },
    wrap(async ({ limit }) => session.connection.recentEvents.slice(-(limit as number))),
  );

  server.registerTool(
    'debug_disconnect',
    {
      title: 'Disconnect Debugger',
      description: 'End the active DAP session and stop its local adapter process. Use this when debugging is finished or the session must be reset; do not call it when more runtime evidence is still needed. With terminateDebuggee=true it may also terminate a live target process, so this operation can destroy the current runtime state and cannot be treated as read-only.',
      annotations: SESSION_TEARDOWN_ANNOTATIONS,
      outputSchema: debugDisconnectOutputSchema,
      inputSchema: z.object({
        terminateDebuggee: z.boolean().default(true).describe('Whether the debugger should terminate the live debuggee while disconnecting; set false to request detach/preserve behavior when the adapter supports it.'),
      }),
    },
    wrapStructured(async ({ terminateDebuggee }) => {
      await session.disconnect(terminateDebuggee as boolean);
      return { disconnected: true };
    }),
  );
}
