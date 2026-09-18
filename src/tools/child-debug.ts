import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import {
  buildCodeLldbAttachConfiguration,
  buildCodeLldbLaunchConfiguration,
  discoverCodeLldb,
} from '../adapters/codelldb.js';
import {
  buildGdbDapLaunchConfiguration,
  buildGdbDapPidAttachConfiguration,
  discoverGdbDap,
} from '../adapters/gdb-dap.js';
import {
  buildLldbDapAttachConfiguration,
  buildLldbDapLaunchConfiguration,
  discoverLldbDap,
} from '../adapters/lldb-dap.js';
import type { DapSessionRegistry } from '../dap/session-registry.js';
import { DapError } from '../dap/errors.js';
import type { GuardedDapSession } from '../dap/guarded-session.js';
import { debugAdoptChildOutputSchema, structuredResult } from './agent-output.js';
import { LOCAL_TARGET_EXECUTION_ANNOTATIONS } from './tool-annotations.js';

const CHILD_DEBUG_ENV = 'QWEN_DAP_MCP_CHILD_DEBUG';

function errorResult(error: unknown) {
  return {
    content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

function enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:1|true|yes|on)$/i.test(env[CHILD_DEBUG_ENV]?.trim() ?? '');
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DapError(label + ' must be an object.');
  }
  return value as Record<string, unknown>;
}

function safeStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 128 || !value.every((item) => typeof item === 'string')) {
    throw new DapError('Child debug args must be an array of at most 128 strings.');
  }
  return value;
}

function safeEnv(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const object = asObject(value, 'Child debug env');
  const entries = Object.entries(object);
  if (entries.length > 256 || entries.some(([key, entry]) => !key || typeof entry !== 'string')) {
    throw new DapError('Child debug env must contain at most 256 string entries.');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

export function sanitizeStartConfiguration(
  request: { arguments?: unknown },
  overrides: { program?: string },
) {
  const requestArgs = asObject(request.arguments, 'startDebugging arguments');
  const rawConfig = asObject(requestArgs.configuration, 'startDebugging configuration');
  const serialized = JSON.stringify(rawConfig);
  if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) {
    throw new DapError('Child startDebugging configuration exceeds the 64 KiB review bound.');
  }

  const requestKind = rawConfig.request;
  if (requestKind !== 'launch' && requestKind !== 'attach') {
    throw new DapError('Child startDebugging configuration must use request="launch" or request="attach".');
  }

  const program = overrides.program ?? (typeof rawConfig.program === 'string' ? rawConfig.program : undefined);
  const cwd = typeof rawConfig.cwd === 'string' ? rawConfig.cwd : undefined;
  const args = safeStringArray(rawConfig.args);
  const env = safeEnv(rawConfig.env);
  const stopOnEntry = typeof rawConfig.stopOnEntry === 'boolean' ? rawConfig.stopOnEntry : false;
  const pid = typeof rawConfig.pid === 'number' && Number.isSafeInteger(rawConfig.pid) && rawConfig.pid > 0
    ? rawConfig.pid
    : undefined;

  if (requestKind === 'launch' && !program) {
    throw new DapError('Child launch requires an explicit program path in the captured configuration or program override.');
  }
  if (requestKind === 'attach' && !pid) {
    throw new DapError('Child attach requires a positive numeric pid in the captured configuration.');
  }

  return {
    request: requestKind,
    ...(program ? { program } : {}),
    ...(cwd ? { cwd } : {}),
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    stopOnEntry,
    ...(pid ? { pid } : {}),
  } as const;
}

export function registerChildDebugTools(
  server: McpServer,
  parentSession: GuardedDapSession,
  registry: DapSessionRegistry,
): void {
  server.registerTool(
    'debug_adopt_child',
    {
      title: 'Adopt Child Debug Request',
      description: `Explicitly adopt one captured DAP startDebugging request into a new isolated debugger session after validating a small launch/attach configuration subset. Use it only when ${CHILD_DEBUG_ENV}=1 and the child target is authorized. Do not use it as an automatic reverse-request executor: arbitrary adapter commands, terminal requests, remote targets, and unknown configuration fields are not forwarded.`,
      annotations: LOCAL_TARGET_EXECUTION_ANNOTATIONS,
      outputSchema: debugAdoptChildOutputSchema,
      inputSchema: z.object({
        requestIndex: z.number().int().min(0).max(49).default(0).describe('Index into the newest-first captured startDebugging requests; 0 selects the most recent request.'),
        childSessionId: z.string().min(1).max(64).optional().describe('Optional explicit session ID for the child; omit to generate a bounded session-N ID.'),
        adapter: z.enum(['gdb', 'lldb-dap', 'codelldb']).describe('Debugger adapter used for the new child session; the captured adapter type is never trusted automatically.'),
        adapterPath: z.string().min(1).optional().describe('Optional explicit local adapter executable path; omit to use normal hardened discovery.'),
        program: z.string().min(1).optional().describe('Optional explicit child executable override; useful when the reverse request omitted a symbol/program path.'),
        requestTimeoutMs: z.number().int().min(1000).max(120000).default(30000).describe('Per-request DAP timeout for child adapter initialization and launch/attach.'),
      }),
    },
    async ({ requestIndex, childSessionId, adapter, adapterPath, program, requestTimeoutMs }) => {
      try {
        if (!enabled()) {
          throw new DapError(`Child adoption is disabled. Set ${CHILD_DEBUG_ENV}=1 only when adapter-originated child targets are explicitly trusted and authorized.`);
        }

        const requests = parentSession.connection.recentReverseRequests
          .filter((request) => request.command === 'startDebugging')
          .slice()
          .reverse();
        const sourceRequest = requests[requestIndex];
        if (!sourceRequest) {
          throw new DapError(`No captured startDebugging request exists at newest-first index ${requestIndex}.`);
        }

        const config = sanitizeStartConfiguration(sourceRequest, { ...(program ? { program } : {}) });
        const created = registry.create(childSessionId);
        const child = created.session;

        try {
          let capabilities: unknown;
          let result: unknown;

          if (adapter === 'gdb') {
            const discovered = discoverGdbDap({ ...(adapterPath ? { explicitPath: adapterPath } : {}) });
            capabilities = await child.start({
              command: discovered.command,
              args: discovered.args,
              adapterId: 'gdb',
              requestTimeoutMs,
            });
            result = config.request === 'launch'
              ? await child.launch(buildGdbDapLaunchConfiguration({
                  program: config.program as string,
                  ...(config.args ? { args: config.args } : {}),
                  ...(config.cwd ? { cwd: config.cwd } : {}),
                  ...(config.env ? { env: config.env } : {}),
                  stopOnEntry: config.stopOnEntry,
                }))
              : await child.attach(buildGdbDapPidAttachConfiguration({
                  pid: config.pid as number,
                  ...(config.program ? { program: config.program } : {}),
                }));
          } else if (adapter === 'lldb-dap') {
            const discovered = discoverLldbDap({ ...(adapterPath ? { explicitPath: adapterPath } : {}) });
            capabilities = await child.start({
              command: discovered.command,
              adapterId: 'lldb',
              requestTimeoutMs,
            });
            result = config.request === 'launch'
              ? await child.launch(buildLldbDapLaunchConfiguration({
                  program: config.program as string,
                  ...(config.args ? { args: config.args } : {}),
                  ...(config.cwd ? { cwd: config.cwd } : {}),
                  ...(config.env ? { env: config.env } : {}),
                  stopOnEntry: config.stopOnEntry,
                }))
              : await child.attach(buildLldbDapAttachConfiguration({
                  pid: config.pid as number,
                  ...(config.program ? { program: config.program } : {}),
                  stopOnEntry: config.stopOnEntry,
                }));
          } else {
            const discovered = discoverCodeLldb({ ...(adapterPath ? { explicitPath: adapterPath } : {}) });
            capabilities = await child.start({
              command: discovered.command,
              adapterId: 'lldb',
              requestTimeoutMs,
            });
            result = config.request === 'launch'
              ? await child.launch(buildCodeLldbLaunchConfiguration({
                  program: config.program as string,
                  ...(config.args ? { args: config.args } : {}),
                  ...(config.cwd ? { cwd: config.cwd } : {}),
                  ...(config.env ? { env: config.env } : {}),
                  stopOnEntry: config.stopOnEntry,
                }))
              : await child.attach(buildCodeLldbAttachConfiguration({
                  pid: config.pid as number,
                  ...(config.program ? { program: config.program } : {}),
                  stopOnEntry: config.stopOnEntry,
                }));
          }

          return structuredResult({
            action: 'adopt' as const,
            sourceRequest,
            childSessionId: created.sessionId,
            adapter,
            request: config.request,
            capabilities,
            result,
            sessions: registry.list(),
          });
        } catch (error) {
          await registry.close(created.sessionId, false).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
