import assert from 'node:assert/strict';
import test from 'node:test';

import { adapterDoctorGuidance } from '../src/server.js';

test('compact agent guidance avoids instructing invocation of unavailable adapter doctor', () => {
  const guidance = adapterDoctorGuidance('agent');
  assert.match(guidance, /use debug_status/);
  assert.match(guidance, /QWEN_DAP_MCP_TOOLSET=forensics/);
  assert.doesNotMatch(guidance, /^Use debug_adapter_doctor/);
});

test('forensics and full toolsets advertise the adapter doctor directly', () => {
  for (const mode of ['forensics', 'full'] as const) {
    assert.match(adapterDoctorGuidance(mode), /^Use debug_adapter_doctor/);
  }
});
