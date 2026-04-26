// Standalone migration runner: `pnpm --filter relay db:migrate`.
// Reads RELAY_DATABASE_URL from the environment, applies all SQL migrations
// in ./drizzle (relative to the relay package root) in order.
import 'dotenv/config';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { loadConfig } from '../config.js';
import { createDb } from './client.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const handle = createDb(config);
  try {
    await migrate(handle.db, { migrationsFolder: './drizzle' });
    console.log('migrations applied');
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
