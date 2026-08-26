import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

function replace(path, oldText, newText) {
  const text = readFileSync(path, 'utf8');
  if (!text.includes(oldText)) {
    throw new Error(`Anchor not found in ${path}: ${oldText.slice(0, 160)}`);
  }
  writeFileSync(path, text.replace(oldText, newText), 'utf8');
}

replace(
  'src/dap/session.ts',
  "  private capabilities?: DebugProtocol.Capabilities;\n  private requestTimeoutMs = 15_000;",
  "  private capabilities?: DebugProtocol.Capabilities;\n  private dataBreakpoints: DebugProtocol.DataBreakpoint[] = [];\n  private requestTimeoutMs = 15_000;",
);

replace(
  'src/dap/session.ts',
  "    const response = await this.connection.sendRequest(\n      'setDataBreakpoints',\n      { breakpoints } satisfies DebugProtocol.SetDataBreakpointsArguments,\n      this.requestTimeoutMs,\n    );\n    return ((response.body as DebugProtocol.SetDataBreakpointsResponse['body'] | undefined)?.breakpoints ?? []);\n  }",
  "    const response = await this.connection.sendRequest(\n      'setDataBreakpoints',\n      { breakpoints } satisfies DebugProtocol.SetDataBreakpointsArguments,\n      this.requestTimeoutMs,\n    );\n    this.dataBreakpoints = breakpoints.map((breakpoint) => ({ ...breakpoint }));\n    return ((response.body as DebugProtocol.SetDataBreakpointsResponse['body'] | undefined)?.breakpoints ?? []);\n  }\n\n  dataBreakpointConfiguration(): DebugProtocol.DataBreakpoint[] {\n    return this.dataBreakpoints.map((breakpoint) => ({ ...breakpoint }));\n  }",
);

replace(
  'src/dap/session.ts',
  "    this.activeRequest = undefined;\n    this.capabilities = undefined;\n  }",
  "    this.activeRequest = undefined;\n    this.capabilities = undefined;\n    this.dataBreakpoints = [];\n  }",
);

replace(
  'src/tools/agent-diagnostics.ts',
  "import { buildCodeLldbLaunchConfiguration, discoverCodeLldb } from '../adapters/codelldb.js';\nimport { buildLldbDapLaunchConfiguration, discoverLldbDap } from '../adapters/lldb-dap.js';",
  "import { buildCodeLldbLaunchConfiguration, discoverCodeLldb } from '../adapters/codelldb.js';\nimport { buildGdbDapLaunchConfiguration, discoverGdbDap } from '../adapters/gdb-dap.js';\nimport { buildLldbDapLaunchConfiguration, discoverLldbDap } from '../adapters/lldb-dap.js';",
);

replace(
  'src/tools/agent-diagnostics.ts',
  "Use mode=current for an already stopped session, dump for read-only postmortem analysis, codelldb to discover CodeLLDB and launch a local binary, lldb-dap to discover upstream LLVM lldb-dap and launch a local binary, or live with an already initialized generic DAP adapter.",
  "Use mode=current for an already stopped session, dump for read-only postmortem analysis, codelldb to discover CodeLLDB, lldb-dap to discover upstream LLVM lldb-dap, gdb to discover GNU GDB's built-in DAP interpreter, or live with an already initialized generic DAP adapter.",
);
replace(
  'src/tools/agent-diagnostics.ts',
  "Do not use codelldb/lldb-dap/live when executing or attaching to the target is not authorized:",
  "Do not use codelldb/lldb-dap/gdb/live when executing or attaching to the target is not authorized:",
);
replace(
  'src/tools/agent-diagnostics.ts',
  "mode: z.enum(['current', 'live', 'codelldb', 'lldb-dap', 'dump']).default('current').describe('current inspects an existing stop; live runs launch/attach through an initialized DAP session; codelldb starts CodeLLDB; lldb-dap starts upstream LLVM lldb-dap; dump opens a frozen core/minidump.'),",
  "mode: z.enum(['current', 'live', 'codelldb', 'lldb-dap', 'gdb', 'dump']).default('current').describe('current inspects an existing stop; live uses an initialized generic DAP session; codelldb starts CodeLLDB; lldb-dap starts upstream LLVM lldb-dap; gdb starts GNU GDB with --interpreter=dap; dump opens a frozen core/minidump.'),",
);
replace(
  'src/tools/agent-diagnostics.ts',
  "program: z.string().min(1).optional().describe('Required for mode=codelldb and mode=lldb-dap; optional for CodeLLDB dumps but required when dumpAdapter=lldb-dap. Local path to the native executable.'),",
  "program: z.string().min(1).optional().describe('Required for codelldb/lldb-dap/gdb launch modes; optional for CodeLLDB/GDB dumps but required when dumpAdapter=lldb-dap. Local path to the native executable.'),",
);
replace(
  'src/tools/agent-diagnostics.ts',
  "args: z.array(z.string()).optional().describe('Command-line arguments passed to the launched program in mode=codelldb or mode=lldb-dap.'),",
  "args: z.array(z.string()).optional().describe('Command-line arguments passed to the launched program in codelldb/lldb-dap/gdb modes.'),",
);
replace(
  'src/tools/agent-diagnostics.ts',
  "env: z.record(z.string(), z.string()).optional().describe('Environment variables supplied to the launched program in mode=codelldb or mode=lldb-dap.'),",
  "env: z.record(z.string(), z.string()).optional().describe('Environment variables supplied to the launched program in codelldb/lldb-dap/gdb modes.'),",
);
replace(
  'src/tools/agent-diagnostics.ts',
  "stopOnEntry: z.boolean().default(false).describe('When true in mode=codelldb or mode=lldb-dap, request an initial debugger stop at program entry before normal execution.'),",
  "stopOnEntry: z.boolean().default(false).describe('When true in codelldb/lldb-dap/gdb modes, request an initial debugger stop at program entry before normal execution.'),",
);
replace(
  'src/tools/agent-diagnostics.ts',
  "adapterPath: z.string().min(1).optional().describe('Optional explicit debugger-adapter executable path for codelldb/lldb-dap/dump modes; omit to auto-discover the selected adapter.'),",
  "adapterPath: z.string().min(1).optional().describe('Optional explicit debugger executable/adapter path for codelldb/lldb-dap/gdb/dump modes; omit to auto-discover the selected adapter.'),",
);
replace(
  'src/tools/agent-diagnostics.ts',
  "dumpAdapter: z.enum(['codelldb', 'lldb-dap']).default('codelldb').describe('For mode=dump, choose CodeLLDB compatibility behavior or upstream LLVM lldb-dap coreFile loading.'),",
  "dumpAdapter: z.enum(['codelldb', 'lldb-dap', 'gdb']).default('codelldb').describe('For mode=dump, choose CodeLLDB, upstream LLVM lldb-dap coreFile loading, or GNU GDB coreFile attach semantics.'),",
);
replace(
  'src/tools/agent-diagnostics.ts',
  "requestTimeoutMs: z.number().int().min(1000).max(120000).default(30000).describe('Per-request DAP timeout in milliseconds for CodeLLDB operations.'),",
  "requestTimeoutMs: z.number().int().min(1000).max(120000).default(30000).describe('Per-request DAP timeout in milliseconds for the selected debugger adapter.'),",
);

const gdbBlock = [
  "          if (mode === 'gdb') {",
  "            if (!program) throw new DapError(\"debug_this_crash mode='gdb' requires program.\");",
  '',
  '            const launchConfiguration = buildGdbDapLaunchConfiguration({',
  '              program,',
  '              ...(args ? { args } : {}),',
  '              ...(cwd ? { cwd } : {}),',
  '              ...(env ? { env } : {}),',
  '              stopOnEntry,',
  '            });',
  '            const adapter = discoverGdbDap({',
  '              ...(adapterPath ? { explicitPath: adapterPath } : {}),',
  '            });',
  '',
  '            let adapterStarted = false;',
  '            try {',
  '              const capabilities = await session.start({',
  '                command: adapter.command,',
  '                args: adapter.args,',
  "                adapterId: 'gdb',",
  '                ...(cwd ? { cwd } : {}),',
  '                requestTimeoutMs,',
  '              });',
  '              adapterStarted = true;',
  '              const run = await runToStop(session, {',
  "                request: 'launch',",
  '                configuration: launchConfiguration,',
  '                ...(breakpoints ? { breakpoints: breakpoints as SourceBreakpointGroup[] } : {}),',
  '                timeoutMs,',
  '                snapshot: {',
  '                  ...snapshotOptions,',
  '                  includeDisassembly: true,',
  '                  includeModules: true,',
  '                  includeExceptionInfo: true,',
  '                },',
  '              });',
  '              const diagnosis = run.snapshot',
  '                ? await diagnoseSnapshot(session, run.snapshot, snapshotOptions, analysisOptions)',
  '                : undefined;',
  '              const terminal = run.snapshot',
  '                ? undefined',
  "                : terminalForVerification(run.outcome as { event: 'exited' | 'terminated'; body?: unknown });",
  '              return {',
  '                mode,',
  '                adapter,',
  '                capabilities,',
  '                run,',
  '                diagnosis: diagnosis',
  '                  ?? terminalOutcomeDiagnosis(run.outcome as { event: \'exited\' | \'terminated\'; body?: unknown }),',
  '                workflow: workflowMetadata(stage, baseline, diagnosis, terminal, agentState, maxIterations),',
  '                status: session.snapshot(),',
  '              };',
  '            } catch (error) {',
  '              if (adapterStarted) return await resetOwnedSessionAfterFailure(session, error);',
  '              throw error;',
  '            }',
  '          }',
  '',
].join('\n');
replace(
  'src/tools/agent-diagnostics.ts',
  "          if (mode === 'lldb-dap') {",
  `${gdbBlock}          if (mode === 'lldb-dap') {`,
);

replace(
  'src/tools/register-dump-tools.ts',
  "import { discoverCodeLldb } from '../adapters/codelldb.js';\nimport { buildCodeLldbDumpConfiguration } from '../adapters/codelldb-dump.js';\nimport { buildLldbDapCoreConfiguration, discoverLldbDap } from '../adapters/lldb-dap.js';",
  "import { discoverCodeLldb } from '../adapters/codelldb.js';\nimport { buildCodeLldbDumpConfiguration } from '../adapters/codelldb-dump.js';\nimport { buildGdbDapCoreConfiguration, discoverGdbDap } from '../adapters/gdb-dap.js';\nimport { buildLldbDapCoreConfiguration, discoverLldbDap } from '../adapters/lldb-dap.js';",
);
replace(
  'src/tools/register-dump-tools.ts',
  "export type DumpAdapterKind = 'codelldb' | 'lldb-dap';",
  "export type DumpAdapterKind = 'codelldb' | 'lldb-dap' | 'gdb';",
);
replace(
  'src/tools/register-dump-tools.ts',
  "    const configuration = adapterKind === 'lldb-dap'\n      ? (() => {",
  "    if (adapterKind === 'gdb' && options.sourceMap) {\n      throw new DapError(\"debug_open_dump adapter='gdb' does not currently translate sourceMap because GDB's documented DAP core-file attach parameters do not define a source-map field. Configure GDB source substitution externally or omit sourceMap.\");\n    }\n\n    const configuration = adapterKind === 'gdb'\n      ? buildGdbDapCoreConfiguration({\n          coreFile: options.dumpPath,\n          ...(options.program ? { program: options.program } : {}),\n        })\n      : adapterKind === 'lldb-dap'\n      ? (() => {",
);
replace(
  'src/tools/register-dump-tools.ts',
  "    const adapter = adapterKind === 'lldb-dap'\n      ? discoverLldbDap({ ...(options.adapterPath ? { explicitPath: options.adapterPath } : {}) })\n      : discoverCodeLldb({ ...(options.adapterPath ? { explicitPath: options.adapterPath } : {}) });",
  "    const adapter = adapterKind === 'gdb'\n      ? discoverGdbDap({ ...(options.adapterPath ? { explicitPath: options.adapterPath } : {}) })\n      : adapterKind === 'lldb-dap'\n      ? discoverLldbDap({ ...(options.adapterPath ? { explicitPath: options.adapterPath } : {}) })\n      : discoverCodeLldb({ ...(options.adapterPath ? { explicitPath: options.adapterPath } : {}) });",
);
replace(
  'src/tools/register-dump-tools.ts',
  "        command: adapter.command,\n        adapterId: adapterKind === 'lldb-dap' ? 'lldb-dap' : 'lldb',",
  "        command: adapter.command,\n        ...('args' in adapter ? { args: adapter.args } : {}),\n        adapterId: adapterKind === 'gdb' ? 'gdb' : adapterKind === 'lldb-dap' ? 'lldb-dap' : 'lldb',",
);
replace(
  'src/tools/register-dump-tools.ts',
  'Open a local native core/minidump with CodeLLDB or upstream LLVM lldb-dap and capture bounded postmortem evidence.',
  'Open a local native core/minidump with CodeLLDB, upstream LLVM lldb-dap, or GNU GDB DAP and capture bounded postmortem evidence.',
);
replace(
  'src/tools/register-dump-tools.ts',
  "program: z.string().min(1).optional().describe('Path to the matching executable image. Optional for CodeLLDB, but required when adapter=lldb-dap because LLVM coreFile loading binds the dump to its program image.'),",
  "program: z.string().min(1).optional().describe('Path to the matching executable image. Optional for CodeLLDB/GDB, but required when adapter=lldb-dap because LLVM coreFile loading binds the dump to its program image.'),",
);
replace(
  'src/tools/register-dump-tools.ts',
  "sourceMap: z.record(z.string(), z.string()).optional().describe('Optional mapping from source paths recorded in symbols to local source paths; converted to lldb-dap pair arrays when that adapter is selected.'),",
  "sourceMap: z.record(z.string(), z.string()).optional().describe('Optional mapping from source paths recorded in symbols to local source paths. Supported by CodeLLDB/lldb-dap; GDB currently rejects this field rather than guessing undocumented semantics.'),",
);
replace(
  'src/tools/register-dump-tools.ts',
  "adapter: z.enum(['codelldb', 'lldb-dap']).default('codelldb').describe('Debugger adapter used for postmortem inspection. codelldb preserves existing behavior; lldb-dap uses upstream LLVM coreFile attach semantics.'),",
  "adapter: z.enum(['codelldb', 'lldb-dap', 'gdb']).default('codelldb').describe('Debugger adapter used for postmortem inspection. lldb-dap and gdb use their native coreFile attach semantics.'),",
);

replace(
  'README.md',
  '- **Upstream LLVM lldb-dap integration** — first-class live debugging and core-file inspection without treating lldb-dap as a CodeLLDB alias.',
  '- **Upstream LLVM lldb-dap integration** — first-class live debugging and core-file inspection without treating lldb-dap as a CodeLLDB alias.\n- **GNU GDB DAP integration** — first-class GDB 14+ launch, attach, remote-target, and core-file support through `--interpreter=dap`.\n- **Runtime writer tracing** — `debug_find_writer` uses DAP data breakpoints/watchpoints to stop at the code that actually writes a suspicious value.',
);
replace(
  'README.md',
  'CodeLLDB and upstream LLVM `lldb-dap` are both first-class adapter paths. Existing CodeLLDB workflows remain supported; use `debug_this_crash(mode="lldb-dap")` when you want the debugger adapter shipped by LLVM itself.',
  'CodeLLDB, upstream LLVM `lldb-dap`, and GNU GDB DAP are first-class adapter paths. Existing CodeLLDB workflows remain supported; use `debug_this_crash(mode="lldb-dap")` for LLVM\'s adapter or `debug_this_crash(mode="gdb")` for GDB 14+.',
);
replace(
  'README.md',
  'Discovery supports an explicit `adapterPath`, `LLDB_DAP_PATH`, canonical or versioned PATH binaries, common LLVM toolchain directories / `LLVM_HOME`, and `xcrun --find lldb-dap` on macOS. See [docs/lldb-dap.md](docs/lldb-dap.md) for examples, postmortem behavior, and the manual full-toolset helpers.',
  'LLDB discovery supports an explicit `adapterPath`, `LLDB_DAP_PATH`, canonical/versioned PATH binaries, LLVM toolchain directories / `LLVM_HOME`, and `xcrun --find lldb-dap` on macOS. GDB discovery supports `adapterPath`, `GDB_DAP_PATH`, `GDB_PATH`, `GDB_HOME`, and PATH with a GDB 14+ version gate. See [docs/lldb-dap.md](docs/lldb-dap.md) and [docs/gdb-dap.md](docs/gdb-dap.md).',
);
replace(
  'README.md',
  'The default `agent` toolset deliberately exposes only the nine high-level tools below',
  'The default `agent` toolset deliberately exposes only the ten high-level tools below',
);
replace(
  'README.md',
  '| `debug_source_disassembly` | Fault correlation plus project-frame instruction/operand/register/local context |\n| `debug_run_to_stop` |',
  '| `debug_source_disassembly` | Fault correlation plus project-frame instruction/operand/register/local context |\n| `debug_find_writer` | Temporarily watch a suspicious value and stop at its immediate runtime writer |\n| `debug_run_to_stop` |',
);
replace(
  'README.md',
  'The `full` toolset additionally exposes manual breakpoint/watchpoint management, stepping, evaluation, threads/stacks/scopes/variables, modules, disassembly, bounded memory reads, exception controls, generic DAP launch/attach, and CodeLLDB / lldb-dap lifecycle primitives.',
  'The `full` toolset additionally exposes manual breakpoint/watchpoint management, stepping, evaluation, threads/stacks/scopes/variables, modules, disassembly, bounded memory reads, exception controls, generic DAP launch/attach, and CodeLLDB / lldb-dap / GDB lifecycle primitives.',
);

const roadmap = `## Roadmap\n\nThe roadmap is intentionally ordered around capabilities that make the bridge more useful to coding agents, not around exposing every debugger command. Planned scope may change as real adapter behavior and benchmark evidence improve.\n\n| Release | Focus | Planned capabilities |\n| --- | --- | --- |\n| **v0.14** | GNU debugger + runtime provenance | First-class GDB DAP, \`debug_find_writer\`, structured MCP results/output schemas, symbol-health reporting, real GDB Linux smoke coverage |\n| **v0.15** | Hangs and concurrency | \`debug_this_hang\`, bounded all-thread triage, deadlock/wait heuristics, pointer provenance v2, expanded Crash Lab |\n| **v0.16** | Remote/multi-session + evidence | hardened gdbserver/lldb-server workflows, multi-session architecture, existing LLDB-session interoperability where practical, cross-adapter benchmark matrix |\n\nNear-term design rule: keep the default agent surface compact and add high-level evidence workflows before adding raw debugger primitives.\n\n`;
replace('README.md', '## Autonomous crash debugging\n', `${roadmap}## Autonomous crash debugging\n`);

unlinkSync(new URL(import.meta.url));
