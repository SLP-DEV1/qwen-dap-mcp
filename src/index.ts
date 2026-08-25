#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createServer } from './server.js';

void serveStdio(createServer);
console.error('[qwen-dap-mcp] MCP server ready on stdio');
