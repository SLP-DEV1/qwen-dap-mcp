#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { logger } from './logger.js';
import { createServer } from './server.js';

const handle = serveStdio(createServer, {
  onerror(error) {
    logger.error('MCP stdio server error', { error });
  },
});

let closing = false;
const close = (signal: NodeJS.Signals) => {
  if (closing) return;
  closing = true;
  logger.info('Closing MCP stdio server', { signal });
  void handle.close().catch((error: unknown) => {
    logger.error('Failed to close MCP stdio server cleanly', {
      error: error instanceof Error ? error : new Error(String(error)),
    });
    process.exitCode = 1;
  });
};

process.once('SIGINT', () => close('SIGINT'));
process.once('SIGTERM', () => close('SIGTERM'));
logger.info('MCP server ready on stdio');
