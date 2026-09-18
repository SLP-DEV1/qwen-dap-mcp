import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import {
  compareBinaryAndPdb,
  inspectBinaryIdentity,
  inspectPdbIdentity,
} from '../src/diagnostics/symbol-doctor.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const programArg = arg('--program');
const pdbArg = arg('--pdb');
if (!programArg || !pdbArg) {
  throw new Error('Usage: tsx test/symbol-doctor-windows-real-smoke.ts --program <exe> --pdb <pdb>');
}

const binary = inspectBinaryIdentity(resolve(programArg));
const pdb = inspectPdbIdentity(resolve(pdbArg));
assert.equal(binary.format, 'pe', JSON.stringify(binary));
assert.ok(binary.pdb?.guid, 'PE CodeView identity did not expose a PDB GUID');
assert.ok(pdb.guid, 'PDB identity did not expose a GUID');
const comparison = compareBinaryAndPdb(binary, pdb);
assert.equal(comparison.comparable, true, JSON.stringify(comparison));
assert.equal(comparison.match, true, JSON.stringify(comparison));

console.log(JSON.stringify({ ok: true, binary, pdb, comparison }, null, 2));
