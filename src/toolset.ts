export type ToolsetMode = 'agent' | 'full';

export const AGENT_TOOL_NAMES = new Set([
  'debug_this_crash',
  'debug_diagnose_stop',
  'debug_source_disassembly',
  'debug_run_to_stop',
  'debug_open_dump',
  'debug_snapshot',
  'debug_status',
  'debug_continue',
  'debug_disconnect',
] as const);

type ToolRegistrar = {
  registerTool: (name: string, ...args: unknown[]) => unknown;
};

export function resolveToolsetMode(value = process.env.QWEN_DAP_MCP_TOOLSET): ToolsetMode {
  if (value === undefined || value.trim() === '') return 'agent';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'agent' || normalized === 'full') return normalized;
  throw new Error(
    `Invalid QWEN_DAP_MCP_TOOLSET '${value}'. Expected 'agent' or 'full'.`,
  );
}

export function toolsetAllows(mode: ToolsetMode, toolName: string): boolean {
  return mode === 'full' || AGENT_TOOL_NAMES.has(toolName as never);
}

export function filterToolRegistrar<T extends ToolRegistrar>(registrar: T, mode: ToolsetMode): T {
  if (mode === 'full') return registrar;

  return new Proxy(registrar, {
    get(target, property, receiver) {
      if (property === 'registerTool') {
        return (name: string, ...args: unknown[]) => {
          if (!toolsetAllows(mode, name)) return undefined;
          return target.registerTool.call(target, name, ...args);
        };
      }

      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
