import { logger } from './logger.js';
import {
  DEBUG_SESSION_CONTROL_ANNOTATIONS,
  LOCAL_TARGET_EXECUTION_ANNOTATIONS,
  READ_ONLY_LOCAL_TOOL_ANNOTATIONS,
  SESSION_TEARDOWN_ANNOTATIONS,
} from './tools/tool-annotations.js';

export type ToolsetMode = 'agent' | 'full';

export const AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'debug_this_crash',
  'debug_this_hang',
  'debug_compare_runs',
  'debug_trace_value',
  'debug_diagnose_stop',
  'debug_source_disassembly',
  'debug_find_writer',
  'debug_run_to_stop',
  'debug_open_dump',
  'debug_snapshot',
  'debug_status',
  'debug_continue',
  'debug_disconnect',
  'debug_sessions',
]);

const LOCAL_EXECUTION_TOOLS = new Set([
  'debug_start',
  'debug_start_codelldb',
  'debug_launch',
  'debug_launch_codelldb',
  'debug_attach',
  'debug_attach_codelldb',
]);

const SESSION_CONTROL_TOOLS = new Set([
  'debug_set_breakpoints',
  'debug_set_source_breakpoints',
  'debug_set_function_breakpoints',
  'debug_set_instruction_breakpoints',
  'debug_set_data_breakpoints',
  'debug_set_exception_breakpoints',
  'debug_pause',
  'debug_continue',
  'debug_step',
  'debug_evaluate',
]);

const READ_ONLY_FULL_TOOLS = new Set([
  'debug_codelldb_info',
  'debug_data_breakpoint_info',
  'debug_threads',
  'debug_stack',
  'debug_scopes',
  'debug_variables',
  'debug_modules',
  'debug_disassemble',
  'debug_read_memory',
  'debug_exception_info',
  'debug_events',
]);

type ToolRegistrar = {
  registerTool: (...args: any[]) => any;
};

const FILTERED_TOOL_HANDLE = Object.freeze({
  disable: () => undefined,
  enable: () => undefined,
  update: (..._args: any[]) => undefined,
  remove: () => undefined,
});

function defaultAnnotationsForTool(name: string) {
  if (name === 'debug_disconnect' || name === 'debug_sessions') return SESSION_TEARDOWN_ANNOTATIONS;
  if (name === 'debug_compare_runs') return READ_ONLY_LOCAL_TOOL_ANNOTATIONS;
  if (name === 'debug_trace_value') return DEBUG_SESSION_CONTROL_ANNOTATIONS;
  if (LOCAL_EXECUTION_TOOLS.has(name)) return LOCAL_TARGET_EXECUTION_ANNOTATIONS;
  if (SESSION_CONTROL_TOOLS.has(name)) return DEBUG_SESSION_CONTROL_ANNOTATIONS;
  if (READ_ONLY_FULL_TOOLS.has(name)) return READ_ONLY_LOCAL_TOOL_ANNOTATIONS;
  return undefined;
}

function withBehaviorAnnotations(name: string, args: any[]): any[] {
  const config = args[0];
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.annotations) return args;
  const annotations = defaultAnnotationsForTool(name);
  if (!annotations) return args;
  return [{ ...config, annotations }, ...args.slice(1)];
}

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

/**
 * Add explicit MCP behavior metadata to legacy/manual tool registrations.
 * This is intentionally separate from toolset filtering so callers that use
 * filterToolRegistrar(..., 'full') retain the historical identity/no-op path.
 */
export function annotateToolRegistrar<T extends ToolRegistrar>(registrar: T): T {
  return new Proxy(registrar, {
    get(target, property, receiver) {
      if (property === 'registerTool') {
        return (name: string, ...args: any[]) =>
          target.registerTool.call(target, name, ...withBehaviorAnnotations(name, args));
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
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
