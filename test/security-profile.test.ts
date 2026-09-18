import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDapPolicyMode } from '../src/dap/request-policy.js';
import { resolveSecurityProfile, securityProfileDefaults } from '../src/security-profile.js';
import { resolveToolsetMode } from '../src/toolset.js';

test('security profiles expose conservative composed defaults', () => {
  assert.equal(resolveSecurityProfile('inspect'), 'inspect');
  assert.equal(securityProfileDefaults('inspect').dapPolicy, 'inspect-only');
  assert.equal(securityProfileDefaults('inspect').toolset, 'agent');
  assert.equal(securityProfileDefaults('advanced').toolset, 'forensics');
  assert.equal(securityProfileDefaults('local-debug').dapPolicy, 'standard');
});

test('profile defaults apply only when explicit toolset/DAP policy is absent', () => {
  const previous = process.env.QWEN_DAP_MCP_PROFILE;
  try {
    process.env.QWEN_DAP_MCP_PROFILE = 'inspect';
    assert.equal(resolveToolsetMode(undefined), 'agent');
    assert.equal(resolveDapPolicyMode(undefined), 'inspect-only');
    assert.equal(resolveToolsetMode('full'), 'full');
    assert.equal(resolveDapPolicyMode('standard'), 'standard');
  } finally {
    if (previous === undefined) delete process.env.QWEN_DAP_MCP_PROFILE;
    else process.env.QWEN_DAP_MCP_PROFILE = previous;
  }
});
