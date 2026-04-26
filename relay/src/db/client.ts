import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import type { RelayConfig } from '../config.js';
import * as schema from './schema.js';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  sql: Sql;
  close: () => Promise<void>;
}

export function createDb(
  config: Pick<RelayConfig, 'RELAY_DATABASE_URL' | 'RELAY_DB_POOL_SIZE'>,
): DbHandle {
  const sql = postgres(config.RELAY_DATABASE_URL, {
    max: config.RELAY_DB_POOL_SIZE,
    onnotice: () => undefined,
  });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}

export { schema };
