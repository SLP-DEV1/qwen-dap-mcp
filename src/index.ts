#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { logger } from './logger.js';
import { createServer } from './server.js';
import { packageVersion } from './version.js';

const args = new Set(process.argv.slice(2));

if (args.has('--version') || args.has('-v')) {
  process.stdout.write(`${packageVersion}\n`);
} else if (args.has('--help') || args.has('-h')) {
  process.stdout.write(`qwen-dap-mcp ${packageVersion}\n\n`);
  process.stdout.write('Native runtime debugging for coding agents through a local DAP-to-MCP bridge.\n\n');
  process.stdout.write('Usage:\n');
  process.stdout.write('  qwen-dap-mcp            Start the MCP server on stdio\n');
  process.stdout.write('  qwen-dap-mcp --help     Show this help\n');
  process.stdout.write('  qwen-dap-mcp --version  Print the installed version\n\n');
  process.stdout.write('Quick start:\n');
  process.stdout.write('  qwen extensions install SLP-DEV1/qwen-dap-mcp\n');
  process.stdout.write('  npx -y @slp-dev1/qwen-dap-mcp\n\n');
  process.stdout.write('Docs: https://github.com/SLP-DEV1/qwen-dap-mcp\n');
} else {
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
}
