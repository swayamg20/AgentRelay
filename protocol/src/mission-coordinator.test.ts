import { describe, expect, it } from "vitest";
import {
	InvalidMissionCoordinatorEventError,
	createMissionCoordinatorState,
	missionCoordinatorAppendInputSchema,
	missionCoordinatorEventSchema,
	missionCoordinatorStateSchema,
	missionCreationResultSchema,
	missionParticipantAcceptanceInputSchema,
	missionParticipantAcceptanceResultSchema,
	nodeDeliveryResultPayloadSchema,
	nodeMissionAssignmentListRequestSchema,
	nodeMissionAssignmentListSchema,
	nodeMissionAssignmentResultSchema,
	nodeMissionAssignmentSchema,
	recoverableMissionDeliveryPageRequestSchema,
	recoverableMissionDeliveryPageSchema,
	reduceMissionCoordinatorEvent,
	replayMissionCoordinatorEvents,
	storedMissionDeliveryCursorPageSchema,
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
	backendNode: "00000000-0000-4000-8000-000000000010",
	androidNode: "00000000-0000-4000-8000-000000000011",
	backendBinding: "00000000-0000-4000-8000-000000000012",
	androidBinding: "00000000-0000-4000-8000-000000000013",
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
	it("accepts client append inputs without relay-owned event fields", () => {
		const inputs = [
			acceptedEvent(1),
			replyTurn(2, IDS.backend, 1, IDS.message1, null, "Reply."),
			acknowledgement(3, IDS.backend),
			verificationEvent(4, IDS.backend, 1, "backend-contract"),
		].map(toAppendInput);

		for (const input of inputs) {
			expect(missionCoordinatorAppendInputSchema.parse(input)).toEqual(input);
			expect(input).toHaveProperty("idempotency_key");
		}

		expect(
			missionCoordinatorAppendInputSchema.safeParse({
				...inputs[0],
				event_id: eventId(99),
			}).success,
		).toBe(false);
		expect(
			missionCoordinatorAppendInputSchema.safeParse({
				...inputs[1],
				message: null,
			}).success,
		).toBe(false);
		for (const input of inputs.slice(2)) {
			const withoutDelivery = { ...input };
			delete withoutDelivery.delivery_id;
			expect(missionCoordinatorAppendInputSchema.safeParse(withoutDelivery).success).toBe(false);
		}
	});

	it("accepts one participant receipt without accepting participant identity from the payload", () => {
		const acceptance = {
			idempotency_key: "mission-acceptance:backend",
			contract: CONTRACT_V1,
			local_policy_grant: {
				profile_name: "bounded-code",
				grant_sha256: "e".repeat(64),
			},
		};

		expect(missionParticipantAcceptanceInputSchema.parse(acceptance)).toEqual(acceptance);
		expect(
			missionParticipantAcceptanceInputSchema.safeParse({
				...acceptance,
				participant_agent_id: IDS.backend,
			}).success,
		).toBe(false);
		expect(
			missionParticipantAcceptanceInputSchema.safeParse({
				...acceptance,
				contract: { ...CONTRACT_V1, local_path: "/tmp/contract.json" },
			}).success,
		).toBe(false);
		expect(
			missionParticipantAcceptanceInputSchema.safeParse({
				...acceptance,
				local_policy_grant: { ...acceptance.local_policy_grant, grant_sha256: "not-a-hash" },
			}).success,
		).toBe(false);
	});

	it("publishes strict creation, acceptance, and pre-delivery assignment results", () => {
		const state = createMissionCoordinatorState(CONFIG);
		const creation = {
			mission_id: IDS.mission,
			state,
			participant_bindings: [
				{
					agent_id: IDS.backend,
					node_id: IDS.backendNode,
					workspace_binding_id: IDS.backendBinding,
				},
				{
					agent_id: IDS.android,
					node_id: IDS.androidNode,
					workspace_binding_id: IDS.androidBinding,
				},
			],
			replayed: false,
		};
		const receipt = {
			mission_id: IDS.mission,
			participant_agent_id: IDS.backend,
			idempotency_key: "accept:backend",
			contract: CONTRACT_V1,
			local_policy_grant: {
				profile_name: "coding",
				grant_sha256: "e".repeat(64),
			},
			accepted_at: "2026-08-02T10:01:00.000Z",
		};
		const assignment = {
			mission_id: IDS.mission,
			coordinator_config: CONFIG,
			coordinator_state: state,
			participant_agent_id: IDS.backend,
			workspace_binding_id: IDS.backendBinding,
			acceptance_status: "accepted" as const,
			acceptance_receipt: receipt,
		};

		expect(missionCoordinatorStateSchema.parse(state)).toEqual(state);
		expect(missionCreationResultSchema.parse(creation)).toEqual(creation);
		expect(missionParticipantAcceptanceResultSchema.parse({ receipt, replayed: true })).toEqual({
			receipt,
			replayed: true,
		});
		expect(nodeMissionAssignmentSchema.parse(assignment)).toEqual(assignment);
		expect(nodeMissionAssignmentResultSchema.parse({ mission: assignment })).toEqual({
			mission: assignment,
		});
		expect(nodeMissionAssignmentListRequestSchema.parse({ status: "awaiting_acceptance" })).toEqual(
			{ status: "awaiting_acceptance", after_cursor: null, limit: 50 },
		);
		expect(
			nodeMissionAssignmentListRequestSchema.parse({
				status: "awaiting_acceptance",
				after_cursor: IDS.mission,
				limit: 7,
			}),
		).toEqual({ status: "awaiting_acceptance", after_cursor: IDS.mission, limit: 7 });
		expect(
			nodeMissionAssignmentListSchema.parse({
				missions: [assignment],
				next_cursor: IDS.mission,
			}),
		).toEqual({
			missions: [assignment],
			next_cursor: IDS.mission,
		});
		expect(nodeMissionAssignmentListSchema.parse({ missions: [], next_cursor: null })).toEqual({
			missions: [],
			next_cursor: null,
		});
		expect(
			nodeMissionAssignmentListRequestSchema.safeParse({ after_cursor: "not-a-uuid" }).success,
		).toBe(false);
		expect(
			nodeMissionAssignmentListSchema.safeParse({
				missions: [assignment],
				next_cursor: IDS.outsider,
			}).success,
		).toBe(false);
		expect(
			nodeMissionAssignmentListSchema.safeParse({
				missions: [],
				next_cursor: IDS.mission,
			}).success,
		).toBe(false);

		expect(
			missionCreationResultSchema.safeParse({
				...creation,
				participantBindings: creation.participant_bindings,
			}).success,
		).toBe(false);
		expect(
			nodeMissionAssignmentSchema.safeParse({ ...assignment, local_path: "/tmp/backend" }).success,
		).toBe(false);
		expect(
			nodeMissionAssignmentResultSchema.safeParse({
				mission: assignment,
				local_path: "/tmp/backend",
			}).success,
		).toBe(false);
		expect(
			nodeMissionAssignmentSchema.safeParse({
				...assignment,
				acceptance_status: "pending",
			}).success,
		).toBe(false);
		expect(
			nodeMissionAssignmentSchema.safeParse({
				...assignment,
				participant_agent_id: IDS.android,
			}).success,
		).toBe(false);
	});

	it("accepts only content-bearing Node result payloads", () => {
		const turn = {
			type: "turn_completed" as const,
			disposition: {
				kind: "reply" as const,
				message_type: "progress" as const,
				message: "The endpoint is ready.",
			},
		};
		expect(nodeDeliveryResultPayloadSchema.parse(turn)).toEqual(turn);
		expect(nodeDeliveryResultPayloadSchema.parse({ type: "contract_acknowledged" })).toEqual({
			type: "contract_acknowledged",
		});
		const evidence = verificationEvent(3, IDS.backend, 1, "backend-contract").evidence;
		expect(
			nodeDeliveryResultPayloadSchema.parse({
				type: "verification_recorded",
				evidence: [evidence],
			}),
		).toEqual({ type: "verification_recorded", evidence: [evidence] });
		expect(
			nodeDeliveryResultPayloadSchema.safeParse({
				...turn,
				participant_agent_id: IDS.backend,
				delivery_id: numberedUuid(999),
				contract_version: 1,
				created_at: "2026-08-02T10:00:00.000Z",
				message: { message_id: IDS.message1 },
			}).success,
		).toBe(false);
		expect(
			nodeDeliveryResultPayloadSchema.safeParse({
				type: "contract_acknowledged",
				revision_id: IDS.revision,
			}).success,
		).toBe(false);
		expect(
			nodeDeliveryResultPayloadSchema.safeParse({
				type: "verification_recorded",
				evidence: [evidence, evidence],
			}).success,
		).toBe(false);
	});

	it("validates joined Mission events in one ordered Node cursor page", () => {
		const firstEvent = acceptedEvent(1);
		const secondEvent = replyTurn(2, IDS.backend, 1, IDS.message1, null, "Reply.");
		const first = storedMissionDeliveryItem(1, firstEvent);
		const second = storedMissionDeliveryItem(2, secondEvent);
		const page = { items: [first, second], next_cursor: "2" };

		expect(storedMissionDeliveryCursorPageSchema.parse(page)).toEqual(page);
		expect(storedMissionDeliveryCursorPageSchema.parse({ items: [], next_cursor: "42" })).toEqual({
			items: [],
			next_cursor: "42",
		});

		expect(
			storedMissionDeliveryCursorPageSchema.safeParse({
				items: [
					{
						...first,
						delivery: { ...first.delivery, mission_event_id: IDS.outsider },
					},
				],
				next_cursor: "1",
			}).success,
		).toBe(false);
		expect(
			storedMissionDeliveryCursorPageSchema.safeParse({
				items: [{ ...second, actor_agent_id: IDS.android }],
				next_cursor: "2",
			}).success,
		).toBe(false);
		expect(
			storedMissionDeliveryCursorPageSchema.safeParse({
				items: [{ ...second, source_delivery_id: IDS.outsider }],
				next_cursor: "2",
			}).success,
		).toBe(false);
		expect(
			storedMissionDeliveryCursorPageSchema.safeParse({
				items: [
					{
						...first,
						event: { ...first.event, mission_id: IDS.outsider },
					},
				],
				next_cursor: "1",
			}).success,
		).toBe(false);
		expect(
			storedMissionDeliveryCursorPageSchema.safeParse({
				items: [second, first],
				next_cursor: "1",
			}).success,
		).toBe(false);
		expect(
			storedMissionDeliveryCursorPageSchema.safeParse({
				items: [
					first,
					{
						...second,
						delivery: { ...second.delivery, node_id: IDS.androidNode },
					},
				],
				next_cursor: "2",
			}).success,
		).toBe(false);
		expect(
			storedMissionDeliveryCursorPageSchema.safeParse({
				items: [first],
				next_cursor: null,
			}).success,
		).toBe(false);
	});

	it("lists due retries and active or expired unsettled leases for restart recovery", () => {
		const firstEvent = acceptedEvent(1);
		const secondEvent = replyTurn(2, IDS.backend, 1, IDS.message1, null, "Reply.");
		const dueRetry = storedMissionDeliveryItem(1, firstEvent);
		dueRetry.delivery.attempt_count = 1;
		dueRetry.delivery.last_fencing_token = "1";
		const resumable = storedMissionDeliveryItem(2, secondEvent);
		resumable.delivery.status = "executing";
		resumable.delivery.attempt_count = 1;
		resumable.delivery.last_fencing_token = "1";
		resumable.delivery.lease = {
			lease_id: numberedUuid(800),
			fencing_token: "1",
			expires_at: "2026-08-02T11:00:00.000Z",
		};
		const page = {
			items: [dueRetry, resumable],
			as_of: "2026-08-02T10:30:00.000Z",
		};

		expect(recoverableMissionDeliveryPageRequestSchema.parse({})).toEqual({ limit: 50 });
		expect(recoverableMissionDeliveryPageSchema.parse(page)).toEqual(page);
		expect(
			recoverableMissionDeliveryPageSchema.safeParse({
				items: [storedMissionDeliveryItem(1, firstEvent)],
				as_of: page.as_of,
			}).success,
		).toBe(false);
		expect(
			recoverableMissionDeliveryPageSchema.safeParse({
				items: [
					{
						...dueRetry,
						delivery: {
							...dueRetry.delivery,
							available_at: "2026-08-02T11:00:00.000Z",
						},
					},
				],
				as_of: page.as_of,
			}).success,
		).toBe(false);
	});

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

	it("records a participant's full command set before reducing its verification outcome", () => {
		const config = structuredClone(CONFIG);
		config.required_verification_commands[IDS.backend] = [
			"backend-contract",
			"backend-integration",
		];
		let state = replayMissionCoordinatorEvents(config, [
			acceptedEvent(1),
			readyTurn(2, IDS.backend, 1),
			readyTurn(3, IDS.android, 1),
		]);

		state = reduceMissionCoordinatorEvent(
			state,
			verificationEvent(4, IDS.backend, 1, "backend-integration", "failed"),
		);
		expect(state).toMatchObject({ status: "verifying" });
		expect(state.verification_records).toHaveLength(1);

		state = reduceMissionCoordinatorEvent(
			state,
			verificationEvent(5, IDS.backend, 1, "backend-contract"),
		);
		expect(state).toMatchObject({
			status: "active",
			current_participant_agent_id: IDS.backend,
			verification_records: [],
		});
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

	it.each([
		["expired", "deadline_exceeded", null],
		["failed", "delivery_dead_lettered", deliveryId(2)],
	] as const)(
		"accepts a Relay terminal event that moves active work to %s",
		(terminalStatus, reason, triggeringDeliveryId) => {
			const active = replayMissionCoordinatorEvents(CONFIG, [acceptedEvent(1)]);
			const terminal = missionTerminalEvent(2, terminalStatus, reason, triggeringDeliveryId);
			const reduced = reduceMissionCoordinatorEvent(active, terminal);

			expect(reduced).toMatchObject({
				status: terminalStatus,
				sequence_no: 2,
				pending_revision: null,
				current_participant_agent_id: null,
				ready_agent_ids: [],
				verification_records: [],
			});
			expect(reduceMissionCoordinatorEvent(reduced, terminal)).toBe(reduced);
			expect(() =>
				reduceMissionCoordinatorEvent(
					reduced,
					replyTurn(3, IDS.backend, 1, IDS.message1, null, "Late output."),
				),
			).toThrow(/terminal/);
		},
	);

	it("expires a verifying Mission and clears in-flight coordinator progress", () => {
		const verifying = replayMissionCoordinatorEvents(CONFIG, [
			acceptedEvent(1),
			readyTurn(2, IDS.backend, 1),
			readyTurn(3, IDS.android, 1),
			verificationEvent(4, IDS.backend, 1, "backend-contract"),
		]);

		const expired = reduceMissionCoordinatorEvent(
			verifying,
			missionTerminalEvent(5, "expired", "deadline_exceeded", null),
		);

		expect(expired).toMatchObject({
			status: "expired",
			ready_agent_ids: [],
			verification_records: [],
		});
	});

	it("rejects participant-state terminalization and mismatched terminal causes", () => {
		const initial = createMissionCoordinatorState(CONFIG);
		expect(() =>
			reduceMissionCoordinatorEvent(
				initial,
				missionTerminalEvent(1, "expired", "deadline_exceeded", null),
			),
		).toThrow(/terminal_state/);
		expect(
			missionCoordinatorEventSchema.safeParse({
				...missionTerminalEvent(1, "failed", "delivery_dead_lettered", deliveryId(1)),
				triggering_delivery_id: null,
			}).success,
		).toBe(false);
		expect(
			missionCoordinatorAppendInputSchema.safeParse(
				toAppendInput(missionTerminalEvent(1, "expired", "deadline_exceeded", deliveryId(1))),
			).success,
		).toBe(false);
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

function missionTerminalEvent(
	sequence: number,
	terminalStatus: "expired" | "failed",
	reason: "deadline_exceeded" | "delivery_dead_lettered",
	triggeringDeliveryId: string | null,
) {
	return {
		...envelope(sequence),
		type: "mission_terminal" as const,
		terminal_status: terminalStatus,
		reason,
		triggering_delivery_id: triggeringDeliveryId,
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
		delivery_id: deliveryId(sequence),
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
		delivery_id: deliveryId(sequence),
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

function storedMissionDeliveryItem(
	cursor: number,
	event: ReturnType<typeof acceptedEvent> | ReturnType<typeof replyTurn>,
) {
	const createdAt = timestamp(cursor);
	return {
		delivery: {
			delivery_id: numberedUuid(400 + cursor),
			node_id: IDS.backendNode,
			mission_id: event.mission_id,
			mission_event_id: event.event_id,
			kind: "turn" as const,
			cursor: String(cursor),
			status: "stored" as const,
			attempt_count: 0,
			max_attempts: 3,
			last_fencing_token: "0",
			contract_version: 1,
			verification_round: null,
			lease: null,
			logical_settlement: null,
			idempotency_key: `delivery:${cursor}`,
			causal_parent_delivery_id: null,
			available_at: createdAt,
			created_at: createdAt,
			updated_at: createdAt,
			acknowledged_at: null,
			cancelled_at: null,
			cancellation_reason: null,
			dead_lettered_at: null,
		},
		event,
		actor_agent_id:
			event.type === "participants_accepted" ? IDS.backend : event.participant_agent_id,
		source_delivery_id: event.type === "participants_accepted" ? null : event.delivery_id,
		causal_parent_event_id: cursor === 1 ? null : eventId(cursor - 1),
	};
}

function toAppendInput(event: Record<string, unknown>): Record<string, unknown> {
	const input = { ...event };
	delete input.event_id;
	delete input.mission_id;
	delete input.sequence_no;
	delete input.created_at;
	return input;
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
