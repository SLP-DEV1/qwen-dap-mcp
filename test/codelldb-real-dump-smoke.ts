import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';

import { buildCodeLldbDumpConfiguration } from '../src/adapters/codelldb-dump.js';
import { DapSession } from '../src/dap/session.js';
import { analyzeRuntimeSnapshot } from '../src/diagnostics/analyze-snapshot.js';
import { startAutonomousCycle } from '../src/diagnostics/autonomous-cycle.js';
import {
  buildIntelligentDiagnosis,
  selectProjectFrame,
  type FrameEvidence,
} from '../src/diagnostics/intelligent-diagnosis.js';

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing required argument ${name}`);
  return resolve(value);
}

const adapter = arg('--adapter');
const program = arg('--program');
const dumpPath = arg('--dump');
const source = arg('--source');

const session = new DapSession();

try {
  const capabilities = await session.start({
    command: adapter,
    adapterId: 'lldb',
    requestTimeoutMs: 45_000,
  });

  const attach = await session.attach(
    buildCodeLldbDumpConfiguration({ dumpPath, program }),
  );
  assert.equal((attach as { request?: string }).request, 'attach');

  const threads = await session.threads();
  assert.ok(threads.length > 0, 'Expected at least one thread in the crash dump');

  let selectedThread = threads[0];
  let selectedStack = selectedThread
    ? await session.stackTrace(selectedThread.id, 0, 40)
    : [];

  for (const thread of threads) {
    const stack = await session.stackTrace(thread.id, 0, 40);
    if (
      stack.some(
        (frame) =>
          /crash_here/i.test(frame.name) ||
          frame.source?.path?.toLowerCase() === source.toLowerCase(),
      )
    ) {
      selectedThread = thread;
      selectedStack = stack;
      break;
    }
  }

  assert.ok(selectedThread, 'Unable to select a dump thread');
  assert.ok(selectedStack.length > 0, 'Expected a stack trace from the dump');

  const projectFrame = selectedStack.find(
    (frame) =>
      /crash_here/i.test(frame.name) ||
      frame.source?.path?.toLowerCase() === source.toLowerCase(),
  );
  assert.ok(projectFrame, 'Expected the dump stack to resolve the native-dump.cpp crash frame');
  assert.ok(projectFrame.instructionPointerReference, 'Expected an instruction pointer for the crash frame');

  const scopes = await session.scopes(projectFrame.id);
  const localScopes = scopes.filter((scope) => /locals?|arguments?|parameters?/i.test(scope.name));
  const registerScope = scopes.find((scope) => /register/i.test(scope.name));
  const locals = [];
  for (const scope of localScopes.slice(0, 3)) {
    if (scope.variablesReference > 0) {
      locals.push(...await session.variables(scope.variablesReference, 0, 100));
    }
  }
  const registers = registerScope && registerScope.variablesReference > 0
    ? await session.variables(registerScope.variablesReference, 0, 100)
    : [];

  const modules = capabilities.supportsModulesRequest
    ? await session.modules(0, 100)
    : [];
  assert.ok(modules.length > 0, 'Expected modules from the crash dump');

  const disassembly =
    capabilities.supportsDisassembleRequest && projectFrame.instructionPointerReference
      ? await session.disassemble(projectFrame.instructionPointerReference, 9, -4, 0, true)
      : [];
  assert.ok(disassembly.length > 0, 'Expected disassembly around the crash instruction');

  const snapshot = await session.runtimeSnapshot({
    threadId: selectedThread.id,
    stackLevels: 30,
    maxVariablesPerScope: 100,
    includeModules: true,
    moduleCount: 100,
    includeDisassembly: true,
    includeExceptionInfo: true,
  });

  assert.ok(snapshot.stack.length > 0);
  assert.ok(snapshot.modules && snapshot.modules.length > 0);

  const frameSelection = selectProjectFrame(snapshot.stack, {
    projectRoots: [dirname(source)],
    program,
    callerDepth: 2,
  });
  assert.equal(
    frameSelection.selected.frame.source?.path?.toLowerCase(),
    source.toLowerCase(),
    'Expected intelligent frame selection to choose the project crash frame from the real dump',
  );
  assert.equal(frameSelection.selected.projectControlled, true);
  assert.equal(frameSelection.selected.confidence, 'high');

  const selectedIndex = frameSelection.selected.index;
  const selectedEvidence: FrameEvidence = {
    index: selectedIndex,
    frame: frameSelection.selected.frame,
    locals,
    registers,
    disassembly,
  };
  const intelligentDiagnosis = buildIntelligentDiagnosis(
    snapshot,
    analyzeRuntimeSnapshot(snapshot),
    frameSelection,
    [selectedEvidence],
  );

  assert.equal(intelligentDiagnosis.projectFrame.sourcePath?.toLowerCase(), source.toLowerCase());
  assert.equal(intelligentDiagnosis.projectFrame.confidence, 'high');
  assert.equal(intelligentDiagnosis.fixWorkflow.status, 'proposal-only');
  assert.equal(intelligentDiagnosis.verificationBaseline.projectFunction, intelligentDiagnosis.projectFrame.function);
  assert.ok(
    intelligentDiagnosis.fixWorkflow.phases.some((phase) => phase.phase === 'verify'),
    'Expected the intelligent diagnosis to include the verification phase',
  );

  const autonomous = startAutonomousCycle(intelligentDiagnosis, 3);
  assert.equal(autonomous.state.schemaVersion, 1);
  assert.equal(autonomous.state.iteration, 1);
  assert.equal(autonomous.state.maxIterations, 3);
  assert.equal(autonomous.state.rootFingerprint, autonomous.state.activeFingerprint);
  assert.equal(autonomous.state.history[0]?.phase, 'diagnosis');
  assert.equal(autonomous.shouldContinue, true);
  assert.ok(
    autonomous.state.status === 'needs-fix' || autonomous.state.status === 'needs-evidence',
    `Expected a bounded autonomous next state from the real dump, got ${autonomous.state.status}`,
  );
  assert.ok(autonomous.nextActions.length > 0, 'Expected an autonomous next-action decision from the real dump');

  console.log('CodeLLDB crash-dump smoke: PASS');
  console.log(`threads: ${threads.length}`);
  console.log(`selected thread: ${selectedThread.id} ${selectedThread.name}`);
  console.log(`project frame: ${projectFrame.name}`);
  console.log(`source: ${projectFrame.source?.path ?? '<none>'}:${projectFrame.line}`);
  console.log(`frame index: ${frameSelection.selected.index}`);
  console.log(`frame confidence: ${frameSelection.selected.confidence}`);
  console.log(`autonomous fingerprint: ${autonomous.state.rootFingerprint}`);
  console.log(`autonomous status: ${autonomous.state.status}`);
  console.log(`instruction pointer: ${projectFrame.instructionPointerReference}`);
  console.log(`locals: ${locals.map((variable) => `${variable.name}=${variable.value}`).join(', ')}`);
  console.log(`modules: ${modules.length}`);
  console.log(`disassembly: ${disassembly.length} instructions`);
  console.log(`snapshot registers: ${snapshot.registers.length}`);
  if (snapshot.exception) {
    console.log(`exception: ${snapshot.exception.exceptionId} (${snapshot.exception.description ?? 'no description'})`);
  }
} finally {
  await session.disconnect(false);
}
