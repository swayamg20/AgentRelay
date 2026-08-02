import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tryConnect } from "./test-utils.js";

const TEST_URL = process.env.RELAY_TEST_DATABASE_URL ?? process.env.RELAY_DATABASE_URL;
const conn = await tryConnect();
const d = conn.available && TEST_URL ? describe : describe.skip;

if (!conn.available || !TEST_URL) {
	console.warn(`[migration-0006.test] skipping: ${conn.reason ?? "database URL unset"}`);
}

d("0006 Node credentials migration", () => {
	let sql: Sql;
	let migration: string;
	const schemaName = `migration_0006_${randomUUID().replaceAll("-", "")}`;

	beforeAll(async () => {
		sql = postgres(TEST_URL as string, { max: 1, onnotice: () => undefined });
		await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
		await sql.unsafe(`SET search_path TO "${schemaName}", public`);
		await sql.unsafe(
			"CREATE TABLE nodes (id uuid PRIMARY KEY, updated_at timestamp with time zone DEFAULT now() NOT NULL)",
		);
		await sql.unsafe(`
			CREATE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
			BEGIN
				NEW.updated_at = now();
				RETURN NEW;
			END;
			$$ LANGUAGE plpgsql
		`);
		await sql.unsafe(`
			CREATE TRIGGER nodes_set_updated_at
			BEFORE UPDATE ON nodes FOR EACH ROW EXECUTE FUNCTION set_updated_at()
		`);
		migration = await readFile(
			new URL("../../drizzle/0006_node_credentials.sql", import.meta.url),
			"utf8",
		);
		await applyMigration(sql, migration);
	});

	afterAll(async () => {
		if (sql) {
			await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
			await sql.end({ timeout: 2 });
		}
		if (conn.handle) await conn.handle.close();
	});

	it("replays safely and preserves issued credentials", async () => {
		const nodeId = randomUUID();
		const credentialId = randomUUID();
		const keyHash = Buffer.from("a".repeat(32));
		const salt = Buffer.from("s".repeat(16));
		await sql`INSERT INTO nodes (id) VALUES (${nodeId})`;
		await sql`
			INSERT INTO node_credentials (id, node_id, key_hash, salt, label)
			VALUES (${credentialId}, ${nodeId}, ${keyHash}, ${salt}, ${"enrollment"})
		`;

		await applyMigration(sql, migration);

		const [stored] = await sql<
			Array<{ id: string; node_id: string; label: string; revoked_at: Date | null }>
		>`
			SELECT id, node_id, label, revoked_at
			FROM node_credentials
			WHERE id = ${credentialId}
		`;
		expect(stored).toEqual({
			id: credentialId,
			node_id: nodeId,
			label: "enrollment",
			revoked_at: null,
		});
	});

	it("enforces Node ownership and active-hash uniqueness without storing raw tokens", async () => {
		const firstNodeId = randomUUID();
		const secondNodeId = randomUUID();
		const keyHash = Buffer.from("b".repeat(32));
		const salt = Buffer.from("t".repeat(16));
		await sql`INSERT INTO nodes (id) VALUES (${firstNodeId}), (${secondNodeId})`;
		await sql`
			INSERT INTO node_credentials (node_id, key_hash, salt)
			VALUES (${firstNodeId}, ${keyHash}, ${salt})
		`;
		await expect(sql`
			INSERT INTO node_credentials (node_id, key_hash, salt)
			VALUES (${firstNodeId}, ${Buffer.from("c".repeat(32))}, ${salt})
		`).rejects.toThrow(/idx_node_credentials_active_node/);

		await expect(sql`
			INSERT INTO node_credentials (node_id, key_hash, salt)
			VALUES (${secondNodeId}, ${keyHash}, ${salt})
		`).rejects.toThrow(/idx_node_credentials_active_hash/);

		await sql`
			UPDATE node_credentials
			SET revoked_at = now()
			WHERE node_id = ${firstNodeId}
		`;
		await expect(sql`
			INSERT INTO node_credentials (node_id, key_hash, salt)
			VALUES (${secondNodeId}, ${keyHash}, ${salt})
		`).resolves.toBeDefined();

		await expect(sql`
			INSERT INTO node_credentials (node_id, key_hash, salt)
			VALUES (${randomUUID()}, ${Buffer.from("d".repeat(32))}, ${salt})
		`).rejects.toThrow(/node_credentials_node_id_fkey/);

		const secretColumns = await sql<Array<{ column_name: string }>>`
			SELECT column_name
			FROM information_schema.columns
			WHERE table_schema = ${schemaName}
				AND table_name = 'node_credentials'
				AND column_name IN ('key', 'token', 'raw_key', 'raw_token')
		`;
		expect(secretColumns).toEqual([]);
	});

	it("replaces transaction-start update timestamps with wall-clock trigger time", async () => {
		const nodeId = randomUUID();
		await sql`INSERT INTO nodes (id) VALUES (${nodeId})`;

		const timestamps = await sql.begin(async (tx) => {
			const [started] = await tx<Array<{ transaction_started_at: Date }>>`
				SELECT now() AS transaction_started_at
			`;
			await tx`SELECT pg_sleep(0.02)`;
			const [updated] = await tx<Array<{ updated_at: Date }>>`
				UPDATE nodes
				SET id = id
				WHERE id = ${nodeId}
				RETURNING updated_at
			`;
			return { startedAt: started?.transaction_started_at, updatedAt: updated?.updated_at };
		});

		if (!timestamps.startedAt || !timestamps.updatedAt) {
			throw new Error("expected transaction and trigger timestamps");
		}
		expect(timestamps.updatedAt.getTime()).toBeGreaterThan(timestamps.startedAt.getTime());
	});
});

async function applyMigration(sql: Sql, migration: string): Promise<void> {
	await sql.begin(async (tx) => {
		for (const statement of migration.split("--> statement-breakpoint")) {
			if (statement.trim()) await tx.unsafe(statement);
		}
	});
}
