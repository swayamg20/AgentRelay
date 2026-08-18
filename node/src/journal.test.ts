import type {
	MissionDeliveryItem,
	MissionParticipantAcceptanceInput,
	StartTurnInput,
} from "@agentrelay/protocol";
import { describe, expect, it } from "vitest";
import { type JournalStorage, NodeJournal, type NodeJournalState } from "./journal.js";
import { authorityGrant } from "./runtime-authority.test-support.js";

const IDS = {
	mission: "10000000-0000-4000-8000-000000000001",
	node: "10000000-0000-4000-8000-000000000002",
	actor: "10000000-0000-4000-8000-000000000003",
	other: "10000000-0000-4000-8000-000000000004",
	delivery: "10000000-0000-4000-8000-000000000005",
	event: "10000000-0000-4000-8000-000000000006",
	artifact: "10000000-0000-4000-8000-000000000007",
	lease1: "10000000-0000-4000-8000-000000000008",
	lease2: "10000000-0000-4000-8000-000000000009",
	grant2: "10000000-0000-4000-8000-000000000010",
	lease3: "10000000-0000-4000-8000-000000000012",
} as const;

describe("NodeJournal", () => {
	it("migrates an empty v1 journal to schema 4 with a null Mission assignment cursor", async () => {
		const storage = new MemoryStorage();
		storage.state = {
			schema_version: 1,
			cursor: null,
			deliveries: {},
			mission_sessions: {},
			mission_acceptances: {},
		};

		const journal = await NodeJournal.open(storage);

		expect(journal.snapshot().schema_version).toBe(4);
		expect(journal.snapshot().mission_assignment_cursor).toBeNull();
		expect(storage.saved).toHaveLength(1);
		expect(storage.saved[0]?.schema_version).toBe(4);
		expect(storage.saved[0]?.mission_assignment_cursor).toBeNull();
	});

	it("migrates populated schema 2 deliveries with no invented runtime authority", async () => {
		const storage = new MemoryStorage();
		const current = await NodeJournal.open(storage);
		await current.ingestCursorPage([storedItem()], "7");
		const legacy = structuredClone(storage.state) as Record<string, unknown>;
		legacy.schema_version = 2;
		const deliveries = legacy.deliveries as Record<string, Record<string, unknown>>;
		delete deliveries[IDS.delivery]?.runtime_authority;
		storage.state = legacy;

		const migrated = await NodeJournal.open(storage);

		expect(migrated.snapshot().schema_version).toBe(4);
		expect(migrated.snapshot().deliveries[IDS.delivery]?.runtime_authority).toBeNull();
		expect(migrated.snapshot().deliveries[IDS.delivery]?.runtime_authority_predecessor).toBeNull();
	});

	it("migrates schema 3 authority checkpoints with no invented predecessor", async () => {
		const storage = new MemoryStorage();
		const current = await NodeJournal.open(storage);
		await current.ingestCursorPage([storedItem()], "7");
		const grant = authorityGrant({
			node_id: IDS.node,
			mission_id: IDS.mission,
			delivery_id: IDS.delivery,
			execution_attempt: 1,
		});
		await current.checkpointRuntimeAuthority(IDS.delivery, grant);
		const legacy = structuredClone(storage.state) as Record<string, unknown>;
		legacy.schema_version = 3;
		const deliveries = legacy.deliveries as Record<string, Record<string, unknown>>;
		delete deliveries[IDS.delivery]?.runtime_authority_predecessor;
		storage.state = legacy;

		const migrated = await NodeJournal.open(storage);

		expect(migrated.snapshot().schema_version).toBe(4);
		expect(migrated.snapshot().deliveries[IDS.delivery]?.runtime_authority).toEqual(grant);
		expect(migrated.snapshot().deliveries[IDS.delivery]?.runtime_authority_predecessor).toBeNull();
	});

	it("fails closed instead of inventing start inputs for v1 delivery state", async () => {
		const storage = new MemoryStorage();
		const current = await NodeJournal.open(storage);
		await current.ingestCursorPage([storedItem()], "7");
		const legacy = structuredClone(storage.state) as Record<string, unknown>;
		legacy.schema_version = 1;
		storage.state = legacy;

		await expect(NodeJournal.open(storage)).rejects.toThrow(
			"schema 1 with deliveries cannot be migrated safely",
		);
	});

	it("reopens the durable Mission assignment continuation cursor", async () => {
		const storage = new MemoryStorage();
		const journal = await NodeJournal.open(storage);
		await journal.setMissionAssignmentCursor(IDS.mission);

		const reopened = await NodeJournal.open(storage);

		expect(reopened.snapshot().mission_assignment_cursor).toBe(IDS.mission);
	});

	it("persists discovered work before advancing its cursor", async () => {
		const storage = new MemoryStorage();
		const journal = await NodeJournal.open(storage);
		await journal.ingestCursorPage([storedItem()], "7", new Date("2026-08-02T00:00:01Z"));

		const persisted = storage.saved.at(-1)!;
		expect(persisted.cursor).toBe("7");
		expect(persisted.deliveries[IDS.delivery]?.phase).toBe("ingested");
		expect(storage.saved).toHaveLength(2);
	});

	it("accepts exact replay but rejects changed immutable delivery content", async () => {
		const journal = await NodeJournal.open(new MemoryStorage());
		const item = storedItem();
		await journal.ingestCursorPage([item], "7");
		await expect(journal.ingestRecoverable([structuredClone(item)])).resolves.toBeUndefined();

		const changed = structuredClone(item);
		changed.event.idempotency_key = "changed-event";
		await expect(journal.ingestRecoverable([changed])).rejects.toThrow(
			"delivery replay changed immutable content",
		);
	});

	it("reopens pending operation intents exactly", async () => {
		const storage = new MemoryStorage();
		const journal = await NodeJournal.open(storage);
		await journal.ingestCursorPage([storedItem()], "7");
		await journal.updateDelivery(IDS.delivery, (entry) => {
			entry.claim_attempt = 1;
			entry.phase = "claim_intent";
			entry.operation = {
				kind: "claim",
				input: { idempotency_key: `claim:${IDS.delivery}:1` },
			};
		});

		const reopened = await NodeJournal.open(storage);
		expect(reopened.snapshot().deliveries[IDS.delivery]?.operation).toEqual({
			kind: "claim",
			input: { idempotency_key: `claim:${IDS.delivery}:1` },
		});
	});

	it("reopens the exact checkpointed start input", async () => {
		const storage = new MemoryStorage();
		const journal = await NodeJournal.open(storage);
		await journal.ingestCursorPage([storedItem()], "7");
		const input = hostStartInput();
		await journal.setMissionSession(input.session);
		await journal.updateDelivery(IDS.delivery, (entry) => {
			entry.host_session = structuredClone(input.session);
		});
		await journal.checkpointStartTurnInput(IDS.delivery, input);

		const reopened = await NodeJournal.open(storage);

		expect(reopened.snapshot().deliveries[IDS.delivery]?.start_turn_input).toEqual(input);
	});

	it("reopens one exact runtime authority checkpoint", async () => {
		const storage = new MemoryStorage();
		const journal = await NodeJournal.open(storage);
		await journal.ingestCursorPage([storedItem()], "7");
		const grant = authorityGrant({
			node_id: IDS.node,
			mission_id: IDS.mission,
			delivery_id: IDS.delivery,
			execution_attempt: 1,
		});

		await journal.checkpointRuntimeAuthority(IDS.delivery, grant);
		const reopened = await NodeJournal.open(storage);

		expect(reopened.snapshot().deliveries[IDS.delivery]?.runtime_authority).toEqual(grant);
		await expect(
			reopened.checkpointRuntimeAuthority(IDS.delivery, {
				...grant,
				policy_grant_sha256: "c".repeat(64),
			}),
		).rejects.toThrow("changed within execution attempt");
	});

	it("stages a grant when recovery ingestion advances the Relay fence", async () => {
		const storage = new MemoryStorage();
		const journal = await NodeJournal.open(storage);
		await journal.ingestCursorPage([executingItem(1)], "7");
		const grant = fencedAuthority(1);
		await journal.checkpointRuntimeAuthority(IDS.delivery, grant);

		await journal.ingestRecoverable([executingItem(2)]);
		const reopened = await NodeJournal.open(storage);
		const staged = reopened.snapshot().deliveries[IDS.delivery]!;

		expect(staged.runtime_authority).toBeNull();
		expect(staged.runtime_authority_predecessor).toEqual(grant);
		expect(staged.item.delivery.lease?.fencing_token).toBe("2");
	});

	it("rejects a stale delivery fence while predecessor retirement is pending", async () => {
		const journal = await NodeJournal.open(new MemoryStorage());
		await journal.ingestCursorPage([executingItem(1)], "7");
		await journal.checkpointRuntimeAuthority(IDS.delivery, fencedAuthority(1));
		await journal.ingestRecoverable([executingItem(2)]);
		await journal.ingestRecoverable([executingItem(3)]);

		await expect(journal.ingestRecoverable([executingItem(2)])).rejects.toThrow(
			"delivery fence moved backwards",
		);
		expect(journal.snapshot().deliveries[IDS.delivery]?.item.delivery.lease?.fencing_token).toBe(
			"3",
		);
	});

	it("rejects stale lease-null snapshots while predecessor retirement is pending", async () => {
		const journal = await NodeJournal.open(new MemoryStorage());
		await journal.ingestCursorPage([executingItem(1)], "7");
		const predecessor = fencedAuthority(1);
		await journal.checkpointRuntimeAuthority(IDS.delivery, predecessor);
		await journal.ingestRecoverable([executingItem(2)]);
		await journal.ingestRecoverable([executingItem(3)]);
		const staleTerminal = executingItem(2);
		staleTerminal.delivery = {
			...staleTerminal.delivery,
			status: "dead_lettered",
			lease: null,
			dead_lettered_at: "2026-08-02T00:31:00.000Z",
			updated_at: "2026-08-02T00:31:00.000Z",
		};
		const staleStored: MissionDeliveryItem["delivery"] = {
			...storedItem().delivery,
			attempt_count: 2,
			last_fencing_token: "2",
			updated_at: "2026-08-02T00:31:00.000Z",
		};

		await expect(journal.ingestRecoverable([staleTerminal])).rejects.toThrow(
			"delivery fence moved backwards",
		);
		await expect(journal.replaceDeliveryState(staleStored)).rejects.toThrow(
			"delivery fence moved backwards",
		);

		const current = journal.snapshot().deliveries[IDS.delivery]!;
		expect(current.item.delivery.lease?.fencing_token).toBe("3");
		expect(current.runtime_authority).toBeNull();
		expect(current.runtime_authority_predecessor).toEqual(predecessor);
	});

	it("rejects a same-fence lease identity change while predecessor retirement is pending", async () => {
		const journal = await NodeJournal.open(new MemoryStorage());
		await journal.ingestCursorPage([executingItem(1)], "7");
		await journal.checkpointRuntimeAuthority(IDS.delivery, fencedAuthority(1));
		await journal.ingestRecoverable([executingItem(2)]);
		const changedLease = executingItem(2);
		changedLease.delivery.lease = { ...changedLease.delivery.lease!, lease_id: IDS.lease3 };

		await expect(journal.ingestRecoverable([changedLease])).rejects.toThrow(
			"lease changed without a new fence",
		);
	});

	it("rejects same-fence lease expiry rollback while predecessor retirement is pending", async () => {
		const journal = await NodeJournal.open(new MemoryStorage());
		await journal.ingestCursorPage([executingItem(1)], "7");
		await journal.checkpointRuntimeAuthority(IDS.delivery, fencedAuthority(1));
		await journal.ingestRecoverable([executingItem(2)]);
		const rolledBack = executingItem(2);
		rolledBack.delivery.lease = {
			...rolledBack.delivery.lease!,
			expires_at: "2026-08-02T00:25:00.000Z",
		};

		await expect(journal.ingestRecoverable([rolledBack])).rejects.toThrow(
			"lease expiry moved backwards",
		);
	});

	it("accepts exact replay and same-fence lease extension while predecessor retirement is pending", async () => {
		const journal = await NodeJournal.open(new MemoryStorage());
		await journal.ingestCursorPage([executingItem(1)], "7");
		const predecessor = fencedAuthority(1);
		await journal.checkpointRuntimeAuthority(IDS.delivery, predecessor);
		const successor = executingItem(2);
		await journal.ingestRecoverable([successor]);

		await expect(journal.ingestRecoverable([structuredClone(successor)])).resolves.toBeUndefined();
		const extended = executingItem(2);
		extended.delivery.lease = {
			...extended.delivery.lease!,
			expires_at: "2026-08-02T00:35:00.000Z",
		};
		await expect(journal.ingestRecoverable([extended])).resolves.toBeUndefined();

		const current = journal.snapshot().deliveries[IDS.delivery]!;
		expect(current.item.delivery.lease?.expires_at).toBe("2026-08-02T00:35:00.000Z");
		expect(current.runtime_authority_predecessor).toEqual(predecessor);
	});

	it("retains a staged predecessor as the terminal retirement handle", async () => {
		const journal = await NodeJournal.open(new MemoryStorage());
		await journal.ingestCursorPage([executingItem(1)], "7");
		const predecessor = fencedAuthority(1);
		await journal.checkpointRuntimeAuthority(IDS.delivery, predecessor);
		await journal.ingestRecoverable([executingItem(2)]);
		const deadLettered: MissionDeliveryItem["delivery"] = {
			...executingItem(2).delivery,
			status: "dead_lettered",
			lease: null,
			dead_lettered_at: "2026-08-02T00:31:00.000Z",
			updated_at: "2026-08-02T00:31:00.000Z",
		};

		await journal.replaceDeliveryState(deadLettered);

		const terminal = journal.snapshot().deliveries[IDS.delivery]!;
		expect(terminal.runtime_authority).toEqual(predecessor);
		expect(terminal.runtime_authority_predecessor).toBeNull();
		expect(terminal.item.delivery.status).toBe("dead_lettered");
	});

	it("CAS-promotes only an exact-scope successor and preserves its hard deadline", async () => {
		const journal = await NodeJournal.open(new MemoryStorage());
		await journal.ingestCursorPage([executingItem(1)], "7");
		const predecessor = fencedAuthority(1);
		await journal.checkpointRuntimeAuthority(IDS.delivery, predecessor);
		await journal.ingestRecoverable([executingItem(2)]);
		const successor = fencedAuthority(2, predecessor);
		const expectation = {
			lease_id: IDS.lease2,
			fencing_token: "2",
			lease_expires_at: "2026-08-02T00:30:00.000Z",
			active_grant_id: null,
			predecessor_grant_id: predecessor.grant_id,
		};

		await expect(
			journal.checkpointRuntimeAuthority(
				IDS.delivery,
				{ ...successor, policy_grant_sha256: "c".repeat(64) },
				new Date(),
				expectation,
			),
		).rejects.toThrow("successor changed trusted scope");
		await journal.checkpointRuntimeAuthority(IDS.delivery, successor, new Date(), expectation);

		const promoted = journal.snapshot().deliveries[IDS.delivery]!;
		expect(promoted.runtime_authority).toEqual(successor);
		expect(promoted.runtime_authority?.hard_expires_at).toBe(predecessor.hard_expires_at);
		expect(promoted.runtime_authority_predecessor).toBeNull();
	});

	it("persists terminal Mission acceptance quarantine and forbids resubmission", async () => {
		const storage = new MemoryStorage();
		const journal = await NodeJournal.open(storage);
		const input = missionAcceptanceInput();
		await journal.recordMissionAcceptance(IDS.mission, input, "pending");
		await journal.quarantineMissionAcceptance(IDS.mission, "Relay 409: Mission expired");

		const reopened = await NodeJournal.open(storage);
		expect(reopened.snapshot().mission_acceptances[IDS.mission]).toEqual({
			input,
			status: "quarantined",
			last_error: "Relay 409: Mission expired",
		});
		await expect(reopened.recordMissionAcceptance(IDS.mission, input, "pending")).rejects.toThrow(
			"cannot be resubmitted",
		);
	});
});

class MemoryStorage implements JournalStorage {
	state: unknown | null = null;
	readonly saved: NodeJournalState[] = [];

	async load(): Promise<unknown | null> {
		return structuredClone(this.state);
	}

	async save(state: NodeJournalState): Promise<void> {
		this.state = structuredClone(state);
		this.saved.push(structuredClone(state));
	}
}

function storedItem(): MissionDeliveryItem {
	const timestamp = "2026-08-02T00:00:00.000Z";
	return {
		delivery: {
			delivery_id: IDS.delivery,
			node_id: IDS.node,
			mission_id: IDS.mission,
			mission_event_id: IDS.event,
			kind: "turn",
			cursor: "7",
			status: "stored",
			attempt_count: 0,
			max_attempts: 3,
			last_fencing_token: "0",
			contract_version: 1,
			verification_round: null,
			lease: null,
			logical_settlement: null,
			idempotency_key: "delivery:7",
			causal_parent_delivery_id: null,
			available_at: timestamp,
			created_at: timestamp,
			updated_at: timestamp,
			acknowledged_at: null,
			cancelled_at: null,
			cancellation_reason: null,
			dead_lettered_at: null,
		},
		event: {
			type: "participants_accepted",
			event_id: IDS.event,
			idempotency_key: "participants:accepted",
			mission_id: IDS.mission,
			sequence_no: 1,
			created_at: timestamp,
			participant_agent_ids: [IDS.actor, IDS.other],
			contract: {
				artifact_id: IDS.artifact,
				type: "api_contract",
				version: 1,
				sha256: "a".repeat(64),
				media_type: "application/json",
				byte_size: 2,
			},
		},
		actor_agent_id: IDS.actor,
		source_delivery_id: null,
		causal_parent_event_id: null,
	};
}

function executingItem(fence: 1 | 2 | 3): MissionDeliveryItem {
	const item = storedItem();
	const leaseId = fence === 1 ? IDS.lease1 : fence === 2 ? IDS.lease2 : IDS.lease3;
	const expiresAt =
		fence === 1
			? "2026-08-02T00:20:00.000Z"
			: fence === 2
				? "2026-08-02T00:30:00.000Z"
				: "2026-08-02T00:40:00.000Z";
	item.delivery = {
		...item.delivery,
		status: "executing",
		attempt_count: fence,
		last_fencing_token: String(fence),
		lease: { lease_id: leaseId, fencing_token: String(fence), expires_at: expiresAt },
		updated_at: `2026-08-02T00:0${fence}:00.000Z`,
	};
	return item;
}

function fencedAuthority(
	fence: 1 | 2,
	predecessor?: ReturnType<typeof authorityGrant>,
): ReturnType<typeof authorityGrant> {
	if (predecessor !== undefined) {
		return {
			...predecessor,
			grant_id: IDS.grant2,
			lease_id: IDS.lease2,
			fencing_token: "2",
			lease_expires_at: "2026-08-02T00:30:00.000Z",
		};
	}
	return authorityGrant({
		grant_id: "10000000-0000-4000-8000-000000000011",
		node_id: IDS.node,
		mission_id: IDS.mission,
		delivery_id: IDS.delivery,
		execution_attempt: 1,
		lease_id: IDS.lease1,
		fencing_token: String(fence),
		lease_expires_at: "2026-08-02T00:20:00.000Z",
		hard_expires_at: "2026-08-02T00:05:00.000Z",
	});
}

function missionAcceptanceInput(): MissionParticipantAcceptanceInput {
	return {
		idempotency_key: `accept:${IDS.mission}`,
		contract: {
			artifact_id: IDS.artifact,
			type: "api_contract",
			version: 1,
			sha256: "a".repeat(64),
			media_type: "application/json",
			byte_size: 2,
		},
		local_policy_grant: {
			profile_name: "restricted",
			grant_sha256: "b".repeat(64),
		},
	};
}

function hostStartInput(): StartTurnInput {
	const fromManifest = (text: string) => ({
		text,
		authorPrincipalId: IDS.actor,
		provenance: "mission_manifest" as const,
	});
	return {
		session: {
			sessionId: "session-1",
			missionId: IDS.mission,
			participantId: IDS.actor,
			workspaceAlias: "backend",
		},
		missionId: IDS.mission,
		deliveryId: IDS.delivery,
		executionAttempt: 1,
		contractVersion: 1,
		missionSequence: 2,
		objective: fromManifest("Ship a compatible backend and client."),
		assignment: fromManifest("Implement the backend."),
		acceptanceCriteria: [fromManifest("Both repositories pass.")],
		peerMessages: [],
		artifacts: [],
	};
}
