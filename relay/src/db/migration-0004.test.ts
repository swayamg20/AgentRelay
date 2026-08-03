import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tryConnect } from "./test-utils.js";

const TEST_URL = process.env.RELAY_TEST_DATABASE_URL ?? process.env.RELAY_DATABASE_URL;
const conn = await tryConnect();
const d = conn.available && TEST_URL ? describe : describe.skip;

if (!conn.available || !TEST_URL) {
	console.warn(`[migration-0004.test] skipping: ${conn.reason ?? "database URL unset"}`);
}

d("0004 mailbox integrity migration", () => {
	let sql: Sql;
	const schemaName = `migration_0004_${randomUUID().replaceAll("-", "")}`;

	beforeAll(async () => {
		sql = postgres(TEST_URL as string, { max: 1, onnotice: () => undefined });
		await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
		await sql.unsafe(`SET search_path TO "${schemaName}", public`);
	});

	afterAll(async () => {
		if (sql) {
			await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
			await sql.end({ timeout: 2 });
		}
		if (conn.handle) await conn.handle.close();
	});

	it("backfills legacy data idempotently and removes plaintext webhook secrets", async () => {
		await sql.unsafe(`
			CREATE TABLE handoffs (
				id uuid PRIMARY KEY,
				artifacts jsonb NOT NULL DEFAULT '[]'::jsonb
			);
			CREATE TABLE messages (
				id uuid PRIMARY KEY,
				handoff_id uuid NOT NULL REFERENCES handoffs(id),
				payload jsonb NOT NULL DEFAULT '{}'::jsonb,
				sequence_no integer NOT NULL
			);
			CREATE TABLE agent_cards (
				agent_id uuid PRIMARY KEY,
				notification_webhook_url text
			);
		`);

		const handoffId = randomUUID();
		const initialId = randomUUID();
		const appendId = randomUUID();
		const postMigrationHandoffId = randomUUID();
		const postMigrationMessageId = randomUUID();
		const plaintextCardId = randomUUID();
		const encryptedCardId = randomUUID();
		await sql`
			INSERT INTO handoffs (id, artifacts)
			VALUES (${handoffId}, ${sql.json([{ type: "file_ref", path: "src/api.ts" }])})
		`;
		await sql`
			INSERT INTO messages (id, handoff_id, payload, sequence_no)
			VALUES
				(${initialId}, ${handoffId}, ${sql.json({})}, 1),
				(${appendId}, ${handoffId}, ${sql.json({ artifacts: [{ type: "link", url: "https://example.com" }] })}, 2)
		`;
		await sql`
			INSERT INTO agent_cards (agent_id, notification_webhook_url)
			VALUES
				(${plaintextCardId}, ${"https://hooks.example/legacy-secret"}),
				(${encryptedCardId}, ${"enc:v1:already-encrypted"})
		`;

		const migration = await readFile(
			new URL("../../drizzle/0004_mailbox_integrity.sql", import.meta.url),
			"utf8",
		);
		const applyMigration = () =>
			sql.begin(async (tx) => {
				for (const statement of migration.split("--> statement-breakpoint")) {
					if (statement.trim()) await tx.unsafe(statement);
				}
			});
		await applyMigration();

		const postMigrationPayload = {
			artifacts: [{ caller_field: "must remain generic payload data" }],
			nested: { exact: true },
		};
		const postMigrationArtifacts = [{ type: "test_command", command: "pnpm test" }];
		await sql`
			INSERT INTO handoffs (id, artifacts)
			VALUES (${postMigrationHandoffId}, ${sql.json([])})
		`;
		await sql`
			INSERT INTO messages (id, handoff_id, payload, artifacts, sequence_no)
			VALUES (
				${postMigrationMessageId},
				${postMigrationHandoffId},
				${sql.json(postMigrationPayload)},
				${sql.json(postMigrationArtifacts)},
				3
			)
		`;

		// A concurrent or manual replay must detect the completed backfill and
		// leave new-format generic payload and typed artifacts byte-for-byte intact.
		await applyMigration();

		const messageRows = await sql<
			Array<{ id: string; payload: unknown; artifacts: unknown }>
		>`SELECT id, payload, artifacts FROM messages ORDER BY sequence_no`;
		expect(messageRows).toEqual([
			{
				id: initialId,
				payload: {},
				artifacts: [{ type: "file_ref", path: "src/api.ts" }],
			},
			{
				id: appendId,
				payload: {},
				artifacts: [{ type: "link", url: "https://example.com" }],
			},
			{
				id: postMigrationMessageId,
				payload: postMigrationPayload,
				artifacts: postMigrationArtifacts,
			},
		]);

		const cardRows = await sql<
			Array<{ agent_id: string; notification_webhook_url: string | null }>
		>`SELECT agent_id, notification_webhook_url FROM agent_cards ORDER BY agent_id`;
		const byId = new Map(cardRows.map((row) => [row.agent_id, row.notification_webhook_url]));
		expect(byId.get(plaintextCardId)).toBeNull();
		expect(byId.get(encryptedCardId)).toBe("enc:v1:already-encrypted");
	});
});
