import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tryConnect } from "./test-utils.js";

const TEST_URL = process.env.RELAY_TEST_DATABASE_URL ?? process.env.RELAY_DATABASE_URL;
const conn = await tryConnect();
const d = conn.available && TEST_URL ? describe : describe.skip;

if (!conn.available || !TEST_URL) {
	console.warn(`[migration-0007.test] skipping: ${conn.reason ?? "database URL unset"}`);
}

d("0007 delivery claims migration", () => {
	let sql: Sql;
	let migration: string;
	let fixture: MigrationFixture;
	const schemaName = `migration_0007_${randomUUID().replaceAll("-", "")}`;

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

		const durableLedgerMigration = await readFile(
			new URL("../../drizzle/0005_durable_delivery_ledger.sql", import.meta.url),
			"utf8",
		);
		const credentialMigration = await readFile(
			new URL("../../drizzle/0006_node_credentials.sql", import.meta.url),
			"utf8",
		);
		migration = await readFile(
			new URL("../../drizzle/0007_delivery_claims.sql", import.meta.url),
			"utf8",
		);
		await applyMigration(sql, durableLedgerMigration);
		await applyMigration(sql, credentialMigration);
		fixture = await seedMigrationFixture(sql);
		await applyMigration(sql, migration);
		await insertClaimReceipt(sql, fixture);
	});

	afterAll(async () => {
		if (sql) {
			await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
			await sql.end({ timeout: 2 });
		}
		if (conn.handle) await conn.handle.close();
	});

	it("reapplies without rewriting delivery state or exact operation receipts", async () => {
		await applyMigration(sql, migration);

		const [delivery] = await sql<
			Array<{
				id: string;
				status: string;
				attempt_count: number;
				last_fencing_token: string;
				cancelled_at: Date | null;
				cancellation_reason: string | null;
			}>
		>`
			SELECT id, status, attempt_count, last_fencing_token, cancelled_at, cancellation_reason
			FROM node_deliveries
			WHERE id = ${fixture.deliveryId}
		`;
		expect(delivery).toEqual({
			id: fixture.deliveryId,
			status: "stored",
			attempt_count: 0,
			last_fencing_token: "0",
			cancelled_at: null,
			cancellation_reason: null,
		});

		const receipts = await sql<Array<{ input: unknown; output: unknown }>>`
			SELECT input, output
			FROM delivery_operation_receipts
			WHERE node_id = ${fixture.nodeId} AND idempotency_key = ${"claim:one"}
		`;
		expect(receipts).toEqual([
			{
				input: { idempotency_key: "claim:one" },
				output: { delivery_id: fixture.deliveryId, status: "leased" },
			},
		]);
	});

	it("enforces fencing, cancellation, capacity, and active-lease projection invariants", async () => {
		const first = await insertDelivery(sql, fixture, "delivery:first-active");
		const second = await insertDelivery(sql, fixture, "delivery:second-active");
		const activeLeaseId = randomUUID();
		const expiresAt = new Date(Date.now() + 60_000);

		await expect(sql`
			UPDATE node_deliveries
			SET attempt_count = 1, last_fencing_token = ${"2"}
			WHERE id = ${first}
		`).rejects.toThrow(/node_deliveries_fencing_token_chk/);

		await sql`
			UPDATE node_deliveries
			SET status = 'leased', attempt_count = 1, last_fencing_token = '1',
				active_lease_id = ${activeLeaseId}, lease_expires_at = ${expiresAt}
			WHERE id = ${first}
		`;
		await expect(sql`
			UPDATE node_deliveries
			SET status = 'leased', attempt_count = 1, last_fencing_token = '1',
				active_lease_id = ${activeLeaseId}, lease_expires_at = ${expiresAt}
			WHERE id = ${second}
		`).rejects.toThrow(/idx_node_deliveries_active_lease/);

		await expect(sql`
			UPDATE node_deliveries
			SET status = 'cancelled', cancellation_reason = 'node_revoked'
			WHERE id = ${second}
		`).rejects.toThrow(/node_deliveries_cancelled_at_chk/);
		await sql`
			UPDATE node_deliveries
			SET status = 'cancelled', cancelled_at = clock_timestamp(),
				cancellation_reason = 'node_revoked'
			WHERE id = ${second}
		`;

		const exhausted = await insertDelivery(sql, fixture, "delivery:exhausted");
		await expect(sql`
			UPDATE node_deliveries
			SET attempt_count = max_attempts, last_fencing_token = max_attempts::text
			WHERE id = ${exhausted}
		`).rejects.toThrow(/node_deliveries_stored_capacity_chk/);

		const invalidMaximum = await insertDelivery(sql, fixture, "delivery:invalid-maximum");
		await expect(sql`
			UPDATE node_deliveries SET max_attempts = 101 WHERE id = ${invalidMaximum}
		`).rejects.toThrow(/node_deliveries_attempt_chk/);
	});

	it("keeps Node idempotency and delivery ownership exact", async () => {
		await expect(sql`
			INSERT INTO delivery_operation_receipts (
				origin, node_id, mission_id, delivery_id, operation, idempotency_key,
				credential_id, attempt_count, lease_id, fencing_token, lease_expires_at,
				status_before, status_after, input, output
			) VALUES (
				'node', ${fixture.nodeId}, ${fixture.missionId}, ${fixture.deliveryId},
				'start', 'claim:one', ${fixture.credentialId}, 1, ${randomUUID()}, '1',
				${new Date(Date.now() + 60_000)}, 'leased', 'executing',
				${sql.json({ idempotency_key: "claim:one" })}, ${sql.json({ status: "executing" })}
			)
		`).rejects.toThrow(/idx_delivery_operation_receipts_node_idempotency/);

		await expect(sql`
			INSERT INTO delivery_operation_receipts (
				origin, node_id, mission_id, delivery_id, operation, idempotency_key,
				attempt_count, status_before, status_after, cancellation_reason, input, output
			) VALUES (
				'relay', ${fixture.nodeId}, ${fixture.otherMissionId}, ${fixture.deliveryId},
				'cancel', 'cancel:wrong-mission', 0, 'stored', 'cancelled', 'mission_cancelled',
				${sql.json({ reason: "mission_cancelled" })}, ${sql.json({ status: "cancelled" })}
			)
		`).rejects.toThrow(/delivery_operation_receipts_delivery_owner_fk/);

		await expect(sql`
			INSERT INTO delivery_operation_receipts (
				origin, node_id, mission_id, delivery_id, operation, idempotency_key,
				credential_id, attempt_count, lease_id, fencing_token, lease_expires_at,
				status_before, status_after, input, output
			) VALUES (
				'node', ${fixture.nodeId}, ${fixture.missionId}, ${fixture.deliveryId},
				'start', 'start:wrong-credential', ${fixture.otherCredentialId}, 1,
				${randomUUID()}, '1', ${new Date(Date.now() + 60_000)}, 'leased', 'executing',
				${sql.json({ idempotency_key: "start:wrong-credential" })},
				${sql.json({ status: "executing" })}
			)
		`).rejects.toThrow(/delivery_operation_receipts_credential_node_fk/);
	});

	it("records terminal claim recovery without issuing new lease authority", async () => {
		await sql`
			INSERT INTO delivery_operation_receipts (
				origin, node_id, mission_id, delivery_id, operation, idempotency_key,
				credential_id, attempt_count, status_before, status_after, input, output
			) VALUES (
				'node', ${fixture.nodeId}, ${fixture.missionId}, ${fixture.deliveryId},
				'claim', 'claim:terminal', ${fixture.credentialId}, 5,
				'executing', 'dead_lettered', ${sql.json({ idempotency_key: "claim:terminal" })},
				${sql.json({ outcome: "dead_lettered" })}
			)
		`;
		await applyMigration(sql, migration);
		const [terminal] = await sql<
			Array<{ lease_id: string | null; fencing_token: string | null; status_after: string }>
		>`
			SELECT lease_id, fencing_token, status_after
			FROM delivery_operation_receipts
			WHERE node_id = ${fixture.nodeId} AND idempotency_key = 'claim:terminal'
		`;
		expect(terminal).toEqual({
			lease_id: null,
			fencing_token: null,
			status_after: "dead_lettered",
		});

		await expect(sql`
			INSERT INTO delivery_operation_receipts (
				origin, node_id, mission_id, delivery_id, operation, idempotency_key,
				credential_id, attempt_count, status_before, status_after, input, output
			) VALUES (
				'node', ${fixture.nodeId}, ${fixture.missionId}, ${fixture.deliveryId},
				'claim', 'claim:missing-lease', ${fixture.credentialId}, 2,
				'stored', 'leased', ${sql.json({ idempotency_key: "claim:missing-lease" })},
				${sql.json({ status: "leased" })}
			)
		`).rejects.toThrow(/delivery_operation_receipts_lease_chk/);

		await expect(sql`
			INSERT INTO delivery_operation_receipts (
				origin, node_id, mission_id, delivery_id, operation, idempotency_key,
				credential_id, attempt_count, lease_id, fencing_token, lease_expires_at,
				status_before, status_after, input, output
			) VALUES (
				'node', ${fixture.nodeId}, ${fixture.missionId}, ${fixture.deliveryId},
				'claim', 'claim:duplicate-attempt', ${fixture.credentialId}, 1,
				${randomUUID()}, '1', ${new Date(Date.now() + 60_000)}, 'stored', 'leased',
				${sql.json({ idempotency_key: "claim:duplicate-attempt" })},
				${sql.json({ status: "leased" })}
			)
		`).rejects.toThrow(/idx_delivery_operation_receipts_claim_attempt/);
	});

	it("allows relay recovery receipts without credentials or lease authority", async () => {
		await sql`
			INSERT INTO delivery_operation_receipts (
				origin, node_id, mission_id, delivery_id, operation, idempotency_key,
				attempt_count, status_before, status_after, input, output
			) VALUES (
				'relay', ${fixture.nodeId}, ${fixture.missionId}, ${fixture.deliveryId},
				'lease_expired', 'expiry:one', 1, 'leased', 'stored',
				${sql.json({ recovery: true })}, ${sql.json({ status: "stored" })}
			)
		`;

		await sql`
			INSERT INTO delivery_operation_receipts (
				origin, node_id, mission_id, delivery_id, operation, idempotency_key,
				attempt_count, status_before, status_after, cancellation_reason, input, output
			) VALUES (
				'relay', ${fixture.nodeId}, ${fixture.missionId}, ${fixture.deliveryId},
				'cancel', 'cancel:one', 0, 'stored', 'cancelled', 'node_revoked',
				${sql.json({ reason: "node_revoked" })}, ${sql.json({ status: "cancelled" })}
			)
		`;

		const rows = await sql<
			Array<{ operation: string; credential_id: string | null; lease_id: string | null }>
		>`
			SELECT operation, credential_id, lease_id
			FROM delivery_operation_receipts
			WHERE idempotency_key IN ('expiry:one', 'cancel:one')
			ORDER BY operation
		`;
		expect(rows).toEqual([
			{ operation: "cancel", credential_id: null, lease_id: null },
			{ operation: "lease_expired", credential_id: null, lease_id: null },
		]);
	});

	it("rejects invalid operation transitions and unbounded receipt JSON", async () => {
		await sql`
			INSERT INTO delivery_operation_receipts (
				origin, node_id, mission_id, delivery_id, operation, idempotency_key,
				credential_id, attempt_count, lease_id, fencing_token, lease_expires_at,
				status_before, status_after, input, output
			) VALUES (
				'node', ${fixture.nodeId}, ${fixture.missionId}, ${fixture.deliveryId},
				'complete', 'complete:executing', ${fixture.credentialId}, 1,
				${randomUUID()}, '1', ${new Date(Date.now() + 60_000)}, 'executing', 'acknowledged',
				${sql.json({ idempotency_key: "complete:executing" })},
				${sql.json({ status: "acknowledged" })}
			)
		`;

		await expect(sql`
			INSERT INTO delivery_operation_receipts (
				origin, node_id, mission_id, delivery_id, operation, idempotency_key,
				credential_id, attempt_count, lease_id, fencing_token, lease_expires_at,
				status_before, status_after, input, output
			) VALUES (
				'node', ${fixture.nodeId}, ${fixture.missionId}, ${fixture.deliveryId},
				'complete', 'complete:without-start', ${fixture.credentialId}, 1,
				${randomUUID()}, '1', ${new Date(Date.now() + 60_000)}, 'leased', 'acknowledged',
				${sql.json({ idempotency_key: "complete:without-start" })},
				${sql.json({ status: "acknowledged" })}
			)
		`).rejects.toThrow(/delivery_operation_receipts_transition_chk/);

		await expect(sql`
			INSERT INTO delivery_operation_receipts (
				origin, node_id, mission_id, delivery_id, operation, idempotency_key,
				attempt_count, status_before, status_after, cancellation_reason, input, output
			) VALUES (
				'relay', ${fixture.nodeId}, ${fixture.missionId}, ${fixture.deliveryId},
				'cancel', 'cancel:invalid-transition', 0, 'acknowledged', 'cancelled',
				'node_revoked', ${sql.json({})}, ${sql.json({ status: "cancelled" })}
			)
		`).rejects.toThrow(/delivery_operation_receipts_transition_chk/);

		await expect(sql`
			INSERT INTO delivery_operation_receipts (
				origin, node_id, mission_id, delivery_id, operation, idempotency_key,
				attempt_count, status_before, status_after, cancellation_reason, input, output
			) VALUES (
				'relay', ${fixture.nodeId}, ${fixture.missionId}, ${fixture.deliveryId},
				'cancel', 'cancel:array-input', 0, 'stored', 'cancelled', 'node_revoked',
				${sql.json([])}, ${sql.json({ status: "cancelled" })}
			)
		`).rejects.toThrow(/delivery_operation_receipts_input_chk/);

		await expect(sql`
			INSERT INTO delivery_operation_receipts (
				origin, node_id, mission_id, delivery_id, operation, idempotency_key,
				attempt_count, status_before, status_after, cancellation_reason, input, output
			) VALUES (
				'relay', ${fixture.nodeId}, ${fixture.missionId}, ${fixture.deliveryId},
				'cancel', 'cancel:oversized-output', 0, 'stored', 'cancelled', 'node_revoked',
				${sql.json({})}, jsonb_build_object('payload', repeat('x', 1048577))
			)
		`).rejects.toThrow(/delivery_operation_receipts_output_chk/);
	});

	it("installs claim uniqueness plus due and expiry recovery indexes", async () => {
		const indexes = await sql<Array<{ indexname: string }>>`
			SELECT indexname
			FROM pg_indexes
			WHERE schemaname = ${schemaName}
		`;
		const names = new Set(indexes.map((row) => row.indexname));
		for (const name of [
			"idx_node_deliveries_active_lease",
			"idx_node_deliveries_due",
			"idx_node_deliveries_recovery",
			"idx_delivery_operation_receipts_node_idempotency",
			"idx_delivery_operation_receipts_delivery_history",
			"idx_delivery_operation_receipts_claim_attempt",
			"idx_delivery_operation_receipts_claim_lease",
		]) {
			expect(names.has(name)).toBe(true);
		}
	});
});

interface MigrationFixture {
	readonly agentId: string;
	readonly nodeId: string;
	readonly credentialId: string;
	readonly otherCredentialId: string;
	readonly missionId: string;
	readonly otherMissionId: string;
	readonly deliveryId: string;
	readonly nextSequence: { value: number };
}

async function applyMigration(sql: Sql, migration: string): Promise<void> {
	await sql.begin(async (tx) => {
		for (const statement of migration.split("--> statement-breakpoint")) {
			if (statement.trim()) await tx.unsafe(statement);
		}
	});
}

async function seedMigrationFixture(sql: Sql): Promise<MigrationFixture> {
	const agentId = randomUUID();
	const otherAgentId = randomUUID();
	const nodeId = randomUUID();
	const otherNodeId = randomUUID();
	const credentialId = randomUUID();
	const otherCredentialId = randomUUID();
	const bindingId = randomUUID();
	const otherBindingId = randomUUID();
	const missionId = randomUUID();
	const otherMissionId = randomUUID();
	const eventId = randomUUID();
	const deliveryId = randomUUID();

	await sql`
		INSERT INTO agents (id, handle)
		VALUES (${agentId}, 'agent-a'), (${otherAgentId}, 'agent-b')
	`;
	await sql`
		INSERT INTO nodes (id, agent_id, name)
		VALUES (${nodeId}, ${agentId}, 'node-a'), (${otherNodeId}, ${otherAgentId}, 'node-b')
	`;
	await sql`
		INSERT INTO node_credentials (id, node_id, key_hash, salt)
		VALUES
			(${credentialId}, ${nodeId}, decode('aa', 'hex'), decode('ab', 'hex')),
			(${otherCredentialId}, ${otherNodeId}, decode('ba', 'hex'), decode('bb', 'hex'))
	`;
	await sql`
		INSERT INTO workspace_bindings (id, node_id, alias, repository_url)
		VALUES
			(${bindingId}, ${nodeId}, 'primary', 'https://example.test/a.git'),
			(${otherBindingId}, ${otherNodeId}, 'primary', 'https://example.test/b.git')
	`;
	await sql`
		INSERT INTO missions (id, created_by_agent_id, coordinator_config, state, expires_at)
		VALUES
			(${missionId}, ${agentId}, ${sql.json({})}, ${sql.json({})}, ${new Date(Date.now() + 60_000)}),
			(${otherMissionId}, ${agentId}, ${sql.json({})}, ${sql.json({})}, ${new Date(Date.now() + 60_000)})
	`;
	await sql`
		INSERT INTO mission_participants (
			mission_id, agent_id, node_id, workspace_binding_id, role
		) VALUES
			(${missionId}, ${agentId}, ${nodeId}, ${bindingId}, 'backend'),
			(${otherMissionId}, ${agentId}, ${nodeId}, ${bindingId}, 'backend')
	`;
	await sql`
		INSERT INTO mission_events (
			id, mission_id, sequence_no, type, actor_agent_id, idempotency_key, payload
		) VALUES (
			${eventId}, ${missionId}, 1, 'participants_accepted', ${agentId},
			'event:initial', ${sql.json({})}
		)
	`;
	await sql`
		INSERT INTO node_deliveries (
			id, node_id, mission_id, mission_event_id, kind, contract_version, idempotency_key
		) VALUES (
			${deliveryId}, ${nodeId}, ${missionId}, ${eventId}, 'turn', 1, 'delivery:initial'
		)
	`;

	return {
		agentId,
		nodeId,
		credentialId,
		otherCredentialId,
		missionId,
		otherMissionId,
		deliveryId,
		nextSequence: { value: 2 },
	};
}

async function insertDelivery(
	sql: Sql,
	fixture: MigrationFixture,
	idempotencyKey: string,
): Promise<string> {
	const eventId = randomUUID();
	const deliveryId = randomUUID();
	const sequence = fixture.nextSequence.value;
	fixture.nextSequence.value += 1;
	await sql`
		INSERT INTO mission_events (
			id, mission_id, sequence_no, type, actor_agent_id, idempotency_key, payload
		) VALUES (
			${eventId}, ${fixture.missionId}, ${sequence}, 'participants_accepted',
			${fixture.agentId}, ${`event:${idempotencyKey}`}, ${sql.json({})}
		)
	`;
	await sql`
		INSERT INTO node_deliveries (
			id, node_id, mission_id, mission_event_id, kind, contract_version, idempotency_key
		) VALUES (
			${deliveryId}, ${fixture.nodeId}, ${fixture.missionId}, ${eventId},
			'turn', 1, ${idempotencyKey}
		)
	`;
	return deliveryId;
}

async function insertClaimReceipt(sql: Sql, fixture: MigrationFixture): Promise<void> {
	await sql`
		INSERT INTO delivery_operation_receipts (
			origin, node_id, mission_id, delivery_id, operation, idempotency_key,
			credential_id, attempt_count, lease_id, fencing_token, lease_expires_at,
			status_before, status_after, input, output
		) VALUES (
			'node', ${fixture.nodeId}, ${fixture.missionId}, ${fixture.deliveryId},
			'claim', 'claim:one', ${fixture.credentialId}, 1, ${randomUUID()}, '1',
			${new Date(Date.now() + 60_000)}, 'stored', 'leased',
			${sql.json({ idempotency_key: "claim:one" })},
			${sql.json({ delivery_id: fixture.deliveryId, status: "leased" })}
		)
	`;
}
