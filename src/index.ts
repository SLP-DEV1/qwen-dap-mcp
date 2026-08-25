#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { logger } from './logger.js';
import { createServer } from './server.js';

void serveStdio(createServer);
logger.info('MCP server ready on stdio');
