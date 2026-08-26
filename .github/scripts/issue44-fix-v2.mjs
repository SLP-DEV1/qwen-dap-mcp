import { readFileSync, writeFileSync } from 'node:fs';

function read(path) { return readFileSync(path, 'utf8'); }
function write(path, value) { writeFileSync(path, value, 'utf8'); }

// Make every remaining bounded framing error use the same fatal transport path.
{
  const path = 'src/dap/connection.ts';
  let text = read(path);
  const oldValue = "        this.buffer = Buffer.alloc(0);\n        logger.warn('DAP protocol error', { error });\n        this.rejectAll(error);\n        this.emit('protocolError', error);";
  while (text.includes(oldValue)) {
    text = text.replace(oldValue, "        this.failProtocol(error);");
  }
  text = text.replace(
    "    void this.stop().catch((stopError) => {\n      logger.warn('Failed while retiring DAP adapter after protocol error', { error: stopError });\n    });",
    "    // Production adapters are ChildProcess instances. The runtime guard also\n    // keeps parser unit-test doubles from turning transport retirement into noise.\n    if (typeof this.child?.kill === 'function') {\n      void this.stop().catch((stopError) => {\n        logger.warn('Failed while retiring DAP adapter after protocol error', { error: stopError });\n      });\n    } else {\n      this.child = undefined;\n    }",
  );
  write(path, text);
}

// The early-initialized regression must wait for the event instead of assuming
// the child process has flushed it by the exact microtask after start().
{
  const path = 'test/dap-session.test.ts';
  let text = read(path);
  const oldValue = "  assert.ok(\n    session.snapshot().recentEvents.some((event) => event.event === 'initialized'),\n    'mock adapter should emit initialized before launch',\n  );";
  const newValue = "  await session.connection.waitForEvent('initialized', 2_000, undefined, true);\n  assert.ok(\n    session.snapshot().recentEvents.some((event) => event.event === 'initialized'),\n    'mock adapter should emit initialized before launch',\n  );";
  if (!text.includes(oldValue)) throw new Error('Missing early-initialized regression anchor');
  text = text.replace(oldValue, newValue);
  write(path, text);
}
