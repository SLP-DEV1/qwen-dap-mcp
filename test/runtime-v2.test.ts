import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeSnapshot } from '../src/dap/session.js';
import {
  analyzeKnownApiCall,
  analyzeStackIntegrity,
  buildBreakpointPlan,
  buildFailureHypotheses,
  buildLockOwnerGraph,
  compareCrashFamilies,
  crashFingerprintsV2,
  type ThreadTimelineObservation,
} from '../src/diagnostics/runtime-v2.js';

function snapshot(): RuntimeSnapshot {
  return {
    thread: { id: 1, name: 'main' },
    stack: [
      {
        id: 10,
        name: 'memcpy',
        line: 42,
        column: 1,
        source: { name: 'copy.cpp', path: '/workspace/src/copy.cpp' },
        instructionPointerReference: '0x1100',
      },
      {
        id: 11,
        name: 'Renderer::copyPixels',
        line: 88,
        column: 1,
        source: { name: 'renderer.cpp', path: '/workspace/src/renderer.cpp' },
        instructionPointerReference: '0x1200',
      },
    ],
    frame: {
      id: 10,
      name: 'memcpy',
      line: 42,
      column: 1,
      source: { name: 'copy.cpp', path: '/workspace/src/copy.cpp' },
      instructionPointerReference: '0x1100',
    },
    scopes: [],
    locals: [
      { name: 'player', value: '0xFEEEFEEE', type: 'Player *', variablesReference: 0, evaluateName: 'player' },
      { name: 'dst', value: '0x0', type: 'void *', variablesReference: 0 },
    ],
    registers: [
      { name: 'rcx', value: '0x0', variablesReference: 0 },
      { name: 'rdx', value: '0x2200', variablesReference: 0 },
      { name: 'r8', value: '0x40', variablesReference: 0 },
      { name: 'r9', value: '0x0', variablesReference: 0 },
      { name: 'rsp', value: '0x3000', variablesReference: 0 },
    ],
    modules: [
      { id: 'app', name: 'app.exe', path: '/workspace/app.exe', addressRange: '0x1000-0x2000', symbolStatus: 'Symbols loaded' },
    ],
    symbolHealth: {
      status: 'good',
      summary: 'good',
      stack: {
        totalFrames: 2,
        namedFrames: 2,
        sourceMappedFrames: 2,
        topFrameNamed: true,
        topFrameSourceMapped: true,
      },
      modules: {
        collected: true,
        totalModules: 1,
        withExplicitStatus: 1,
        symbolsAvailable: 1,
        symbolsMissing: 0,
        symbolsUnknown: 0,
      },
      limitations: [],
    },
    stopped: { reason: 'exception', threadId: 1 },
    exception: { exceptionId: 'SIGSEGV', description: 'segmentation fault', breakMode: 'unhandled' },
  };
}

test('v2 semantic and family fingerprints survive source-root relocation', () => {
  const first = snapshot();
  const second = snapshot();
  second.stack[0]!.source!.path = 'C:\\agent\\build\\copy.cpp';
  second.stack[1]!.source!.path = 'C:\\agent\\build\\renderer.cpp';
  second.frame.source!.path = 'C:\\agent\\build\\copy.cpp';

  const a = crashFingerprintsV2(first, []);
  const b = crashFingerprintsV2(second, []);
  assert.equal(a.semantic, b.semantic);
  assert.equal(a.family, b.family);
  assert.equal(a.exact, b.exact);
});

test('known memcpy analysis maps ABI carriers and flags null destination', () => {
  const result = analyzeKnownApiCall(snapshot(), [
    { index: 1, register: 'rcx', value: '0x0' },
    { index: 2, register: 'rdx', value: '0x2200' },
    { index: 3, register: 'r8', value: '0x40' },
  ]);
  assert.equal(result.recognized, true);
  assert.ok('risks' in result && result.risks.some((risk) => risk.kind === 'null-destination'));
});

test('hypothesis engine favors strong sanitizer UAF evidence without calling score probability', () => {
  const snap = snapshot();
  const hypotheses = buildFailureHypotheses({
    snapshot: snap,
    outputLines: ['ERROR: AddressSanitizer: heap-use-after-free on address 0x1234'],
    memoryHazards: [{ kind: 'freed-heap-pattern', variable: 'player', value: '0xFEEEFEEE' }],
  });
  const uaf = hypotheses.find((candidate) => candidate.id === 'use-after-free');
  assert.ok(uaf);
  assert.ok(uaf.evidenceScore >= 70);
  assert.ok(uaf.supporting.some((item) => item.source === 'sanitizer'));

  const plan = buildBreakpointPlan(hypotheses, snap);
  assert.ok(plan.functionBreakpoints.some((entry) => /delete|free/.test(entry.function)));
});

test('stack integrity surfaces out-of-module instruction pointers conservatively', () => {
  const snap = snapshot();
  snap.stack.push({
    id: 12,
    name: 'garbage',
    line: 0,
    column: 0,
    instructionPointerReference: '0x999999',
  });
  const result = analyzeStackIntegrity(snap, []);
  assert.ok(result.findings.some((finding) => finding.kind === 'instruction-pointer-outside-known-modules'));
});

test('lock-owner graph marks a cycle proven only from explicit owner thread ids', () => {
  const observations: ThreadTimelineObservation[] = [
    {
      sample: 1,
      threadId: 1,
      threadName: 't1',
      waitKind: 'lock',
      resources: [{ name: 'mutexA', value: '0xA', ownerThreadId: 2, ownerEvidence: 'ownerTid=2' }],
    },
    {
      sample: 1,
      threadId: 2,
      threadName: 't2',
      waitKind: 'lock',
      resources: [{ name: 'mutexB', value: '0xB', ownerThreadId: 1, ownerEvidence: 'ownerTid=1' }],
    },
  ];
  const graph = buildLockOwnerGraph(observations);
  assert.equal(graph.cycleProven, true);
  assert.equal(graph.cycle.length, 2);

  const withoutOwners = buildLockOwnerGraph(observations.map((item) => ({
    ...item,
    resources: item.resources.map(({ name, value }) => ({ name, value })),
  })));
  assert.equal(withoutOwners.cycleProven, false);
});

test('crash-family comparison keeps semantic/exact variants visible inside a family', () => {
  const result = compareCrashFamilies([
    { label: 'a', fingerprintsV2: { family: 'family', semantic: 's1', exact: 'e1' } },
    { label: 'b', fingerprintsV2: { family: 'family', semantic: 's2', exact: 'e2' } },
  ]);
  assert.equal(result.families.length, 1);
  assert.equal(result.families[0]?.count, 2);
  assert.equal(result.families[0]?.semanticVariants, 2);
});
