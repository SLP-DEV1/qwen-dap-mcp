import { logger } from './logger.js';

export type ToolsetMode = 'agent' | 'full';

export const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'debug_this_crash',
  'debug_diagnose_stop',
  'debug_source_disassembly',
  'debug_find_writer',
  'debug_run_to_stop',
  'debug_open_dump',
  'debug_snapshot',
  'debug_status',
  'debug_continue',
  'debug_disconnect',
]);

type ToolRegistrar = {
  // McpServer.registerTool is overloaded/generic; this preserves its call
  // surface while filtering only by the first tool-name argument.
  registerTool: (...args: any[]) => any;
};

const FILTERED_TOOL_HANDLE = Object.freeze({
  disable: () => undefined,
  enable: () => undefined,
  update: (..._args: any[]) => undefined,
  remove: () => undefined,
});

export function resolveToolsetMode(value = process.env.QWEN_DAP_MCP_TOOLSET): ToolsetMode {
  if (value === undefined || value.trim() === '') return 'agent';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'agent' || normalized === 'full') return normalized;
  logger.warn('Invalid QWEN_DAP_MCP_TOOLSET; falling back to the safe agent toolset', { value });
  return 'agent';
}

export function toolsetAllows(mode: ToolsetMode, toolName: string): boolean {
  return mode === 'full' || AGENT_TOOL_NAMES.has(toolName);
}

export function filterToolRegistrar<T extends ToolRegistrar>(registrar: T, mode: ToolsetMode): T {
  if (mode === 'full') return registrar;

  return new Proxy(registrar, {
    get(target, property, receiver) {
      if (property === 'registerTool') {
        return (name: string, ...args: any[]) => {
          if (!toolsetAllows(mode, name)) {
            logger.debug('Tool registration filtered by active toolset', { mode, tool: name });
            return FILTERED_TOOL_HANDLE;
          }
          return target.registerTool.call(target, name, ...args);
        };
      }

      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
