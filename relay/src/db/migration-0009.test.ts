import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tryConnect } from "./test-utils.js";

const TEST_URL = process.env.RELAY_TEST_DATABASE_URL ?? process.env.RELAY_DATABASE_URL;
const conn = await tryConnect();
const d = conn.available && TEST_URL ? describe : describe.skip;

if (!conn.available || !TEST_URL) {
	console.warn(`[migration-0009.test] skipping: ${conn.reason ?? "database URL unset"}`);
}

d("0009 Mission terminal reconciliation migration", () => {
	let sql: Sql;
	let migration: string;
	const schemaName = `migration_0009_${randomUUID().replaceAll("-", "")}`;
	const missionId = randomUUID();
	const agentId = randomUUID();
	const legacyEventId = randomUUID();

	beforeAll(async () => {
		sql = postgres(TEST_URL as string, { max: 1, onnotice: () => undefined });
		await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
		await sql.unsafe(`SET search_path TO "${schemaName}", public`);
		await sql.unsafe(`
			CREATE TABLE agents (id uuid PRIMARY KEY);
			CREATE TABLE missions (id uuid PRIMARY KEY);
			CREATE TABLE mission_participants (
				mission_id uuid NOT NULL REFERENCES missions(id),
				agent_id uuid NOT NULL REFERENCES agents(id),
				PRIMARY KEY (mission_id, agent_id)
			);
			CREATE TABLE mission_events (
				id uuid PRIMARY KEY,
				mission_id uuid NOT NULL REFERENCES missions(id),
				sequence_no integer NOT NULL,
				type text NOT NULL,
				actor_agent_id uuid NOT NULL REFERENCES agents(id),
				idempotency_key text NOT NULL,
				source_delivery_id uuid,
				causal_parent_event_id uuid,
				payload jsonb NOT NULL,
				created_at timestamp with time zone DEFAULT now() NOT NULL,
				CONSTRAINT mission_events_actor_participant_fk
					FOREIGN KEY (mission_id, actor_agent_id)
					REFERENCES mission_participants(mission_id, agent_id),
				CONSTRAINT mission_events_type_chk CHECK (
					type IN (
						'participants_accepted','turn_completed',
						'contract_acknowledged','verification_recorded'
					)
				)
			);
		`);
		await sql`INSERT INTO agents (id) VALUES (${agentId})`;
		await sql`INSERT INTO missions (id) VALUES (${missionId})`;
		await sql`
			INSERT INTO mission_participants (mission_id, agent_id)
			VALUES (${missionId}, ${agentId})
		`;
		await sql`
			INSERT INTO mission_events (
				id, mission_id, sequence_no, type, actor_agent_id, idempotency_key, payload
			) VALUES (
				${legacyEventId}, ${missionId}, 1, 'participants_accepted', ${agentId},
				'legacy:accepted', ${sql.json({ participant_agent_ids: [agentId] })}
			)
		`;
		migration = await readFile(
			new URL("../../drizzle/0009_mission_terminal_reconciliation.sql", import.meta.url),
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

	it("backfills participant events and reapplies without rewriting them", async () => {
		const [before] = await sql<Array<{ actor_kind: string; actor_agent_id: string; type: string }>>`
			SELECT actor_kind, actor_agent_id, type
			FROM mission_events
			WHERE id = ${legacyEventId}
		`;
		expect(before).toEqual({
			actor_kind: "agent",
			actor_agent_id: agentId,
			type: "participants_accepted",
		});

		await applyMigration(sql, migration);

		const rows = await sql<Array<{ actor_kind: string; actor_agent_id: string }>>`
			SELECT actor_kind, actor_agent_id
			FROM mission_events
			WHERE id = ${legacyEventId}
		`;
		expect(rows).toEqual([{ actor_kind: "agent", actor_agent_id: agentId }]);
	});

	it("defers the historical constraint scan while enforcing new writes", async () => {
		const constraints = await sql<Array<{ conname: string; convalidated: boolean }>>`
			SELECT conname, convalidated
			FROM pg_constraint
			WHERE conrelid = 'mission_events'::regclass
				AND conname IN (
					'mission_events_actor_kind_chk',
					'mission_events_actor_identity_chk',
					'mission_events_actor_event_chk',
					'mission_events_type_chk'
				)
			ORDER BY conname
		`;
		expect(constraints).toEqual([
			{ conname: "mission_events_actor_event_chk", convalidated: false },
			{ conname: "mission_events_actor_identity_chk", convalidated: false },
			{ conname: "mission_events_actor_kind_chk", convalidated: false },
			{ conname: "mission_events_type_chk", convalidated: false },
		]);
	});

	it("permits only a System actor for Mission terminal events", async () => {
		const terminalEventId = randomUUID();
		const [inserted] = await sql<
			Array<{ actor_kind: string; actor_agent_id: string | null; type: string }>
		>`
			INSERT INTO mission_events (
				id, mission_id, sequence_no, type, actor_kind, actor_agent_id,
				idempotency_key, payload
			) VALUES (
				${terminalEventId}, ${missionId}, 2, 'mission_terminal', 'system', NULL,
				'terminal:expired', ${sql.json({
					terminal_status: "expired",
					reason: "deadline_exceeded",
					triggering_delivery_id: null,
				})}
			)
			RETURNING actor_kind, actor_agent_id, type
		`;
		expect(inserted).toEqual({
			actor_kind: "system",
			actor_agent_id: null,
			type: "mission_terminal",
		});

		await expect(sql`
			INSERT INTO mission_events (
				id, mission_id, sequence_no, type, actor_kind, actor_agent_id,
				idempotency_key, payload
			) VALUES (
				${randomUUID()}, ${missionId}, 3, 'mission_terminal', 'agent', ${agentId},
				'invalid:agent-terminal', '{}'::jsonb
			)
		`).rejects.toThrow(/mission_events_actor_event_chk/);
		await expect(sql`
			INSERT INTO mission_events (
				id, mission_id, sequence_no, type, actor_kind, actor_agent_id,
				idempotency_key, payload
			) VALUES (
				${randomUUID()}, ${missionId}, 3, 'turn_completed', 'system', NULL,
				'invalid:system-turn', '{}'::jsonb
			)
		`).rejects.toThrow(/mission_events_actor_event_chk/);
	});

	it("enforces actor identity and the expanded event type set", async () => {
		await expect(sql`
			INSERT INTO mission_events (
				id, mission_id, sequence_no, type, actor_kind, actor_agent_id,
				idempotency_key, payload
			) VALUES (
				${randomUUID()}, ${missionId}, 3, 'turn_completed', 'agent', NULL,
				'invalid:missing-agent', '{}'::jsonb
			)
		`).rejects.toThrow(/mission_events_actor_identity_chk/);
		await expect(sql`
			INSERT INTO mission_events (
				id, mission_id, sequence_no, type, actor_kind, actor_agent_id,
				idempotency_key, payload
			) VALUES (
				${randomUUID()}, ${missionId}, 3, 'unknown_event', 'agent', ${agentId},
				'invalid:type', '{}'::jsonb
			)
		`).rejects.toThrow(/mission_events_(actor_event|type)_chk/);
	});
});

async function applyMigration(sql: Sql, migration: string): Promise<void> {
	await sql.begin(async (tx) => {
		for (const statement of migration.split("--> statement-breakpoint")) {
			if (statement.trim()) await tx.unsafe(statement);
		}
	});
}
