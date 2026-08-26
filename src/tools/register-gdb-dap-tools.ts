import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import {
  buildGdbDapLaunchConfiguration,
  buildGdbDapPidAttachConfiguration,
  buildGdbDapRemoteAttachConfiguration,
  discoverGdbDap,
  resolveGdbDapRemoteEndpoint,
} from '../adapters/gdb-dap.js';
import { GuardedDapSession } from '../dap/guarded-session.js';
import { REMOTE_DEBUG_HOSTS_ENV } from '../remote-endpoint.js';
import { LOCAL_TARGET_EXECUTION_ANNOTATIONS, READ_ONLY_LOCAL_TOOL_ANNOTATIONS } from './tool-annotations.js';

const breakpointGroupSchema = z.object({
  source: z.string().min(1).describe('Absolute or GDB-resolvable source file path.'),
  lines: z.array(z.number().int().positive()).min(1).describe('One or more 1-based source lines to set before configurationDone.'),
});

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
  return { content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
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

export function registerGdbDapTools(server: McpServer, session: GuardedDapSession): void {
  server.registerTool(
    'debug_gdb_info',
    {
      title: 'Locate GDB DAP',
      description: 'Locate and version-check a local GDB executable with the built-in DAP interpreter. Use this to verify GDB >= 14 discovery before starting a GNU debugger session; it only probes the local executable and does not launch or attach a debuggee.',
      annotations: READ_ONLY_LOCAL_TOOL_ANNOTATIONS,
      inputSchema: z.object({
        adapterPath: z.string().min(1).optional().describe('Optional explicit path to the GDB executable; omit to search GDB_DAP_PATH, GDB_PATH, GDB_HOME, and PATH.'),
      }),
    },
    wrap(async ({ adapterPath }) => discoverGdbDap({ ...(adapterPath ? { explicitPath: adapterPath as string } : {}) })),
  );

  server.registerTool(
    'debug_start_gdb',
    {
      title: 'Start GDB DAP',
      description: 'Discover GDB >= 14 and initialize its built-in Debug Adapter Protocol interpreter over stdio. Use this before the manual GDB launch/attach helpers in the full toolset; it starts only GDB itself and does not yet run or attach a target.',
      annotations: LOCAL_TARGET_EXECUTION_ANNOTATIONS,
      inputSchema: z.object({
        adapterPath: z.string().min(1).optional().describe('Optional explicit GDB executable path; omit to use normal GDB discovery.'),
        cwd: z.string().optional().describe('Working directory for the local GDB adapter process.'),
        requestTimeoutMs: z.number().int().min(1000).max(120000).default(30000).describe('Per-request DAP timeout in milliseconds.'),
      }),
    },
    wrap(async ({ adapterPath, cwd, requestTimeoutMs }) => {
      const adapter = discoverGdbDap({ ...(adapterPath ? { explicitPath: adapterPath as string } : {}) });
      const capabilities = await session.start({
        command: adapter.command,
        args: adapter.args,
        adapterId: 'gdb',
        ...(cwd ? { cwd: cwd as string } : {}),
        requestTimeoutMs: requestTimeoutMs as number,
      });
      return { adapter, capabilities, status: session.snapshot() };
    }),
  );

  server.registerTool(
    'debug_launch_gdb',
    {
      title: 'Launch with GDB DAP',
      description: 'Launch an authorized local native program through an initialized GDB DAP session. This executes application code and may produce normal target side effects; use debug_this_crash(mode="gdb") for the higher-level diagnose/verify workflow.',
      annotations: LOCAL_TARGET_EXECUTION_ANNOTATIONS,
      inputSchema: z.object({
        program: z.string().min(1).describe('Local native executable to launch.'),
        args: z.array(z.string()).optional().describe('Command-line arguments for the inferior.'),
        cwd: z.string().optional().describe('Working directory inherited by the inferior.'),
        env: z.record(z.string(), z.string()).optional().describe('Exact environment object passed to the GDB launch request.'),
        stopOnEntry: z.boolean().default(false).describe('Stop at the first instruction using GDB starti semantics.'),
        stopAtBeginningOfMainSubprogram: z.boolean().default(false).describe('Stop at the main subprogram using GDB start semantics.'),
        breakpoints: z.array(breakpointGroupSchema).optional().describe('Optional source breakpoints configured before the inferior runs.'),
      }),
    },
    wrap(async ({ program, args, cwd, env, stopOnEntry, stopAtBeginningOfMainSubprogram, breakpoints }) => session.launch(
      buildGdbDapLaunchConfiguration({
        program: program as string,
        ...(args ? { args: args as string[] } : {}),
        ...(cwd ? { cwd: cwd as string } : {}),
        ...(env ? { env: env as Record<string, string> } : {}),
        stopOnEntry: stopOnEntry as boolean,
        stopAtBeginningOfMainSubprogram: stopAtBeginningOfMainSubprogram as boolean,
      }),
      (breakpoints ?? []) as Array<{ source: string; lines: number[] }>,
    )),
  );

  server.registerTool(
    'debug_attach_gdb',
    {
      title: 'Attach GDB to PID',
      description: 'Attach an initialized GDB DAP session to an authorized local process by PID. This changes debugger/target state and can stop the process; use only for targets you are authorized to inspect.',
      annotations: LOCAL_TARGET_EXECUTION_ANNOTATIONS,
      inputSchema: z.object({
        pid: z.number().int().positive().describe('Authorized local process ID to attach.'),
        program: z.string().min(1).optional().describe('Optional matching executable image used for symbols when GDB cannot infer it.'),
        breakpoints: z.array(breakpointGroupSchema).optional().describe('Optional source breakpoints configured before attach setup completes.'),
      }),
    },
    wrap(async ({ pid, program, breakpoints }) => session.attach(
      buildGdbDapPidAttachConfiguration({ pid: pid as number, ...(program ? { program: program as string } : {}) }),
      (breakpoints ?? []) as Array<{ source: string; lines: number[] }>,
    )),
  );

  server.registerTool(
    'debug_attach_gdb_remote',
    {
      title: 'Attach GDB to gdbserver',
      description: `Use this to connect an initialized GDB DAP session to an explicitly authorized gdbserver TCP endpoint. Loopback hosts are allowed by default; non-loopback hosts must be listed exactly in ${REMOTE_DEBUG_HOSTS_ENV}. Do not use this as a generic GDB target-string escape hatch: serial devices, arbitrary target syntax, and unapproved network hosts are rejected, and this tool never starts gdbserver itself.`,
      annotations: LOCAL_TARGET_EXECUTION_ANNOTATIONS,
      inputSchema: z.object({
        host: z.string().min(1).optional().describe(`Preferred structured TCP host. localhost/127.0.0.0/8/::1 are allowed by default; other exact hosts require ${REMOTE_DEBUG_HOSTS_ENV}.`),
        port: z.number().int().min(1).max(65535).optional().describe('Preferred structured gdbserver TCP port from 1 through 65535.'),
        target: z.string().min(1).optional().describe('Backward-compatible TCP host:port form only, for example localhost:1234 or [::1]:1234. Arbitrary GDB target syntax is rejected.'),
        program: z.string().min(1).optional().describe('Optional local unstripped executable used for matching symbols; it must match the remote target binary.'),
        breakpoints: z.array(breakpointGroupSchema).optional().describe('Optional source breakpoints configured after connecting to the authorized endpoint.'),
      }),
    },
    wrap(async ({ host, port, target, program, breakpoints }) => {
      const remoteOptions = {
        ...(host ? { host: host as string } : {}),
        ...(port === undefined ? {} : { port: port as number }),
        ...(target ? { target: target as string } : {}),
        ...(program ? { program: program as string } : {}),
      };
      const endpoint = resolveGdbDapRemoteEndpoint(remoteOptions);
      const attach = await session.attach(
        buildGdbDapRemoteAttachConfiguration(remoteOptions),
        (breakpoints ?? []) as Array<{ source: string; lines: number[] }>,
      );
      return { endpoint, attach, status: session.snapshot() };
    }),
  );
}
