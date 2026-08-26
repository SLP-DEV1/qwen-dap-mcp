import { DapError } from '../dap/errors.js';
import { resolveExistingFile } from '../local-path.js';

export type CodeLldbDumpOptions = {
  dumpPath: string;
  program?: string;
  sourceMap?: Record<string, string>;
};

function quoteLldbPath(path: string): string {
  // These paths become part of one LLDB command string. Quoting protects
  // spaces and quotes, while control characters are rejected so a filesystem
  // name cannot create a second command/line in the LLDB command interpreter.
  if (/[\0\r\n]/.test(path)) {
    throw new DapError('LLDB target paths must not contain NUL, carriage-return, or newline characters');
  }
  // Forward slashes work on Windows in LLDB and avoid backslash escaping in
  // the command interpreter. Quotes are escaped explicitly for unusual paths.
  return `"${path.replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
}

export function buildCodeLldbDumpConfiguration(options: CodeLldbDumpOptions): Record<string, unknown> {
  const dumpPath = resolveExistingFile(options.dumpPath, 'Crash dump');
  const program = options.program
    ? resolveExistingFile(options.program, 'Program image')
    : undefined;

  // CodeLLDB's documented postmortem flow is an attach request where LLDB
  // creates a target from the core/minidump and no live process is attached.
  const targetCreateCommand = program
    ? `target create -c ${quoteLldbPath(dumpPath)} ${quoteLldbPath(program)}`
    : `target create -c ${quoteLldbPath(dumpPath)}`;

  return {
    type: 'lldb',
    request: 'attach',
    name: 'qwen-dap-mcp CodeLLDB crash dump',
    targetCreateCommands: [targetCreateCommand],
    processCreateCommands: [],
    ...(options.sourceMap ? { sourceMap: options.sourceMap } : {}),
  };
}
