import { serve } from '@hono/node-server';
import { config as loadDotenv } from 'dotenv';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { createLogger } from './logger.js';
import { NotificationDispatcher } from './notifications/dispatcher.js';
import { createServer } from './server.js';

loadDotenv();

const config = loadConfig();
const logger = createLogger(config);
const dbHandle = createDb(config);
const dispatcher = new NotificationDispatcher({
  db: dbHandle.db,
  encryptionKey: config.RELAY_ENCRYPTION_KEY,
  publicUrl: config.RELAY_PUBLIC_URL,
  logger,
});
dispatcher.start();
const app = createServer({
  config,
  logger,
  db: dbHandle.db,
  notify: (job) => dispatcher.enqueue(job),
  readinessProbe: async () => {
    try {
      await dbHandle.sql`SELECT 1`;
      return true;
    } catch (err) {
      logger.warn({ err }, 'readiness probe failed');
      return false;
    }
  },
});

const server = serve(
  { fetch: app.fetch, port: config.RELAY_PORT },
  (info) => {
    logger.info(
      { event: 'server.listening', port: info.port, env: config.RELAY_ENV },
      `Relay listening on :${info.port}`,
    );
  },
);

const shutdown = (signal: string): void => {
  logger.info({ event: 'server.shutdown', signal }, 'shutting down');
  server.close(async (err) => {
    if (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
    await dispatcher.stop().catch((stopErr) => logger.warn({ err: stopErr }, 'dispatcher stop failed'));
    await dbHandle.close().catch((closeErr) => logger.warn({ err: closeErr }, 'db close failed'));
    process.exit(0);
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
