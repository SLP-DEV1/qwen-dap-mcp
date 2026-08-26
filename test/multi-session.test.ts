import assert from 'node:assert/strict';
import test from 'node:test';
import * as z from 'zod/v4';

import { DapSessionRegistry } from '../src/dap/session-registry.js';
import { routeSessionToolRegistrar } from '../src/tools/session-routing.js';
import { toolsetAllows } from '../src/toolset.js';

test('DAP session registry keeps guarded session state isolated', async () => {
  const registry = new DapSessionRegistry({ maxSessions: 4 });
  const alpha = registry.create('alpha').session;
  const beta = registry.create('beta').session;
  const routed = registry.createRoutedSession();

  await registry.runWithSession('alpha', async () => {
    assert.equal(registry.currentSessionId(), 'alpha');
    routed.markPostmortem();
    await Promise.resolve();
    assert.equal(routed.isPostmortem(), true);
  });

  assert.equal(alpha.isPostmortem(), true);
  assert.equal(beta.isPostmortem(), false);
  assert.equal(registry.get().isPostmortem(), false);
});

test('request-local routing remains isolated across concurrent async calls', async () => {
  const registry = new DapSessionRegistry({ maxSessions: 4 });
  registry.create('alpha');
  registry.create('beta');
  const routed = registry.createRoutedSession();

  let releaseAlpha!: () => void;
  const alphaGate = new Promise<void>((resolve) => { releaseAlpha = resolve; });

  const alphaTask = registry.runWithSession('alpha', async () => {
    routed.markPostmortem();
    await alphaGate;
    assert.equal(registry.currentSessionId(), 'alpha');
    assert.equal(routed.isPostmortem(), true);
  });

  const betaTask = registry.runWithSession('beta', async () => {
    assert.equal(registry.currentSessionId(), 'beta');
    assert.equal(routed.isPostmortem(), false);
    assert.equal(registry.activeRequests('alpha'), 1);
    assert.equal(registry.activeRequests('beta'), 1);
    releaseAlpha();
  });

  await Promise.all([alphaTask, betaTask]);
  assert.equal(registry.activeRequests('alpha'), 0);
  assert.equal(registry.activeRequests('beta'), 0);
  assert.equal(registry.get('alpha').isPostmortem(), true);
  assert.equal(registry.get('beta').isPostmortem(), false);
});

test('registry refuses to close a session while a routed request is active', async () => {
  const registry = new DapSessionRegistry({ maxSessions: 3 });
  registry.create('alpha');

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const active = registry.runWithSession('alpha', async () => {
    await gate;
  });

  assert.equal(registry.list().find((entry) => entry.sessionId === 'alpha')?.activeRequests, 1);
  await assert.rejects(
    registry.close('alpha'),
    /Cannot close DAP session 'alpha' while 1 routed debug request is still active/,
  );
  assert.equal(registry.has('alpha'), true);

  release();
  await active;
  assert.equal(registry.activeRequests('alpha'), 0);
  assert.deepEqual(await registry.close('alpha'), { sessionId: 'alpha', removed: true });
});

test('registry bounds session count, validates IDs, and keeps default slot stable', async () => {
  const registry = new DapSessionRegistry({ maxSessions: 2 });
  assert.equal(registry.list().length, 1);

  const created = registry.create();
  assert.equal(created.sessionId, 'session-1');
  assert.throws(() => registry.create('third'), /limit of 2 sessions/i);

  const closed = await registry.close(created.sessionId);
  assert.deepEqual(closed, { sessionId: 'session-1', removed: true });
  assert.equal(registry.has('session-1'), false);

  assert.throws(() => registry.create('../bad'), /Invalid DAP session ID/);
  const defaultClosed = await registry.close('default');
  assert.deepEqual(defaultClosed, { sessionId: 'default', removed: false });
  assert.equal(registry.has('default'), true);
});

test('session routing registrar adds sessionId and strips it before invoking handlers', async () => {
  const registry = new DapSessionRegistry({ maxSessions: 3 });
  registry.create('alpha');
  const routedSession = registry.createRoutedSession();

  let registeredConfig: any;
  let registeredHandler: ((args: unknown) => Promise<unknown>) | undefined;
  const registrar = {
    registerTool(_name: string, config: unknown, handler: (args: unknown) => Promise<unknown>) {
      registeredConfig = config;
      registeredHandler = handler;
      return {};
    },
  };

  const routedRegistrar = routeSessionToolRegistrar(registrar, registry);
  routedRegistrar.registerTool(
    'debug_fake',
    { inputSchema: z.object({ value: z.string() }) },
    async (args: { value: string }) => {
      assert.deepEqual(args, { value: 'ok' });
      routedSession.markPostmortem();
      return registry.currentSessionId();
    },
  );

  const parsed = registeredConfig.inputSchema.parse({ value: 'ok', sessionId: 'alpha' });
  assert.deepEqual(parsed, { value: 'ok', sessionId: 'alpha' });
  assert.ok(registeredHandler);
  assert.equal(await registeredHandler(parsed), 'alpha');
  assert.equal(registry.get('alpha').isPostmortem(), true);
  assert.equal(registry.get('default').isPostmortem(), false);
});

test('unknown session IDs fail before a routed tool handler can run', async () => {
  const registry = new DapSessionRegistry();
  let invoked = false;
  let handler: ((args: unknown) => Promise<unknown>) | undefined;
  const registrar = {
    registerTool(_name: string, _config: unknown, registered: (args: unknown) => Promise<unknown>) {
      handler = registered;
      return {};
    },
  };

  routeSessionToolRegistrar(registrar, registry).registerTool(
    'debug_fake',
    { inputSchema: z.object({}) },
    async () => {
      invoked = true;
    },
  );

  assert.ok(handler);
  await assert.rejects(handler({ sessionId: 'missing' }), /Unknown DAP session 'missing'/);
  assert.equal(invoked, false);
});

test('debug_sessions is part of the compact agent toolset', () => {
  assert.equal(toolsetAllows('agent', 'debug_sessions'), true);
});
