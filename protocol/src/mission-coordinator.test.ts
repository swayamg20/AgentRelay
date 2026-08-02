import { describe, expect, it } from "vitest";
import {
	InvalidMissionCoordinatorEventError,
	createMissionCoordinatorState,
	missionCoordinatorEventSchema,
	reduceMissionCoordinatorEvent,
	replayMissionCoordinatorEvents,
} from "./mission-coordinator.js";

const IDS = {
	mission: "00000000-0000-4000-8000-000000000001",
	owner: "00000000-0000-4000-8000-000000000002",
	backend: "00000000-0000-4000-8000-000000000003",
	android: "00000000-0000-4000-8000-000000000004",
	outsider: "00000000-0000-4000-8000-000000000005",
	artifact: "00000000-0000-4000-8000-000000000006",
	revision: "00000000-0000-4000-8000-000000000007",
	message1: "00000000-0000-4000-8000-000000000008",
	message2: "00000000-0000-4000-8000-000000000009",
} as const;

const CONTRACT_V1 = {
	artifact_id: IDS.artifact,
	type: "api_contract",
	version: 1,
	sha256: "a".repeat(64),
	media_type: "application/json",
	byte_size: 128,
};

const CONTRACT_V2 = {
	...CONTRACT_V1,
	version: 2,
	sha256: "b".repeat(64),
	byte_size: 144,
};

const CONFIG = {
	mission_context: {
		manifest: {
			schema_version: 1,
			mission_id: IDS.mission,
			objective: "Ship compatible backend and Android changes.",
			public_acceptance_criteria: ["Both repositories pass the shared contract fixture."],
			participants: [
				{
					agent_id: IDS.backend,
					role: "backend",
					workspace_alias: "backend-api",
					repository_url: "https://github.com/acme/backend.git",
					expected_base_commit: "1".repeat(40),
					initial_assignment: "Implement the backend contract.",
					requested_local_policy_profile: "coding",
				},
				{
					agent_id: IDS.android,
					role: "android",
					workspace_alias: "android-app",
					repository_url: "https://github.com/acme/android.git",
					expected_base_commit: "2".repeat(40),
					initial_assignment: "Consume the backend contract.",
					requested_local_policy_profile: "coding",
				},
			],
			shared_contract: CONTRACT_V1,
			max_turns: 12,
			max_wall_time_seconds: 7_200,
			token_budget: 200_000,
			expires_at: "2026-08-03T10:00:00.000Z",
			allowed_artifact_types: ["api_contract", "patch", "verification_report"],
			created_at: "2026-08-02T10:00:00.000Z",
		},
		created_by: { principal_id: IDS.owner, kind: "owner" },
	},
	required_verification_commands: {
		[IDS.backend]: ["backend-contract"],
		[IDS.android]: ["android-contract"],
	},
};

describe("Mission coordinator", () => {
	it("starts only from exact participant and contract acceptance", () => {
		const initial = createMissionCoordinatorState(CONFIG);
		const event = acceptedEvent(1);
		const active = reduceMissionCoordinatorEvent(initial, event);

		expect(initial).toMatchObject({
			status: "awaiting_acceptance",
			sequence_no: 0,
			turn_count: 0,
			current_participant_agent_id: null,
		});
		expect(active).toMatchObject({
			status: "active",
			sequence_no: 1,
			turn_count: 0,
			contract_version: 1,
			current_participant_agent_id: IDS.backend,
		});
		event.contract.sha256 = "f".repeat(64);
		expect(active.applied_events[0]).toMatchObject({
			type: "participants_accepted",
			contract: { sha256: CONTRACT_V1.sha256 },
		});

		expect(() =>
			reduceMissionCoordinatorEvent(initial, {
				...acceptedEvent(1),
				participant_agent_ids: [IDS.backend, IDS.outsider],
			}),
		).toThrow(InvalidMissionCoordinatorEventError);
		expect(() =>
			reduceMissionCoordinatorEvent(initial, {
				...acceptedEvent(1),
				contract: { ...CONTRACT_V1, sha256: "c".repeat(64) },
			}),
		).toThrow(InvalidMissionCoordinatorEventError);
		expect(
			missionCoordinatorEventSchema.safeParse({ ...acceptedEvent(1), remote_path: "/tmp/repo" })
				.success,
		).toBe(false);
		expect(
			missionCoordinatorEventSchema.safeParse({
				...acceptedEvent(1),
				event_id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
			}).success,
		).toBe(false);
	});

	it("rejects Mission mismatches, sequence gaps, and invalid turn companions", () => {
		const initial = createMissionCoordinatorState(CONFIG);
		expect(() =>
			reduceMissionCoordinatorEvent(initial, {
				...acceptedEvent(1),
				mission_id: IDS.outsider,
			}),
		).toThrow(/mission_mismatch/);
		expect(() => reduceMissionCoordinatorEvent(initial, acceptedEvent(2))).toThrow(/sequence/);

		const reply = replyTurn(2, IDS.backend, 1, IDS.message1, null, "Reply.");
		const proposal = proposalTurn(2);
		const ready = readyTurn(2, IDS.backend, 1);
		expect(missionCoordinatorEventSchema.safeParse({ ...reply, message: null }).success).toBe(
			false,
		);
		expect(missionCoordinatorEventSchema.safeParse({ ...proposal, revision: null }).success).toBe(
			false,
		);
		expect(
			missionCoordinatorEventSchema.safeParse({ ...ready, message: reply.message }).success,
		).toBe(false);
		expect(
			missionCoordinatorEventSchema.safeParse({
				...ready,
				disposition: { kind: "blocked", reason: "waiting", requested_input: "owner" },
			}).success,
		).toBe(false);
		expect(
			missionCoordinatorEventSchema.safeParse({
				...ready,
				disposition: { kind: "failed", class: "permanent" },
			}).success,
		).toBe(false);
	});

	it("pauses a proposal for two explicit acknowledgements and completes a fresh replay", () => {
		const events: unknown[] = [acceptedEvent(1), proposalTurn(2)];
		let state = replayMissionCoordinatorEvents(CONFIG, events);

		expect(state).toMatchObject({
			status: "active",
			turn_count: 1,
			current_participant_agent_id: null,
			pending_revision: {
				version: 2,
				proposed_by_agent_id: IDS.backend,
				acknowledged_by_agent_ids: [],
			},
		});
		expect(() => reduceMissionCoordinatorEvent(state, readyTurn(3, IDS.android, 1))).toThrow(
			InvalidMissionCoordinatorEventError,
		);
		expect(() => reduceMissionCoordinatorEvent(state, acknowledgement(3, IDS.outsider))).toThrow(
			InvalidMissionCoordinatorEventError,
		);
		expect(() =>
			reduceMissionCoordinatorEvent(state, {
				...acknowledgement(3, IDS.backend),
				artifact: { ...CONTRACT_V2, sha256: "c".repeat(64) },
			}),
		).toThrow(InvalidMissionCoordinatorEventError);

		const backendAck = acknowledgement(3, IDS.backend);
		state = reduceMissionCoordinatorEvent(state, backendAck);
		events.push(backendAck);
		expect(state.pending_revision?.acknowledged_by_agent_ids).toEqual([IDS.backend]);
		expect(reduceMissionCoordinatorEvent(state, backendAck)).toBe(state);
		expect(() => reduceMissionCoordinatorEvent(state, acknowledgement(4, IDS.backend))).toThrow(
			InvalidMissionCoordinatorEventError,
		);

		const androidAck = acknowledgement(4, IDS.android);
		state = reduceMissionCoordinatorEvent(state, androidAck);
		events.push(androidAck);
		expect(state).toMatchObject({
			contract_version: 2,
			active_contract: CONTRACT_V2,
			pending_revision: null,
			current_participant_agent_id: IDS.android,
		});
		expect(state.accepted_revisions[0]?.acknowledged_by_agent_ids).toEqual([
			IDS.backend,
			IDS.android,
		]);
		expect(() => reduceMissionCoordinatorEvent(state, readyTurn(5, IDS.android, 1))).toThrow(
			InvalidMissionCoordinatorEventError,
		);

		const reply = replyTurn(5, IDS.android, 2, IDS.message1, null, "Use response field v2.");
		const backendReady = readyTurn(6, IDS.backend, 2);
		const androidReady = readyTurn(7, IDS.android, 2);
		const backendVerified = verificationEvent(8, IDS.backend, 2, "backend-contract");
		const androidVerified = verificationEvent(9, IDS.android, 2, "android-contract");
		for (const event of [reply, backendReady, androidReady, backendVerified, androidVerified]) {
			state = reduceMissionCoordinatorEvent(state, event);
			events.push(event);
		}

		expect(state).toMatchObject({
			status: "completed",
			sequence_no: 9,
			turn_count: 4,
			current_participant_agent_id: null,
			ready_agent_ids: [IDS.backend, IDS.android],
		});
		expect(state.verification_records).toHaveLength(2);
		expect(replayMissionCoordinatorEvents(CONFIG, events)).toEqual(state);
		expect(() =>
			reduceMissionCoordinatorEvent(
				state,
				replyTurn(10, IDS.backend, 2, IDS.message2, IDS.message1, "Delayed output."),
			),
		).toThrow(InvalidMissionCoordinatorEventError);
	});

	it("rejects pre-acknowledged revisions and changed contract identity", () => {
		const active = replayMissionCoordinatorEvents(CONFIG, [acceptedEvent(1)]);
		const preAcknowledged = proposalTurn(2);
		preAcknowledged.revision.acknowledged_by_agent_ids = [IDS.backend];
		expect(() => reduceMissionCoordinatorEvent(active, preAcknowledged)).toThrow(
			/revision_mismatch/,
		);

		const changedIdentity = proposalTurn(2);
		changedIdentity.disposition.artifact.artifact_id = IDS.outsider;
		changedIdentity.revision.artifact.artifact_id = IDS.outsider;
		expect(() => reduceMissionCoordinatorEvent(active, changedIdentity)).toThrow(
			/revision_contract_identity/,
		);
	});

	it("validates reply Messages, current-participant routing, and delivery identity", () => {
		const active = replayMissionCoordinatorEvents(CONFIG, [acceptedEvent(1)]);
		const firstReply = replyTurn(2, IDS.backend, 1, IDS.message1, null, "Backend is ready.");

		expect(() =>
			reduceMissionCoordinatorEvent(
				active,
				replyTurn(2, IDS.android, 1, IDS.message1, null, "Wrong participant."),
			),
		).toThrow(InvalidMissionCoordinatorEventError);
		expect(() =>
			reduceMissionCoordinatorEvent(active, {
				...firstReply,
				message: { ...firstReply.message, body: "Does not match the disposition." },
			}),
		).toThrow(InvalidMissionCoordinatorEventError);

		const replied = reduceMissionCoordinatorEvent(active, firstReply);
		expect(replied.current_participant_agent_id).toBe(IDS.android);
		expect(replied.turn_count).toBe(1);
		expect(reduceMissionCoordinatorEvent(replied, firstReply)).toBe(replied);

		const identityConflict = replyTurn(
			3,
			IDS.android,
			1,
			IDS.message2,
			IDS.message1,
			"Android is ready.",
		);
		identityConflict.event_id = firstReply.event_id;
		expect(() => reduceMissionCoordinatorEvent(replied, identityConflict)).toThrow(
			/event_identity_conflict/,
		);
		identityConflict.event_id = eventId(3);
		identityConflict.idempotency_key = firstReply.idempotency_key;
		expect(() => reduceMissionCoordinatorEvent(replied, identityConflict)).toThrow(
			/event_identity_conflict/,
		);

		const deliveryConflict = replyTurn(
			3,
			IDS.android,
			1,
			IDS.message2,
			IDS.message1,
			"Android is ready.",
		);
		deliveryConflict.delivery_id = firstReply.delivery_id;
		expect(() => reduceMissionCoordinatorEvent(replied, deliveryConflict)).toThrow(
			/delivery_conflict/,
		);
	});

	it("scopes readiness and locally registered verification to the active contract", () => {
		let state = replayMissionCoordinatorEvents(CONFIG, [
			acceptedEvent(1),
			readyTurn(2, IDS.backend, 1),
			readyTurn(3, IDS.android, 1),
		]);
		expect(state).toMatchObject({ status: "verifying", current_participant_agent_id: null });

		expect(() =>
			reduceMissionCoordinatorEvent(
				state,
				verificationEvent(4, IDS.backend, 2, "backend-contract"),
			),
		).toThrow(/contract_version/);
		expect(() =>
			reduceMissionCoordinatorEvent(state, verificationEvent(4, IDS.backend, 1, "unregistered")),
		).toThrow(/verification_command/);

		state = reduceMissionCoordinatorEvent(
			state,
			verificationEvent(4, IDS.backend, 1, "backend-contract", "failed"),
		);
		expect(state).toMatchObject({
			status: "active",
			current_participant_agent_id: IDS.backend,
			ready_agent_ids: [],
			verification_records: [],
		});

		state = reduceMissionCoordinatorEvent(state, readyTurn(5, IDS.backend, 1));
		state = reduceMissionCoordinatorEvent(state, readyTurn(6, IDS.android, 1));
		expect(state.verification_round).toBe(2);
		expect(() =>
			reduceMissionCoordinatorEvent(
				state,
				verificationEvent(7, IDS.backend, 1, "backend-contract", "passed", 1),
			),
		).toThrow(/verification_round/);

		const reusedVerificationId = verificationEvent(
			7,
			IDS.backend,
			1,
			"backend-contract",
			"passed",
			2,
		);
		reusedVerificationId.evidence.verification_id = verificationId(4);
		expect(() => reduceMissionCoordinatorEvent(state, reusedVerificationId)).toThrow(
			/verification_conflict/,
		);
	});

	it("clears stale readiness after peer work and rejects duplicate commands in one round", () => {
		let state = replayMissionCoordinatorEvents(CONFIG, [
			acceptedEvent(1),
			readyTurn(2, IDS.backend, 1),
		]);
		state = reduceMissionCoordinatorEvent(
			state,
			replyTurn(3, IDS.android, 1, IDS.message1, null, "Android changed the contract consumer."),
		);
		expect(state).toMatchObject({
			status: "active",
			current_participant_agent_id: IDS.backend,
			ready_agent_ids: [],
		});

		state = reduceMissionCoordinatorEvent(state, readyTurn(4, IDS.backend, 1));
		state = reduceMissionCoordinatorEvent(state, readyTurn(5, IDS.android, 1));
		state = reduceMissionCoordinatorEvent(
			state,
			verificationEvent(6, IDS.backend, 1, "backend-contract"),
		);
		expect(() =>
			reduceMissionCoordinatorEvent(
				state,
				verificationEvent(7, IDS.backend, 1, "backend-contract"),
			),
		).toThrow(/verification_conflict/);
	});

	it.each([2, 3])(
		"fails verification when a max-turn budget of %i cannot fund another readiness round",
		(maxTurns) => {
			const boundedConfig = structuredClone(CONFIG);
			boundedConfig.mission_context.manifest.max_turns = maxTurns;
			const verifying = replayMissionCoordinatorEvents(boundedConfig, [
				acceptedEvent(1),
				readyTurn(2, IDS.backend, 1),
				readyTurn(3, IDS.android, 1),
			]);

			const failed = reduceMissionCoordinatorEvent(
				verifying,
				verificationEvent(4, IDS.backend, 1, "backend-contract", "failed"),
			);

			expect(failed).toMatchObject({
				status: "failed",
				turn_count: 2,
				current_participant_agent_id: null,
				ready_agent_ids: [],
				verification_records: [],
			});
		},
	);

	it.each(["reply", "ready", "proposal"] as const)(
		"fails after a final %s turn instead of leaving an unschedulable Mission",
		(disposition) => {
			const oneTurnConfig = structuredClone(CONFIG);
			oneTurnConfig.mission_context.manifest.max_turns = 1;
			const active = replayMissionCoordinatorEvents(oneTurnConfig, [acceptedEvent(1)]);
			const finalTurn =
				disposition === "reply"
					? replyTurn(2, IDS.backend, 1, IDS.message1, null, "Final turn.")
					: disposition === "ready"
						? readyTurn(2, IDS.backend, 1)
						: proposalTurn(2);

			const failed = reduceMissionCoordinatorEvent(active, finalTurn);

			expect(failed).toMatchObject({
				status: "failed",
				turn_count: 1,
				pending_revision: null,
				current_participant_agent_id: null,
				ready_agent_ids: [],
			});
			expect(reduceMissionCoordinatorEvent(failed, finalTurn)).toBe(failed);
		},
	);

	it("does not count exact replay against the turn budget", () => {
		const twoTurnConfig = structuredClone(CONFIG);
		twoTurnConfig.mission_context.manifest.max_turns = 2;
		const active = replayMissionCoordinatorEvents(twoTurnConfig, [acceptedEvent(1)]);
		const firstReply = replyTurn(2, IDS.backend, 1, IDS.message1, null, "First turn.");
		const afterFirst = reduceMissionCoordinatorEvent(active, firstReply);

		expect(reduceMissionCoordinatorEvent(afterFirst, firstReply)).toBe(afterFirst);
		expect(afterFirst).toMatchObject({ status: "active", turn_count: 1 });
	});
});

function acceptedEvent(sequence: number) {
	return {
		...envelope(sequence),
		type: "participants_accepted" as const,
		participant_agent_ids: [IDS.backend, IDS.android],
		contract: structuredClone(CONTRACT_V1),
	};
}

function proposalTurn(sequence: number) {
	const revision = {
		revision_id: IDS.revision,
		mission_id: IDS.mission,
		previous_version: 1,
		version: 2,
		artifact: structuredClone(CONTRACT_V2),
		proposed_by_agent_id: IDS.backend,
		acknowledged_by_agent_ids: [],
		idempotency_key: "revision:2",
		created_at: timestamp(sequence),
	};
	return {
		...envelope(sequence),
		type: "turn_completed" as const,
		participant_agent_id: IDS.backend,
		delivery_id: deliveryId(sequence),
		contract_version: 1,
		disposition: { kind: "propose_contract" as const, artifact: structuredClone(CONTRACT_V2) },
		message: null,
		revision,
	};
}

function acknowledgement(sequence: number, participantAgentId: string) {
	return {
		...envelope(sequence),
		type: "contract_acknowledged" as const,
		participant_agent_id: participantAgentId,
		revision_id: IDS.revision,
		contract_version: 2,
		artifact: structuredClone(CONTRACT_V2),
	};
}

function replyTurn(
	sequence: number,
	participantAgentId: string,
	contractVersion: number,
	messageId: string,
	parentMessageId: string | null,
	body: string,
) {
	return {
		...envelope(sequence),
		type: "turn_completed" as const,
		participant_agent_id: participantAgentId,
		delivery_id: deliveryId(sequence),
		contract_version: contractVersion,
		disposition: { kind: "reply" as const, message_type: "progress" as const, message: body },
		message: {
			message_id: messageId,
			mission_id: IDS.mission,
			sequence_no: parentMessageId === null ? 1 : 2,
			author_agent_id: participantAgentId,
			type: "progress" as const,
			body,
			artifacts: [],
			contract_version: contractVersion,
			idempotency_key: `message:${sequence}`,
			causal_parent_message_id: parentMessageId,
			created_at: timestamp(sequence),
		},
		revision: null,
	};
}

function readyTurn(sequence: number, participantAgentId: string, contractVersion: number) {
	return {
		...envelope(sequence),
		type: "turn_completed" as const,
		participant_agent_id: participantAgentId,
		delivery_id: deliveryId(sequence),
		contract_version: contractVersion,
		disposition: { kind: "ready" as const, evidence: [] },
		message: null,
		revision: null,
	};
}

function verificationEvent(
	sequence: number,
	participantAgentId: string,
	contractVersion: number,
	commandId: string,
	outcome: "passed" | "failed" = "passed",
	verificationRound = 1,
) {
	return {
		...envelope(sequence),
		type: "verification_recorded" as const,
		participant_agent_id: participantAgentId,
		contract_version: contractVersion,
		verification_round: verificationRound,
		evidence: {
			verification_id: verificationId(sequence),
			command_id: commandId,
			outcome,
			exit_code: outcome === "passed" ? 0 : 1,
			duration_ms: 500,
			summary: `${commandId} ${outcome}`,
			output_sha256: "d".repeat(64),
			artifacts: [],
			recorded_at: timestamp(sequence),
		},
	};
}

function envelope(sequence: number) {
	return {
		event_id: eventId(sequence),
		idempotency_key: `mission-event:${sequence}`,
		mission_id: IDS.mission,
		sequence_no: sequence,
		created_at: timestamp(sequence),
	};
}

function eventId(sequence: number): string {
	return numberedUuid(100 + sequence);
}

function deliveryId(sequence: number): string {
	return numberedUuid(200 + sequence);
}

function verificationId(sequence: number): string {
	return numberedUuid(300 + sequence);
}

function numberedUuid(value: number): string {
	return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function timestamp(sequence: number): string {
	return `2026-08-02T10:${String(sequence).padStart(2, "0")}:00.000Z`;
}
