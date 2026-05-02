import { type PostgresJsDatabase, drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema.js";

const TEST_URL = process.env.RELAY_TEST_DATABASE_URL ?? process.env.RELAY_DATABASE_URL;

export interface TestDb {
	db: PostgresJsDatabase<typeof schema>;
	sql: Sql;
	close: () => Promise<void>;
}

export interface ConnectResult {
	available: boolean;
	reason?: string;
	handle?: TestDb;
}

/**
 * Connect to the integration-test postgres. Returns `{available:false}` when no
 * DB is reachable so tests can self-skip rather than fail in environments
 * without docker (CI, local-no-docker, etc.).
 */
export async function tryConnect(): Promise<ConnectResult> {
	if (!TEST_URL) return { available: false, reason: "RELAY_TEST_DATABASE_URL unset" };
	let sql: Sql | undefined;
	try {
		sql = postgres(TEST_URL, { max: 2, connect_timeout: 2, onnotice: () => undefined });
		await sql`SELECT 1`;
		const db = drizzle(sql, { schema });
		await migrate(db, { migrationsFolder: "./drizzle" });
		return {
			available: true,
			handle: { db, sql, close: () => sql?.end({ timeout: 2 }) ?? Promise.resolve() },
		};
	} catch (err) {
		if (sql) await sql.end({ timeout: 1 }).catch(() => undefined);
		return {
			available: false,
			reason: err instanceof Error ? err.message : String(err),
		};
	}
}

export async function truncateAll(sql: Sql): Promise<void> {
	// Listing all data tables explicitly is belt-and-suspenders — `agents` alone
	// with CASCADE would clear the dependents — but explicit listing makes intent
	// obvious and survives future schema additions that aren't FK-rooted at agents.
	await sql.unsafe(
		"TRUNCATE TABLE messages, handoffs, agent_cards, api_keys, audit_log, agent_blocks, agents RESTART IDENTITY CASCADE",
	);
}
