import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { GuardedDapSession } from '../src/dap/guarded-session.js';
import { registerAgentDiagnosticTools } from '../src/tools/agent-diagnostics.js';

type ToolResult = {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const programArg = arg('--program');
const sourceArg = arg('--source');

if (!programArg || !sourceArg) {
  throw new Error('Usage: tsx test/lldb-dap-high-level-smoke.ts --program <exe> --source <cpp>');
}

const program = resolve(programArg);
const source = resolve(sourceArg);
const session = new GuardedDapSession();
let debugThisCrash: ToolHandler | undefined;

const server = {
  registerTool(
    name: string,
    _definition: unknown,
    handler: ToolHandler,
  ) {
    if (name === 'debug_this_crash') debugThisCrash = handler;
  },
};

registerAgentDiagnosticTools(server as never, session);
assert.ok(debugThisCrash, 'debug_this_crash handler was not registered');

try {
  const response = await debugThisCrash({
    mode: 'lldb-dap',
    request: 'launch',
    program,
    timeoutMs: 30_000,
    requestTimeoutMs: 30_000,
    stopOnEntry: false,
    snapshot: {
      stackLevels: 20,
      maxVariablesPerScope: 100,
      includeDisassembly: true,
      includeModules: true,
      moduleCount: 100,
      includeExceptionInfo: true,
    },
    analysis: {
      projectRoots: [resolve('.')],
      projectModules: ['lldb-dap-crash'],
      callerDepth: 3,
    },
    workflow: {
      stage: 'diagnose',
    },
  });

  assert.equal(response.isError, undefined, `debug_this_crash returned an MCP error: ${JSON.stringify(response)}`);
  const text = response.content?.find((item) => item.type === 'text')?.text;
  assert.ok(text, 'debug_this_crash returned no JSON text payload');

  const payload = JSON.parse(text) as {
    mode?: string;
    adapter?: { command?: string; source?: string };
    run?: {
      snapshot?: {
        frame?: { name?: string; source?: { path?: string }; line?: number };
        stack?: Array<{ name?: string; source?: { path?: string }; line?: number }>;
      };
      outcome?: { event?: string; body?: { reason?: string; description?: string } };
    };
    diagnosis?: {
      classification?: { category?: string; crashLikely?: boolean; confidence?: string };
      projectFrame?: { frame?: { name?: string; source?: { path?: string }; line?: number } };
      verificationBaseline?: unknown;
      hypotheses?: unknown[];
    };
    workflow?: {
      stage?: string;
      verificationBaseline?: unknown;
    };
    status?: { postmortem?: boolean };
  };

  assert.equal(payload.mode, 'lldb-dap');
  assert.ok(payload.adapter?.command?.includes('lldb-dap'), `Unexpected adapter: ${JSON.stringify(payload.adapter)}`);
  assert.ok(payload.run?.snapshot, `Expected a stopped-state snapshot: ${JSON.stringify(payload.run?.outcome)}`);
  assert.equal(payload.diagnosis?.classification?.crashLikely, true, `Expected a crash-like diagnosis: ${JSON.stringify(payload.diagnosis?.classification)}`);
  assert.ok(
    ['segmentation-fault', 'access-violation', 'signal', 'exception'].includes(payload.diagnosis?.classification?.category ?? ''),
    `Unexpected crash classification: ${JSON.stringify(payload.diagnosis?.classification)}`,
  );
  assert.equal(payload.workflow?.stage, 'diagnose');
  assert.ok(payload.workflow?.verificationBaseline, 'High-level workflow did not return a verification baseline');
  assert.equal(payload.status?.postmortem, false);

  const stack = payload.run.snapshot.stack ?? [];
  const projectFrame = payload.diagnosis?.projectFrame?.frame;
  assert.ok(
    /crash_now|main/i.test(projectFrame?.name ?? '') || stack.some((frame) => /crash_now|main/i.test(frame.name ?? '')),
    `Expected project crash frame in diagnosis/stack: ${JSON.stringify({ projectFrame, stack })}`,
  );
  assert.ok(
    projectFrame?.source?.path?.endsWith('lldb-dap-crash.cpp')
      || stack.some((frame) => frame.source?.path?.endsWith('lldb-dap-crash.cpp')),
    `Expected source attribution to ${source}`,
  );

  console.log(JSON.stringify({
    ok: true,
    adapter: payload.adapter,
    classification: payload.diagnosis?.classification,
    projectFrame,
    topFrame: payload.run.snapshot.frame,
    workflow: {
      stage: payload.workflow?.stage,
      hasVerificationBaseline: Boolean(payload.workflow?.verificationBaseline),
    },
  }, null, 2));
} finally {
  await session.reset();
}
