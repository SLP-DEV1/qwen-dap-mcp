export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export type LogFields = Record<string, unknown>;
export type LogSink = (line: string) => void;

export type LoggerOptions = {
  level?: string;
  sink?: LogSink;
};

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Number.POSITIVE_INFINITY,
};

function normalizeLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'debug' || normalized === 'info' || normalized === 'warn' || normalized === 'error' || normalized === 'silent') {
    return normalized;
  }
  return 'info';
}

function stringifyLogRecord(record: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(record, (_key, value: unknown) => {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        ...(value.stack ? { stack: value.stack } : {}),
        ...('cause' in value && value.cause !== undefined ? { cause: value.cause } : {}),
      };
    }

    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  });
}

export function createLogger(options: LoggerOptions = {}) {
  const configuredLevel = normalizeLogLevel(options.level ?? process.env.QWEN_DAP_LOG_LEVEL);
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));

  const write = (level: Exclude<LogLevel, 'silent'>, message: string, fields?: LogFields): void => {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[configuredLevel]) return;

    sink(stringifyLogRecord({
      timestamp: new Date().toISOString(),
      level,
      component: 'qwen-dap-mcp',
      message,
      ...(fields && Object.keys(fields).length > 0 ? { fields } : {}),
    }));
  };

  return {
    level: configuredLevel,
    debug: (message: string, fields?: LogFields) => write('debug', message, fields),
    info: (message: string, fields?: LogFields) => write('info', message, fields),
    warn: (message: string, fields?: LogFields) => write('warn', message, fields),
    error: (message: string, fields?: LogFields) => write('error', message, fields),
  };
}

export const logger = createLogger();
