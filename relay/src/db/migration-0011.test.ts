import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tryConnect } from "./test-utils.js";

const TEST_URL = process.env.RELAY_TEST_DATABASE_URL ?? process.env.RELAY_DATABASE_URL;
const connection = await tryConnect();
const databaseDescribe = connection.available && TEST_URL ? describe : describe.skip;
if (!connection.available) console.warn(`[migration-0011.test] skipping: ${connection.reason}`);

databaseDescribe("0011 notification outbox migration", () => {
	let sql: Sql;
	let migration: string;
	const schemaName = `migration_0011_${randomUUID().replaceAll("-", "")}`;
	const recipientId = randomUUID();
	const threadId = randomUUID();
	const sourceId = randomUUID();

	async function applyMigration() {
		await sql.begin(async (transaction) => {
			for (const statement of migration.split("--> statement-breakpoint")) {
				if (statement.trim()) await transaction.unsafe(statement);
			}
		});
	}

	beforeAll(async () => {
		sql = postgres(TEST_URL as string, { max: 1, onnotice: () => undefined });
		await sql.unsafe(`CREATE SCHEMA "${schemaName}"; SET search_path TO "${schemaName}", public;
			CREATE TABLE agents (id uuid PRIMARY KEY); CREATE TABLE handoffs (id uuid PRIMARY KEY);`);
		await sql`INSERT INTO agents (id) VALUES (${recipientId})`;
		await sql`INSERT INTO handoffs (id) VALUES (${threadId})`;
		migration = await readFile(
			new URL("../../drizzle/0011_notification_outbox.sql", import.meta.url),
			"utf8",
		);
		await applyMigration();
	});
	afterAll(async () => {
		if (sql) {
			await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
			await sql.end({ timeout: 2 });
		}
		await connection.handle?.close();
	});

	it("reapplies safely and indexes active leases, due work, terminal retention, and source identity", async () => {
		await applyMigration();
		const indexes = await sql`SELECT indexname FROM pg_indexes
			WHERE schemaname = ${schemaName} AND tablename = 'notification_outbox' ORDER BY indexname`;
		expect(indexes.map((row) => row.indexname)).toEqual([
			"idx_notification_outbox_due",
			"idx_notification_outbox_lease",
			"idx_notification_outbox_source",
			"idx_notification_outbox_terminal",
			"notification_outbox_pkey",
		]);
		expect(await sql`SELECT * FROM notification_outbox`).toHaveLength(0);
	});

	it("enforces source uniqueness, kind, attempts, and lifecycle shape", async () => {
		await sql`INSERT INTO notification_outbox (recipient_agent_id, thread_id, kind, source_id, encrypted_payload)
			VALUES (${recipientId}, ${threadId}, 'notify.handoff.created', ${sourceId}, 'enc:v1:test')`;
		await expect(sql`INSERT INTO notification_outbox (recipient_agent_id, thread_id, kind, source_id, encrypted_payload)
			VALUES (${recipientId}, ${threadId}, 'notify.handoff.created', ${sourceId}, 'enc:v1:test')`).rejects.toThrow(
			/idx_notification_outbox_source/,
		);
		await expect(sql`UPDATE notification_outbox SET kind = 'runtime.awakened'`).rejects.toThrow(
			/notification_outbox_kind_chk/,
		);
		await expect(sql`UPDATE notification_outbox SET attempts = 5`).rejects.toThrow(
			/notification_outbox_attempts_chk/,
		);
		await expect(sql`UPDATE notification_outbox SET status = 'leased'`).rejects.toThrow(
			/notification_outbox_state_chk/,
		);
		await expect(
			sql`UPDATE notification_outbox SET status = 'succeeded', terminal_at = now()`,
		).rejects.toThrow(/notification_outbox_state_chk/);
		await sql`UPDATE notification_outbox SET status = 'leased', attempts = 1, lease_token = ${randomUUID()},
			lease_expires_at = now() + interval '30 seconds'`;
		await sql`UPDATE notification_outbox SET status = 'succeeded', terminal_at = now(), encrypted_payload = NULL,
			lease_token = NULL, lease_expires_at = NULL`;
		expect(await sql`SELECT status, attempts FROM notification_outbox`).toEqual([
			{ status: "succeeded", attempts: 1 },
		]);
	});
});
