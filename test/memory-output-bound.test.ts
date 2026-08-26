import assert from 'node:assert/strict';
import test from 'node:test';

import { formatMemoryResult } from '../src/tools/register-debug-tools.js';

test('memory rendering preserves bounded data and adds hexadecimal output', () => {
  const result = formatMemoryResult({
    address: '0x1000',
    data: Buffer.from([0x90, 0xcc]).toString('base64'),
  }, 2);

  assert.equal(result.hex, '90 cc');
});

test('memory rendering rejects adapter responses larger than the requested byte count', () => {
  assert.throws(
    () => formatMemoryResult({ data: Buffer.alloc(5, 0xaa).toString('base64') }, 4),
    /exceeding the requested 4-byte bound/i,
  );
});

test('memory rendering rejects malformed base64 instead of silently decoding garbage', () => {
  assert.throws(
    () => formatMemoryResult({ data: '%%%not-base64%%%' }, 16),
    /malformed base64/i,
  );
});
