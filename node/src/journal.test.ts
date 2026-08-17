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
} as const;

describe("NodeJournal", () => {
	it("migrates an empty v1 journal to schema 3 with a null Mission assignment cursor", async () => {
		const storage = new MemoryStorage();
		storage.state = {
			schema_version: 1,
			cursor: null,
			deliveries: {},
			mission_sessions: {},
			mission_acceptances: {},
		};

		const journal = await NodeJournal.open(storage);

		expect(journal.snapshot().schema_version).toBe(3);
		expect(journal.snapshot().mission_assignment_cursor).toBeNull();
		expect(storage.saved).toHaveLength(1);
		expect(storage.saved[0]?.schema_version).toBe(3);
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

		expect(migrated.snapshot().schema_version).toBe(3);
		expect(migrated.snapshot().deliveries[IDS.delivery]?.runtime_authority).toBeNull();
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
