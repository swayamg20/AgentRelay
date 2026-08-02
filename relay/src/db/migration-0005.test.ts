import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tryConnect } from "./test-utils.js";

const TEST_URL = process.env.RELAY_TEST_DATABASE_URL ?? process.env.RELAY_DATABASE_URL;
const conn = await tryConnect();
const d = conn.available && TEST_URL ? describe : describe.skip;

if (!conn.available || !TEST_URL) {
	console.warn(`[migration-0005.test] skipping: ${conn.reason ?? "database URL unset"}`);
}

d("0005 durable delivery ledger migration", () => {
	let sql: Sql;
	let migration: string;
	const schemaName = `migration_0005_${randomUUID().replaceAll("-", "")}`;

	beforeAll(async () => {
		sql = postgres(TEST_URL as string, { max: 1, onnotice: () => undefined });
		await sql.unsafe(`CREATE SCHEMA "${schemaName}"`);
		await sql.unsafe(`SET search_path TO "${schemaName}", public`);
		await sql.unsafe(`
			CREATE TABLE agents (
				id uuid PRIMARY KEY,
				handle text NOT NULL
			);
			CREATE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
			BEGIN
				NEW.updated_at = now();
				RETURN NEW;
			END;
			$$ LANGUAGE plpgsql;
		`);
		migration = await readFile(
			new URL("../../drizzle/0005_durable_delivery_ledger.sql", import.meta.url),
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

	it("applies idempotently without rewriting accepted participants or stored deliveries", async () => {
		const fixture = await seedMigrationFixture(sql);
		await applyMigration(sql, migration);

		const [participant] = await sql<
			Array<{
				status: string;
				acceptance_idempotency_key: string;
				acceptance_receipt: unknown;
			}>
		>`
			SELECT status, acceptance_idempotency_key, acceptance_receipt
			FROM mission_participants
			WHERE mission_id = ${fixture.missionAId} AND agent_id = ${fixture.agentAId}
		`;
		expect(participant).toEqual({
			status: "accepted",
			acceptance_idempotency_key: fixture.acceptanceA.idempotency_key,
			acceptance_receipt: fixture.acceptanceA,
		});

		const [stored] = await sql<
			Array<{
				id: string;
				cursor: string;
				status: string;
				attempt_count: number;
				last_fencing_token: string;
			}>
		>`
			SELECT id, cursor::text, status, attempt_count, last_fencing_token
			FROM node_deliveries
			WHERE id = ${fixture.deliveryAId}
		`;
		expect(stored).toEqual({
			id: fixture.deliveryAId,
			cursor: "1",
			status: "stored",
			attempt_count: 0,
			last_fencing_token: "0",
		});

		const pathColumns = await sql<Array<{ column_name: string }>>`
			SELECT column_name
			FROM information_schema.columns
			WHERE table_schema = ${schemaName}
				AND table_name = 'workspace_bindings'
				AND column_name LIKE '%path%'
		`;
		expect(pathColumns).toEqual([]);

		await expect(sql`
			INSERT INTO mission_events (
				id, mission_id, sequence_no, type, actor_agent_id, idempotency_key, payload
			) VALUES (
				${randomUUID()},
				${fixture.missionAId},
				1,
				${"participants_accepted"},
				${fixture.agentAId},
				${"accept:duplicate-sequence"},
				${sql.json({})}
			)
		`).rejects.toThrow(/idx_mission_events_sequence/);
	});

	it("rejects participant agent/Node and workspace/Node identity mismatches", async () => {
		const fixture = await seedMigrationFixture(sql);
		const mismatchMissionId = randomUUID();
		await sql`
			INSERT INTO missions (id, created_by_agent_id, coordinator_config, state, expires_at)
			VALUES (
				${mismatchMissionId}, ${fixture.agentAId}, ${sql.json({ schema_version: 1 })},
				${sql.json({ status: "awaiting_acceptance" })}, ${new Date(Date.now() + 60_000)}
			)
		`;

		await expect(sql`
			INSERT INTO mission_participants (
				mission_id, agent_id, node_id, workspace_binding_id, role
			) VALUES (
				${mismatchMissionId}, ${fixture.agentAId}, ${fixture.nodeBId},
				${fixture.bindingBId}, ${"backend"}
			)
		`).rejects.toThrow(/mission_participants_node_owner_fk/);

		await expect(sql`
			INSERT INTO mission_participants (
				mission_id, agent_id, node_id, workspace_binding_id, role
			) VALUES (
				${mismatchMissionId}, ${fixture.agentAId}, ${fixture.nodeAId},
				${fixture.bindingBId}, ${"backend"}
			)
		`).rejects.toThrow(/mission_participants_binding_node_fk/);
	});

	it("rejects cross-Mission event and delivery references", async () => {
		const fixture = await seedMigrationFixture(sql);

		await expect(sql`
			INSERT INTO mission_events (
				id, mission_id, sequence_no, type, actor_agent_id, idempotency_key,
				causal_parent_event_id, payload
			) VALUES (
				${randomUUID()},
				${fixture.missionAId},
				2,
				${"turn_completed"},
				${fixture.agentAId},
				${"event:cross-mission-parent"},
				${fixture.eventBId},
				${sql.json({})}
			)
		`).rejects.toThrow(/mission_events_causal_parent_fk/);

		await expect(sql`
			INSERT INTO mission_events (
				id, mission_id, sequence_no, type, actor_agent_id, idempotency_key, payload
			) VALUES (
				${randomUUID()},
				${fixture.missionBId},
				2,
				${"turn_completed"},
				${fixture.agentAId},
				${"event:non-participant-actor"},
				${sql.json({})}
			)
		`).rejects.toThrow(/mission_events_actor_participant_fk/);

		await expect(sql`
			INSERT INTO node_deliveries (
				id, node_id, mission_id, mission_event_id, kind, contract_version,
				verification_round, idempotency_key
			) VALUES (
				${randomUUID()},
				${fixture.nodeAId},
				${fixture.missionAId},
				${fixture.eventBId},
				${"verification"},
				1,
				1,
				${"delivery:cross-mission-event"}
			)
		`).rejects.toThrow(/node_deliveries_event_mission_fk/);

		await expect(sql`
			INSERT INTO node_deliveries (
				id, node_id, mission_id, mission_event_id, kind, contract_version, idempotency_key
			) VALUES (
				${randomUUID()},
				${fixture.nodeAId},
				${fixture.missionBId},
				${fixture.eventBId},
				${"turn"},
				1,
				${"delivery:non-participant-node"}
			)
		`).rejects.toThrow(/node_deliveries_participant_node_fk/);
	});

	it("rejects delivery causal parents from another Node or Mission", async () => {
		const fixture = await seedMigrationFixture(sql);

		await expect(sql`
			INSERT INTO node_deliveries (
				id, node_id, mission_id, mission_event_id, kind, contract_version,
				verification_round, idempotency_key, causal_parent_delivery_id
			) VALUES (
				${randomUUID()},
				${fixture.nodeBId},
				${fixture.missionAId},
				${fixture.eventAId},
				${"verification"},
				1,
				1,
				${"delivery:cross-node-parent"},
				${fixture.deliveryAId}
			)
		`).rejects.toThrow(/node_deliveries_causal_parent_fk/);

		await expect(sql`
			INSERT INTO node_deliveries (
				id, node_id, mission_id, mission_event_id, kind, contract_version,
				verification_round, idempotency_key, causal_parent_delivery_id
			) VALUES (
				${randomUUID()},
				${fixture.nodeBId},
				${fixture.missionBId},
				${fixture.eventBId},
				${"verification"},
				1,
				1,
				${"delivery:cross-mission-parent"},
				${fixture.deliveryAId}
			)
		`).rejects.toThrow(/node_deliveries_causal_parent_fk/);
	});

	it("requires verification rounds and complete settlement pairs", async () => {
		const fixture = await seedMigrationFixture(sql);

		await expect(sql`
			INSERT INTO node_deliveries (
				id, node_id, mission_id, mission_event_id, kind, contract_version,
				verification_round, idempotency_key
			) VALUES (
				${randomUUID()},
				${fixture.nodeBId},
				${fixture.missionAId},
				${fixture.eventAId},
				${"turn"},
				1,
				1,
				${"delivery:turn-with-round"}
			)
		`).rejects.toThrow(/node_deliveries_verification_round_chk/);

		await expect(sql`
			INSERT INTO node_deliveries (
				id, node_id, mission_id, mission_event_id, kind, contract_version, idempotency_key
			) VALUES (
				${randomUUID()},
				${fixture.nodeBId},
				${fixture.missionAId},
				${fixture.eventAId},
				${"verification"},
				1,
				${"delivery:verification-without-round"}
			)
		`).rejects.toThrow(/node_deliveries_verification_round_chk/);

		await expect(sql`
			INSERT INTO node_deliveries (
				id, node_id, mission_id, mission_event_id, kind, contract_version,
				idempotency_key, settled_by_event_id
			) VALUES (
				${randomUUID()},
				${fixture.nodeBId},
				${fixture.missionAId},
				${fixture.eventAId},
				${"contract_acknowledgement"},
				1,
				${"delivery:settlement-without-time"},
				${fixture.eventAId}
			)
		`).rejects.toThrow(/node_deliveries_settlement_chk/);

		await expect(sql`
			INSERT INTO node_deliveries (
				id, node_id, mission_id, mission_event_id, kind, contract_version,
				idempotency_key, settled_at
			) VALUES (
				${randomUUID()},
				${fixture.nodeBId},
				${fixture.missionAId},
				${fixture.eventAId},
				${"contract_acknowledgement"},
				1,
				${"delivery:settlement-time-without-event"},
				${new Date()}
			)
		`).rejects.toThrow(/node_deliveries_settlement_chk/);
	});

	it("rejects partial and zero-attempt active leases", async () => {
		const fixture = await seedMigrationFixture(sql);

		await expect(sql`
			INSERT INTO node_deliveries (
				id, node_id, mission_id, mission_event_id, kind, status, attempt_count,
				last_fencing_token, active_lease_id, lease_expires_at, contract_version,
				verification_round, idempotency_key
			) VALUES (
				${randomUUID()},
				${fixture.nodeAId},
				${fixture.missionAId},
				${fixture.eventAId},
				${"verification"},
				${"leased"},
				1,
				${"1"},
				${randomUUID()},
				${null},
				1,
				1,
				${"delivery:partial-lease"}
			)
		`).rejects.toThrow(/node_deliveries_lease_chk/);

		await expect(sql`
			INSERT INTO node_deliveries (
				id, node_id, mission_id, mission_event_id, kind, status, attempt_count,
				last_fencing_token, active_lease_id, lease_expires_at, contract_version,
				verification_round, idempotency_key
			) VALUES (
				${randomUUID()},
				${fixture.nodeAId},
				${fixture.missionAId},
				${fixture.eventAId},
				${"verification"},
				${"executing"},
				0,
				${"0"},
				${randomUUID()},
				${new Date(Date.now() + 60_000)},
				1,
				1,
				${"delivery:zero-attempt-lease"}
			)
		`).rejects.toThrow(/node_deliveries_lease_chk/);
	});
});

interface MigrationFixture {
	readonly agentAId: string;
	readonly agentBId: string;
	readonly nodeAId: string;
	readonly nodeBId: string;
	readonly bindingAId: string;
	readonly bindingBId: string;
	readonly missionAId: string;
	readonly missionBId: string;
	readonly eventAId: string;
	readonly eventBId: string;
	readonly deliveryAId: string;
	readonly deliveryBId: string;
	readonly acceptanceA: AcceptanceReceipt;
	readonly acceptanceB: AcceptanceReceipt;
}

interface AcceptanceReceipt {
	readonly idempotency_key: string;
	readonly contract: {
		readonly artifact_id: string;
		readonly type: "api_contract";
		readonly version: 1;
		readonly sha256: string;
		readonly media_type: "application/json";
		readonly byte_size: number;
	};
	readonly local_policy_grant: {
		readonly profile_name: "bounded-code";
		readonly grant_sha256: string;
	};
}

async function applyMigration(sql: Sql, migration: string): Promise<void> {
	await sql.begin(async (tx) => {
		for (const statement of migration.split("--> statement-breakpoint")) {
			if (statement.trim()) await tx.unsafe(statement);
		}
	});
}

async function seedMigrationFixture(sql: Sql): Promise<MigrationFixture> {
	const agentAId = randomUUID();
	const agentBId = randomUUID();
	const nodeAId = randomUUID();
	const nodeBId = randomUUID();
	const bindingAId = randomUUID();
	const bindingBId = randomUUID();
	const missionAId = randomUUID();
	const missionBId = randomUUID();
	const eventAId = randomUUID();
	const eventBId = randomUUID();
	const deliveryAId = randomUUID();
	const deliveryBId = randomUUID();
	const acceptanceA = acceptanceReceipt(`accept:${missionAId}:a`, "a");
	const acceptanceB = acceptanceReceipt(`accept:${missionBId}:b`, "b");
	const acceptanceAForB = acceptanceReceipt(`accept:${missionAId}:b`, "c");

	await sql`
		INSERT INTO agents (id, handle) VALUES
			(${agentAId}, ${`agent-a-${agentAId}@acme`}),
			(${agentBId}, ${`agent-b-${agentBId}@acme`})
	`;
	await sql`
		INSERT INTO nodes (id, agent_id, name, capabilities) VALUES
			(${nodeAId}, ${agentAId}, ${"node-a"}, ${sql.json(["fake-runtime"])}),
			(${nodeBId}, ${agentBId}, ${"node-b"}, ${sql.json(["fake-runtime"])})
	`;
	await sql`
		INSERT INTO workspace_bindings (id, node_id, alias, repository_url, allowed_base_refs)
		VALUES
			(
				${bindingAId}, ${nodeAId}, ${"workspace-a"},
				${"https://github.com/example/a.git"}, ${["main"]}
			),
			(
				${bindingBId}, ${nodeBId}, ${"workspace-b"},
				${"https://github.com/example/b.git"}, ${["main"]}
			)
	`;
	await sql`
		INSERT INTO missions (id, created_by_agent_id, coordinator_config, state, status, expires_at)
		VALUES
			(
				${missionAId}, ${agentAId}, ${sql.json({ schema_version: 1 })},
				${sql.json({ status: "active" })}, ${"active"},
				${new Date(Date.now() + 60_000)}
			),
			(
				${missionBId}, ${agentBId}, ${sql.json({ schema_version: 1 })},
				${sql.json({ status: "active" })}, ${"active"},
				${new Date(Date.now() + 60_000)}
			)
	`;
	await sql`
		INSERT INTO mission_participants (
			mission_id, agent_id, node_id, workspace_binding_id, role, status, accepted_at,
			acceptance_idempotency_key, acceptance_receipt
		) VALUES
			(
				${missionAId}, ${agentAId}, ${nodeAId}, ${bindingAId}, ${"backend"},
				${"accepted"}, ${new Date()}, ${acceptanceA.idempotency_key},
				${sql.json(acceptanceA)}
			),
			(
				${missionAId}, ${agentBId}, ${nodeBId}, ${bindingBId}, ${"android"},
				${"accepted"}, ${new Date()}, ${acceptanceAForB.idempotency_key},
				${sql.json(acceptanceAForB)}
			),
			(
				${missionBId}, ${agentBId}, ${nodeBId}, ${bindingBId}, ${"android"},
				${"accepted"}, ${new Date()}, ${acceptanceB.idempotency_key},
				${sql.json(acceptanceB)}
			)
	`;
	await sql`
		INSERT INTO mission_events (
			id, mission_id, sequence_no, type, actor_agent_id, idempotency_key, payload
		) VALUES
			(
				${eventAId}, ${missionAId}, 1, ${"participants_accepted"}, ${agentAId},
				${"event:a"}, ${sql.json({ participant_agent_ids: [agentAId] })}
			),
			(
				${eventBId}, ${missionBId}, 1, ${"participants_accepted"}, ${agentBId},
				${"event:b"}, ${sql.json({ participant_agent_ids: [agentBId] })}
			)
	`;
	await sql`
		INSERT INTO node_deliveries (
			id, node_id, mission_id, mission_event_id, kind, contract_version, idempotency_key
		) VALUES
			(
				${deliveryAId}, ${nodeAId}, ${missionAId}, ${eventAId}, ${"turn"}, 1,
				${"delivery:a"}
			),
			(
				${deliveryBId}, ${nodeBId}, ${missionBId}, ${eventBId}, ${"turn"}, 1,
				${"delivery:b"}
			)
	`;

	return {
		agentAId,
		agentBId,
		nodeAId,
		nodeBId,
		bindingAId,
		bindingBId,
		missionAId,
		missionBId,
		eventAId,
		eventBId,
		deliveryAId,
		deliveryBId,
		acceptanceA,
		acceptanceB,
	};
}

function acceptanceReceipt(idempotencyKey: string, hashCharacter: string): AcceptanceReceipt {
	return {
		idempotency_key: idempotencyKey,
		contract: {
			artifact_id: randomUUID(),
			type: "api_contract",
			version: 1,
			sha256: hashCharacter.repeat(64),
			media_type: "application/json",
			byte_size: 128,
		},
		local_policy_grant: {
			profile_name: "bounded-code",
			grant_sha256: hashCharacter.repeat(64),
		},
	};
}
