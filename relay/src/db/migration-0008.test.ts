import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tryConnect } from "./test-utils.js";

const TEST_URL = process.env.RELAY_TEST_DATABASE_URL ?? process.env.RELAY_DATABASE_URL;
const conn = await tryConnect();
const d = conn.available && TEST_URL ? describe : describe.skip;

if (!conn.available || !TEST_URL) {
	console.warn(`[migration-0008.test] skipping: ${conn.reason ?? "database URL unset"}`);
}

d("0008 audit actor kind migration", () => {
	let sql: Sql;
	let migration: string;
	const schemaName = `migration_0008_${randomUUID().replaceAll("-", "")}`;
	const agentId = randomUUID();
	const legacyResourceId = randomUUID();

	beforeAll(async () => {
		sql = postgres(TEST_URL as string, { max: 1, onnotice: () => undefined });
		await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
		await sql.unsafe(`SET search_path TO "${schemaName}", public`);
		await sql.unsafe(`
			CREATE TABLE agents (
				id uuid PRIMARY KEY
			);
			CREATE TABLE audit_log (
				id bigserial PRIMARY KEY,
				actor_id uuid NOT NULL REFERENCES agents(id) ON DELETE restrict,
				action text NOT NULL,
				resource_type text NOT NULL,
				resource_id uuid NOT NULL,
				metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
				request_id text,
				created_at timestamp with time zone DEFAULT now() NOT NULL
			);
		`);
		await sql`INSERT INTO agents (id) VALUES (${agentId})`;
		await sql`
			INSERT INTO audit_log (actor_id, action, resource_type, resource_id)
			VALUES (${agentId}, 'legacy.action', 'legacy_resource', ${legacyResourceId})
		`;
		migration = await readFile(
			new URL("../../drizzle/0008_audit_actor_kind.sql", import.meta.url),
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

	it("backfills existing rows as Agent actors and reapplies without rewriting them", async () => {
		const [before] = await sql<Array<{ actor_kind: string; actor_id: string }>>`
			SELECT actor_kind, actor_id
			FROM audit_log
			WHERE resource_id = ${legacyResourceId}
		`;
		expect(before).toEqual({ actor_kind: "agent", actor_id: agentId });

		await applyMigration(sql, migration);

		const rows = await sql<Array<{ actor_kind: string; actor_id: string }>>`
			SELECT actor_kind, actor_id
			FROM audit_log
			WHERE resource_id = ${legacyResourceId}
		`;
		expect(rows).toEqual([{ actor_kind: "agent", actor_id: agentId }]);
	});

	it("defaults new authenticated audit rows to Agent actors", async () => {
		const [inserted] = await sql<Array<{ actor_kind: string; actor_id: string }>>`
			INSERT INTO audit_log (actor_id, action, resource_type, resource_id)
			VALUES (${agentId}, 'agent.action', 'resource', ${randomUUID()})
			RETURNING actor_kind, actor_id
		`;
		expect(inserted).toEqual({ actor_kind: "agent", actor_id: agentId });
	});

	it("allows only null actor IDs for Admin and System actors", async () => {
		const rows = await sql<Array<{ actor_kind: string; actor_id: string | null }>>`
			INSERT INTO audit_log (actor_kind, actor_id, action, resource_type, resource_id)
			VALUES
				('admin', NULL, 'admin.action', 'resource', ${randomUUID()}),
				('system', NULL, 'system.action', 'resource', ${randomUUID()})
			RETURNING actor_kind, actor_id
		`;
		expect(rows).toEqual([
			{ actor_kind: "admin", actor_id: null },
			{ actor_kind: "system", actor_id: null },
		]);

		await expect(sql`
			INSERT INTO audit_log (actor_kind, actor_id, action, resource_type, resource_id)
			VALUES ('admin', ${agentId}, 'invalid.admin', 'resource', ${randomUUID()})
		`).rejects.toThrow(/audit_log_actor_identity_chk/);
		await expect(sql`
			INSERT INTO audit_log (actor_kind, actor_id, action, resource_type, resource_id)
			VALUES ('system', ${agentId}, 'invalid.system', 'resource', ${randomUUID()})
		`).rejects.toThrow(/audit_log_actor_identity_chk/);
	});

	it("requires an Agent ID and rejects unknown actor kinds", async () => {
		const constraints = await sql<Array<{ conname: string }>>`
			SELECT conname
			FROM pg_constraint
			WHERE conrelid = 'audit_log'::regclass
				AND conname IN ('audit_log_actor_kind_chk', 'audit_log_actor_identity_chk')
			ORDER BY conname
		`;
		expect(constraints.map((constraint) => constraint.conname)).toEqual([
			"audit_log_actor_identity_chk",
			"audit_log_actor_kind_chk",
		]);
		await expect(sql`
			INSERT INTO audit_log (actor_kind, actor_id, action, resource_type, resource_id)
			VALUES ('agent', NULL, 'invalid.agent', 'resource', ${randomUUID()})
		`).rejects.toThrow(/audit_log_actor_identity_chk/);
		await expect(sql`
			INSERT INTO audit_log (actor_kind, actor_id, action, resource_type, resource_id)
			VALUES ('operator', NULL, 'invalid.kind', 'resource', ${randomUUID()})
		`).rejects.toThrow(/audit_log_actor_(kind|identity)_chk/);
		await expect(sql`
			INSERT INTO audit_log (actor_kind, actor_id, action, resource_type, resource_id)
			VALUES (NULL, NULL, 'invalid.null-kind', 'resource', ${randomUUID()})
		`).rejects.toThrow(/null value in column "actor_kind"/);
	});
});

async function applyMigration(sql: Sql, migration: string): Promise<void> {
	await sql.begin(async (tx) => {
		for (const statement of migration.split("--> statement-breakpoint")) {
			if (statement.trim()) await tx.unsafe(statement);
		}
	});
}
