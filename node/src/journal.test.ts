import type { MissionDeliveryItem, MissionParticipantAcceptanceInput } from "@agentrelay/protocol";
import { describe, expect, it } from "vitest";
import { type JournalStorage, NodeJournal, type NodeJournalState } from "./journal.js";

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
	it("migrates an older v1 journal with a null Mission assignment cursor", async () => {
		const storage = new MemoryStorage();
		storage.state = {
			schema_version: 1,
			cursor: null,
			deliveries: {},
			mission_sessions: {},
			mission_acceptances: {},
		};

		const journal = await NodeJournal.open(storage);

		expect(journal.snapshot().mission_assignment_cursor).toBeNull();
		expect(storage.saved).toHaveLength(1);
		expect(storage.saved[0]?.mission_assignment_cursor).toBeNull();
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
