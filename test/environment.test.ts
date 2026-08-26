import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeEnvironment, normalizeEnvironmentOverrides } from '../src/dap/environment.js';

test('Windows environment overrides fold Path/PATH/path onto the existing canonical key', () => {
  const base = { Path: 'C:\\Windows\\System32', HOME: 'C:\\Users\\fixture' };
  const overrides = {
    PATH: 'C:\\tools',
    path: 'C:\\final-tools',
    EXTRA: '1',
  };

  const normalized = normalizeEnvironmentOverrides(overrides, base, 'win32');
  assert.deepEqual(normalized, {
    Path: 'C:\\final-tools',
    EXTRA: '1',
  });

  const merged = mergeEnvironment(base, overrides, 'win32');
  assert.equal(merged.Path, 'C:\\final-tools');
  assert.equal(merged.PATH, undefined);
  assert.equal(merged.path, undefined);
  assert.equal(merged.EXTRA, '1');
});

test('POSIX environment overrides remain case-sensitive', () => {
  const merged = mergeEnvironment({ PATH: '/usr/bin' }, { Path: '/custom' }, 'linux');
  assert.equal(merged.PATH, '/usr/bin');
  assert.equal(merged.Path, '/custom');
});
