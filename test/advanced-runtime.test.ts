import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeSnapshot } from '../src/dap/session.js';
import {
  analyzeAbiArguments,
  buildCrashReport,
  clusterCrashReports,
  detectMemoryHazards,
  parseSanitizerEvidence,
  regressionOracle,
} from '../src/tools/advanced-runtime.js';

function snapshot(): RuntimeSnapshot {
  return {
    thread: { id: 7, name: 'main' },
    stack: [
      {
        id: 1,
        name: 'memcpy',
        line: 44,
        column: 1,
        source: { name: 'copy.cpp', path: '/workspace/copy.cpp' },
        instructionPointerReference: '0x401000',
      },
      {
        id: 2,
        name: 'copyPixels',
        line: 91,
        column: 1,
        source: { name: 'texture.cpp', path: '/workspace/texture.cpp' },
      },
    ],
    frame: {
      id: 1,
      name: 'memcpy',
      line: 44,
      column: 1,
      source: { name: 'copy.cpp', path: '/workspace/copy.cpp' },
      instructionPointerReference: '0x401000',
    },
    scopes: [],
    locals: [
      { name: 'ptr', value: '0xFEEEFEEE', type: 'Widget *', variablesReference: 0 },
    ],
    registers: [
      { name: 'rcx', value: '0x0', variablesReference: 0 },
      { name: 'rdx', value: '0x1234', variablesReference: 0 },
      { name: 'r8', value: '0x100', variablesReference: 0 },
      { name: 'r9', value: '0x0', variablesReference: 0 },
    ],
    symbolHealth: {
      status: 'partial',
      summary: 'Some frames are source mapped.',
      stack: {
        totalFrames: 2,
        namedFrames: 2,
        sourceMappedFrames: 2,
        topFrameNamed: true,
        topFrameSourceMapped: true,
      },
      modules: {
        collected: false,
        totalModules: 0,
        withExplicitStatus: 0,
        symbolsAvailable: 0,
        symbolsMissing: 0,
        symbolsUnknown: 0,
      },
      limitations: ['Modules were not collected.'],
    },
    stopped: { reason: 'exception', threadId: 7 },
    exception: { exceptionId: 'SIGSEGV', breakMode: 'unhandled', description: 'segmentation fault' },
  };
}

test('ABI analysis maps Windows x64 argument registers without inventing parameter names', () => {
  const abi = analyzeAbiArguments(snapshot(), 'windows-x64');
  assert.equal(abi.abi, 'windows-x64');
  assert.deepEqual(
    abi.arguments.map((entry) => [entry.register, entry.value]),
    [['rcx', '0x0'], ['rdx', '0x1234'], ['r8', '0x100'], ['r9', '0x0']],
  );
});

test('sanitizer parser recognizes bounded runtime sanitizer evidence', () => {
  const findings = parseSanitizerEvidence([
    'noise',
    '==42==ERROR: AddressSanitizer: heap-use-after-free on address 0x1234',
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.sanitizer, 'asan');
  assert.match(String(findings[0]?.summary), /heap-use-after-free/i);
});

test('memory hazard detector surfaces poison patterns conservatively', () => {
  const findings = detectMemoryHazards(snapshot());
  assert.ok(findings.some((finding) => finding.kind === 'freed-heap-pattern'));
});

test('runtime report creates stable normalized fingerprints and correlates output', () => {
  const status = {
    adapterRunning: true,
    initialized: true,
    configured: true,
    recentEvents: [
      { receivedAt: new Date(0).toISOString(), event: 'output', body: { output: 'runtime error: signed integer overflow\n' } },
    ],
    recentAdapterStderr: [],
  };
  const first = buildCrashReport(snapshot(), status as never, { redactPaths: true, abi: 'windows-x64' });
  const second = buildCrashReport(snapshot(), status as never, { redactPaths: true, abi: 'windows-x64' });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.match(first.frameKey, /<path>/);
  assert.ok(first.sanitizer.some((finding) => finding.sanitizer === 'ubsan'));
  assert.equal(first.symbolDoctor.status, 'partial');
});

test('crash clustering orders the dominant fingerprint first', () => {
  const result = clusterCrashReports([
    { fingerprint: 'a' },
    { fingerprint: 'b' },
    { fingerprint: 'a' },
  ]);
  assert.equal(result.totalReports, 3);
  assert.equal(result.clusters[0]?.fingerprint, 'a');
  assert.equal(result.clusters[0]?.count, 2);
});

test('regression oracle never labels a changed crash as good', () => {
  assert.equal(regressionOracle('same', 'same', true).verdict, 'original-crash');
  assert.equal(regressionOracle('different', 'same', true).verdict, 'changed-crash');
  assert.equal(regressionOracle('different', 'same', false).verdict, 'inconclusive');
});
