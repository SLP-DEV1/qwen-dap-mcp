#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { logger } from './logger.js';
import { createServer } from './server.js';

const serving = serveStdio(createServer);
void serving.catch((error: unknown) => {
  logger.error('MCP stdio server failed', {
    error: error instanceof Error ? error : new Error(String(error)),
  });
  process.exitCode = 1;
});
logger.info('MCP server ready on stdio');
