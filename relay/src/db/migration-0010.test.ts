import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tryConnect } from "./test-utils.js";

const TEST_URL = process.env.RELAY_TEST_DATABASE_URL ?? process.env.RELAY_DATABASE_URL;
const conn = await tryConnect();
const d = conn.available && TEST_URL ? describe : describe.skip;

if (!conn.available || !TEST_URL) {
	console.warn(`[migration-0010.test] skipping: ${conn.reason ?? "database URL unset"}`);
}

d("0010 mailbox event ledger migration", () => {
	let sql: Sql;
	let migration: string;
	const schemaName = `migration_0010_${randomUUID().replaceAll("-", "")}`;
	const senderId = randomUUID();
	const recipientId = randomUUID();
	const threadId = randomUUID();

	beforeAll(async () => {
		sql = postgres(TEST_URL as string, { max: 1, onnotice: () => undefined });
		await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
		await sql.unsafe(`SET search_path TO "${schemaName}", public`);
		await sql.unsafe(`
			CREATE TABLE agents (id uuid PRIMARY KEY);
			CREATE TABLE handoffs (id uuid PRIMARY KEY);
		`);
		await sql`INSERT INTO agents (id) VALUES (${senderId}), (${recipientId})`;
		await sql`INSERT INTO handoffs (id) VALUES (${threadId})`;
		migration = await readFile(
			new URL("../../drizzle/0010_mailbox_events.sql", import.meta.url),
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

	it("creates the opaque ledger and reapplies idempotently", async () => {
		await applyMigration(sql, migration);

		const columns = await sql<Array<{ column_name: string }>>`
			SELECT column_name
			FROM information_schema.columns
			WHERE table_schema = ${schemaName} AND table_name = 'mailbox_events'
			ORDER BY column_name
		`;
		expect(columns.map((row) => row.column_name)).toEqual([
			"actor_agent_id",
			"created_at",
			"cursor",
			"id",
			"kind",
			"recipient_agent_id",
			"source_id",
			"thread_id",
		]);
		const [cursorColumn] = await sql<
			Array<{ data_type: string; is_nullable: string; column_default: string }>
		>`
			SELECT data_type, is_nullable, column_default
			FROM information_schema.columns
			WHERE table_schema = ${schemaName}
				AND table_name = 'mailbox_events'
				AND column_name = 'cursor'
		`;
		expect(cursorColumn).toMatchObject({
			data_type: "bigint",
			is_nullable: "NO",
			column_default: expect.stringContaining("nextval"),
		});

		const indexes = await sql<Array<{ indexname: string }>>`
			SELECT indexname
			FROM pg_indexes
			WHERE schemaname = ${schemaName} AND tablename = 'mailbox_events'
			ORDER BY indexname
		`;
		expect(indexes.map((row) => row.indexname)).toEqual([
			"idx_mailbox_events_cursor",
			"idx_mailbox_events_recipient_cursor",
			"idx_mailbox_events_recipient_kind_source",
			"mailbox_events_pkey",
		]);
	});

	it("allocates ordered bigint cursors and enforces event invariants", async () => {
		const firstSourceId = randomUUID();
		const secondSourceId = randomUUID();
		await sql`
			INSERT INTO mailbox_events (
				recipient_agent_id, actor_agent_id, thread_id, kind, source_id
			) VALUES (
				${recipientId}, ${senderId}, ${threadId}, 'thread.created', ${firstSourceId}
			), (
				${recipientId}, ${senderId}, ${threadId}, 'message.appended', ${secondSourceId}
			)
		`;
		const rows = await sql<Array<{ id: string; cursor: string; kind: string }>>`
			SELECT id, cursor::text, kind FROM mailbox_events ORDER BY cursor
		`;
		expect(rows.map(({ cursor, kind }) => ({ cursor, kind }))).toEqual([
			{ cursor: "1", kind: "thread.created" },
			{ cursor: "2", kind: "message.appended" },
		]);
		expect(rows.map((row) => row.id)).toEqual([
			expect.stringMatching(/^[0-9a-f-]{36}$/),
			expect.stringMatching(/^[0-9a-f-]{36}$/),
		]);
		expect(new Set(rows.map((row) => row.id)).size).toBe(2);

		await expect(sql`
			INSERT INTO mailbox_events (
				recipient_agent_id, actor_agent_id, thread_id, kind, source_id
			) VALUES (
				${recipientId}, ${recipientId}, ${threadId}, 'thread.created', ${randomUUID()}
			)
		`).rejects.toThrow(/mailbox_events_recipient_not_actor_chk/);
		await expect(sql`
			INSERT INTO mailbox_events (
				recipient_agent_id, actor_agent_id, thread_id, kind, source_id
			) VALUES (
				${recipientId}, ${senderId}, ${threadId}, 'runtime.awakened', ${randomUUID()}
			)
		`).rejects.toThrow(/mailbox_events_kind_chk/);
		await expect(sql`
			INSERT INTO mailbox_events (
				recipient_agent_id, actor_agent_id, thread_id, kind, source_id
			) VALUES (
				${recipientId}, ${senderId}, ${threadId}, 'thread.created', ${firstSourceId}
			)
		`).rejects.toThrow(/idx_mailbox_events_recipient_kind_source/);
		await expect(sql`
			INSERT INTO mailbox_events (
				cursor, recipient_agent_id, actor_agent_id, thread_id, kind, source_id
			) VALUES (
				1, ${recipientId}, ${senderId}, ${threadId}, 'message.appended', ${randomUUID()}
			)
		`).rejects.toThrow(/idx_mailbox_events_cursor/);
	});
});

async function applyMigration(sql: Sql, migration: string): Promise<void> {
	await sql.begin(async (tx) => {
		for (const statement of migration.split("--> statement-breakpoint")) {
			if (statement.trim()) await tx.unsafe(statement);
		}
	});
}
