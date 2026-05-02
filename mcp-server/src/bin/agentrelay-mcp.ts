#!/usr/bin/env node
/**
 * Entry point for the `agentrelay-mcp` binary. Boots the stdio MCP server.
 */

import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { startServer } from '../server.js';
import { CLI_MISUSE_HINT, isCliMisuse } from './argv-guard.js';

async function main(): Promise<void> {
  if (isCliMisuse(process.argv[2])) {
    process.stderr.write(CLI_MISUSE_HINT);
    process.exit(2);
  }

  const configResult = await loadConfig();
  const handle = await startServer({ configResult });

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'shutting down');
    try {
      await handle.stop();
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal startup error');
  process.exit(1);
});
