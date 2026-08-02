import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type Delivery,
	type DeliveryKind,
	InvalidMissionCoordinatorEventError,
	type MissionCoordinatorAppendInput,
	type MissionCoordinatorEvent,
	type MissionCoordinatorState,
	type MissionDeliveryItem,
	type MissionParticipantAcceptanceInput,
	type MissionStatus,
	type NodeMissionAssignment,
	type StoredMissionDeliveryCursorPage,
	createMissionCoordinatorState,
	deliverySchema,
	missionCoordinatorAppendInputSchema,
	missionCoordinatorConfigSchema,
	missionCoordinatorEventSchema,
	missionCoordinatorStateSchema,
	missionParticipantAcceptanceInputSchema,
	missionParticipantAcceptanceResultSchema,
	nodeMissionAssignmentSchema,
	reduceMissionCoordinatorEvent,
	replayMissionCoordinatorEvents,
	storedDeliveryCursorPageRequestSchema,
	storedMissionDeliveryCursorPageSchema,
} from "@agentrelay/protocol";
import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
	type Mission,
	type MissionParticipant,
	agents,
	missionEvents,
	missionParticipants,
	missions,
	nodeDeliveries,
	nodes,
	workspaceBindings,
} from "../db/schema.js";
import { RelayError } from "../errors.js";
import { writeAudit } from "./audit.js";
import { assertMissionTrustBoundary } from "./mission-trust.js";
import {
	type NodeCredentialContext,
	assertActiveNodeCredential,
	lockNodeMutation,
} from "./node-enrollment.js";

export interface MissionParticipantBinding {
	readonly agentId: string;
	readonly nodeId: string;
	readonly workspaceBindingId: string;
}

export interface CreateMissionLedgerResult {
	readonly missionId: string;
	readonly state: MissionCoordinatorState;
	readonly participantBindings: readonly MissionParticipantBinding[];
	readonly replayed: boolean;
}

export interface AppendMissionEventResult {
	readonly event: MissionCoordinatorEvent;
	readonly deliveryIds: readonly string[];
	readonly state: MissionCoordinatorState;
	readonly replayed: boolean;
}

export interface MissionParticipantAcceptanceReceipt {
	readonly mission_id: string;
	readonly participant_agent_id: string;
	readonly idempotency_key: string;
	readonly contract: MissionParticipantAcceptanceInput["contract"];
	readonly local_policy_grant: MissionParticipantAcceptanceInput["local_policy_grant"];
	readonly accepted_at: string;
}

export interface AcceptMissionParticipantResult {
	readonly receipt: MissionParticipantAcceptanceReceipt;
	readonly replayed: boolean;
}

export type StoredDeliveryLedgerPage = StoredMissionDeliveryCursorPage;

export type LedgerTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface SourceDeliveryAuthorization {
	readonly status: "stored" | "executing";
	readonly nodeId?: string;
	readonly leaseId?: string;
	readonly fencingToken?: string;
}

export async function listNodeMissionAssignments(
	db: Database,
	input: {
		readonly nodeId: string;
		readonly status?: MissionStatus;
		readonly limit: number;
	},
): Promise<NodeMissionAssignment[]> {
	const conditions = [eq(missionParticipants.nodeId, input.nodeId)];
	if (input.status !== undefined) conditions.push(eq(missions.status, input.status));
	const rows = await db
		.select({ mission: missions, participant: missionParticipants })
		.from(missionParticipants)
		.innerJoin(missions, eq(missions.id, missionParticipants.missionId))
		.where(and(...conditions))
		.orderBy(desc(missions.createdAt), desc(missions.id))
		.limit(input.limit);
	return rows.map(({ mission, participant }) => assignmentFromRows(mission, participant));
}

export async function getNodeMissionAssignment(
	db: Database,
	input: { readonly nodeId: string; readonly missionId: string },
): Promise<NodeMissionAssignment> {
	const [row] = await db
		.select({ mission: missions, participant: missionParticipants })
		.from(missionParticipants)
		.innerJoin(missions, eq(missions.id, missionParticipants.missionId))
		.where(
			and(
				eq(missionParticipants.nodeId, input.nodeId),
				eq(missionParticipants.missionId, input.missionId),
			),
		)
		.limit(1);
	if (!row) throw new RelayError("mission_not_found", "Mission not found");
	return assignmentFromRows(row.mission, row.participant);
}

export async function createMissionLedger(
	db: Database,
	input: {
		createdByAgentId: string;
		coordinatorConfig: unknown;
		requestId?: string;
	},
): Promise<CreateMissionLedgerResult> {
	const config = missionCoordinatorConfigSchema.parse(input.coordinatorConfig);
	const context = config.mission_context;
	const missionId = context.manifest.mission_id;
	if (
		context.created_by.kind !== "agent" ||
		context.created_by.principal_id !== input.createdByAgentId
	) {
		throw new RelayError(
			"not_authorized_transition",
			"Authenticated Mission creator does not match mission_context.created_by",
		);
	}
	if (
		!context.manifest.participants.some(
			(participant) => participant.agent_id === input.createdByAgentId,
		)
	) {
		throw new RelayError(
			"not_authorized_transition",
			"The first Mission slice must be created by one of its two participants",
		);
	}

	return db.transaction(async (tx) => {
		const [observedMission] = await tx.select().from(missions).where(eq(missions.id, missionId));
		const participantBindings = observedMission
			? await loadParticipantBindings(
					tx,
					missionId,
					missionCoordinatorConfigSchema
						.parse(observedMission.coordinatorConfig)
						.mission_context.manifest.participants.map((participant) => participant.agent_id),
				)
			: await resolveActiveParticipantBindings(tx, context.manifest.participants);
		await lockParticipantNodes(tx, participantBindings);
		await lockMissionMutation(tx, missionId);

		const [existing] = await tx.select().from(missions).where(eq(missions.id, missionId));
		if (existing) {
			const existingConfig = missionCoordinatorConfigSchema.parse(existing.coordinatorConfig);
			if (
				existing.createdByAgentId !== input.createdByAgentId ||
				!isDeepStrictEqual(existingConfig, config)
			) {
				throw new RelayError(
					"duplicate_idempotency_key",
					"Mission ID is already bound to different creation input",
				);
			}
			return {
				missionId,
				state: missionStateFromRow(existing),
				participantBindings: await loadParticipantBindings(
					tx,
					missionId,
					existingConfig.mission_context.manifest.participants.map(
						(participant) => participant.agent_id,
					),
				),
				replayed: true,
			};
		}

		const participantIds = context.manifest.participants.map((participant) => participant.agent_id);
		await assertMissionCreationAuthoritiesActive(tx, {
			creatorAgentId: input.createdByAgentId,
			participants: context.manifest.participants,
			participantBindings,
		});
		await assertMissionTrustBoundary(tx, [
			input.createdByAgentId,
			...context.manifest.participants.map((participant) => participant.agent_id),
		]);
		const expiresAt = new Date(context.manifest.expires_at);
		const creationTime = await readDatabaseClock(tx);
		if (expiresAt.getTime() <= creationTime.getTime()) {
			throw new RelayError("invalid_transition", "Mission has expired");
		}

		const state = createMissionCoordinatorState(config);
		await tx.insert(missions).values({
			id: missionId,
			createdByAgentId: input.createdByAgentId,
			coordinatorConfig: config,
			state,
			status: state.status,
			lastEventSequence: state.sequence_no,
			contractVersion: state.contract_version,
			expiresAt,
		});
		await tx.insert(missionParticipants).values(
			context.manifest.participants.map((participant) => {
				const binding = participantBindings.find(
					(candidate) => candidate.agentId === participant.agent_id,
				)!;
				return {
					missionId,
					agentId: participant.agent_id,
					nodeId: binding.nodeId,
					workspaceBindingId: binding.workspaceBindingId,
					role: participant.role,
				};
			}),
		);
		await writeAudit(tx, {
			actorId: input.createdByAgentId,
			action: "mission.create",
			resourceType: "mission",
			resourceId: missionId,
			requestId: input.requestId,
			metadata: { participant_agent_ids: participantIds },
		});

		return { missionId, state, participantBindings, replayed: false };
	});
}

export async function acceptMissionParticipant(
	db: Database,
	input: {
		missionId: string;
		participantAgentId: string;
		acceptance: unknown;
		requestId?: string;
		nodeAuth?: NodeCredentialContext;
	},
): Promise<AcceptMissionParticipantResult> {
	const acceptance = missionParticipantAcceptanceInputSchema.parse(input.acceptance);
	if (input.nodeAuth && input.nodeAuth.agentId !== input.participantAgentId) {
		throw new RelayError(
			"not_authorized_transition",
			"Authenticated Node owner does not match the Mission participant",
		);
	}

	return db.transaction(async (tx) => {
		if (input.nodeAuth) {
			await lockNodeMutation(tx, input.nodeAuth.nodeId);
			await assertActiveNodeCredential(tx, input.nodeAuth);
		}
		await lockMissionMutation(tx, input.missionId);
		const [mission] = await tx.select().from(missions).where(eq(missions.id, input.missionId));
		if (!mission) throw new RelayError("invalid_params", "Mission not found");

		const participantConditions = [
			eq(missionParticipants.missionId, input.missionId),
			eq(missionParticipants.agentId, input.participantAgentId),
		];
		if (input.nodeAuth) {
			participantConditions.push(eq(missionParticipants.nodeId, input.nodeAuth.nodeId));
		}
		const [participantRow] = await tx
			.select({ participant: missionParticipants })
			.from(missionParticipants)
			.innerJoin(nodes, eq(nodes.id, missionParticipants.nodeId))
			.innerJoin(
				workspaceBindings,
				and(
					eq(workspaceBindings.id, missionParticipants.workspaceBindingId),
					eq(workspaceBindings.nodeId, missionParticipants.nodeId),
				),
			)
			.where(
				and(
					...participantConditions,
					eq(nodes.status, "active"),
					eq(workspaceBindings.status, "active"),
				),
			);
		const participant = participantRow?.participant;
		if (!participant) {
			throw new RelayError(
				"not_authorized_transition",
				"Authenticated actor is not a Mission participant",
			);
		}

		if (participant.status === "accepted") {
			const storedAcceptance = acceptanceInputFromParticipant(participant);
			if (
				participant.acceptanceIdempotencyKey !== acceptance.idempotency_key ||
				!isDeepStrictEqual(storedAcceptance, acceptance)
			) {
				throw new RelayError(
					"duplicate_idempotency_key",
					"Mission participant already accepted with a different receipt",
				);
			}
			return missionParticipantAcceptanceResultSchema.parse({
				receipt: acceptanceReceiptFromParticipant(participant, storedAcceptance),
				replayed: true,
			});
		}

		const config = missionCoordinatorConfigSchema.parse(mission.coordinatorConfig);
		const manifest = config.mission_context.manifest;
		await assertMissionTrustBoundary(tx, [
			mission.createdByAgentId,
			...manifest.participants.map((candidate) => candidate.agent_id),
		]);
		const acceptedAt = await readDatabaseClock(tx);
		if (acceptedAt.getTime() >= mission.expiresAt.getTime()) {
			throw new RelayError("invalid_transition", "Mission has expired");
		}
		const manifestParticipant = manifest.participants.find(
			(candidate) => candidate.agent_id === input.participantAgentId,
		);
		if (!manifestParticipant) {
			throw new RelayError("internal", "Stored participant is absent from the Mission manifest");
		}
		if (!isDeepStrictEqual(acceptance.contract, manifest.shared_contract)) {
			throw new RelayError("invalid_params", "Acceptance must bind the exact Mission contract");
		}
		if (
			acceptance.local_policy_grant.profile_name !==
			manifestParticipant.requested_local_policy_profile
		) {
			throw new RelayError(
				"invalid_params",
				"Acceptance policy grant must match the participant's requested local profile",
			);
		}

		const [keyOwner] = await tx
			.select({ agentId: missionParticipants.agentId })
			.from(missionParticipants)
			.where(
				and(
					eq(missionParticipants.missionId, input.missionId),
					eq(missionParticipants.acceptanceIdempotencyKey, acceptance.idempotency_key),
				),
			);
		if (keyOwner) {
			throw new RelayError(
				"duplicate_idempotency_key",
				"Acceptance idempotency key is already bound to another participant",
			);
		}

		const [acceptedParticipant] = await tx
			.update(missionParticipants)
			.set({
				status: "accepted",
				acceptedAt,
				acceptanceIdempotencyKey: acceptance.idempotency_key,
				acceptanceReceipt: acceptance,
			})
			.where(
				and(
					eq(missionParticipants.missionId, input.missionId),
					eq(missionParticipants.agentId, input.participantAgentId),
					eq(missionParticipants.status, "pending"),
				),
			)
			.returning();
		if (!acceptedParticipant) {
			throw new RelayError("invalid_transition", "Mission participant is not pending acceptance");
		}

		await writeAudit(tx, {
			actorId: input.participantAgentId,
			action: "mission.participant.accept",
			resourceType: "mission",
			resourceId: input.missionId,
			requestId: input.requestId,
			metadata: {
				contract_version: acceptance.contract.version,
				contract_sha256: acceptance.contract.sha256,
				policy_profile: acceptance.local_policy_grant.profile_name,
				policy_grant_sha256: acceptance.local_policy_grant.grant_sha256,
			},
		});

		const participants = await tx
			.select()
			.from(missionParticipants)
			.where(eq(missionParticipants.missionId, input.missionId));
		if (participants.length === manifest.participants.length && participants.every(isAccepted)) {
			await assertAllParticipantBindingsActive(tx, input.missionId, manifest.participants.length);
			const aggregate = missionCoordinatorAppendInputSchema.parse({
				idempotency_key: `mission:${input.missionId}:participants-accepted`,
				type: "participants_accepted",
				participant_agent_ids: manifest.participants.map((candidate) => candidate.agent_id),
				contract: manifest.shared_contract,
			});
			await appendMissionEventInTransaction(tx, mission, {
				actorAgentId: input.participantAgentId,
				appendInput: aggregate,
				requestId: input.requestId,
				allowDerivedAcceptance: true,
				sourceAuthorization: null,
				recordedAt: acceptedAt,
			});
		}

		return missionParticipantAcceptanceResultSchema.parse({
			receipt: acceptanceReceiptFromParticipant(acceptedParticipant, acceptance),
			replayed: false,
		});
	});
}

export async function appendMissionEvent(
	db: Database,
	input: {
		missionId: string;
		actorAgentId: string;
		event: unknown;
		requestId?: string;
	},
): Promise<AppendMissionEventResult> {
	const appendInput = missionCoordinatorAppendInputSchema.parse(input.event);
	if (appendInput.type === "participants_accepted") {
		throw new RelayError(
			"not_authorized_transition",
			"Participant acceptance is derived only from two independent receipts",
		);
	}

	return db.transaction(async (tx) => {
		await lockMissionMutation(tx, input.missionId);
		const [mission] = await tx.select().from(missions).where(eq(missions.id, input.missionId));
		if (!mission) throw new RelayError("invalid_params", "Mission not found");
		return appendMissionEventInTransaction(tx, mission, {
			actorAgentId: input.actorAgentId,
			appendInput,
			requestId: input.requestId,
			allowDerivedAcceptance: false,
			sourceAuthorization: { status: "stored" },
		});
	});
}

export async function appendMissionEventInTransaction(
	tx: LedgerTransaction,
	mission: Mission,
	input: {
		actorAgentId: string;
		appendInput: MissionCoordinatorAppendInput;
		requestId?: string;
		allowDerivedAcceptance: boolean;
		sourceAuthorization: SourceDeliveryAuthorization | null;
		recordedAt?: Date;
	},
): Promise<AppendMissionEventResult> {
	const sourceDeliveryId =
		input.appendInput.type === "participants_accepted" ? null : input.appendInput.delivery_id;
	const [replayRow] = await tx
		.select()
		.from(missionEvents)
		.where(
			and(
				eq(missionEvents.missionId, mission.id),
				eq(missionEvents.idempotencyKey, input.appendInput.idempotency_key),
			),
		);
	if (replayRow) {
		const replayEvent = eventFromRow(replayRow);
		if (
			replayRow.actorAgentId !== input.actorAgentId ||
			replayRow.sourceDeliveryId !== sourceDeliveryId ||
			!isDeepStrictEqual(appendInputFromEvent(replayEvent), input.appendInput)
		) {
			throw new RelayError(
				"duplicate_idempotency_key",
				"Idempotency key is already bound to a different Mission event",
			);
		}
		const replayDeliveries = await tx
			.select({ id: nodeDeliveries.id })
			.from(nodeDeliveries)
			.where(eq(nodeDeliveries.missionEventId, replayRow.id))
			.orderBy(asc(nodeDeliveries.cursor));
		const replayConfig = missionCoordinatorConfigSchema.parse(mission.coordinatorConfig);
		const replayEventRows = await tx
			.select()
			.from(missionEvents)
			.where(eq(missionEvents.missionId, mission.id))
			.orderBy(asc(missionEvents.sequenceNo));
		return {
			event: replayEvent,
			deliveryIds: replayDeliveries.map((delivery) => delivery.id),
			state: replayMissionCoordinatorEvents(
				replayConfig,
				replayEventRows.filter((row) => row.sequenceNo <= replayRow.sequenceNo).map(eventFromRow),
			),
			replayed: true,
		};
	}

	const recordedAt = input.recordedAt ?? (await readDatabaseClock(tx));
	if (recordedAt.getTime() >= mission.expiresAt.getTime()) {
		throw new RelayError("invalid_transition", "Mission has expired");
	}
	const config = missionCoordinatorConfigSchema.parse(mission.coordinatorConfig);
	await assertMissionTrustBoundary(tx, [
		mission.createdByAgentId,
		...config.mission_context.manifest.participants.map((participant) => participant.agent_id),
	]);
	if (input.appendInput.type === "participants_accepted") {
		if (!input.allowDerivedAcceptance) {
			throw new RelayError(
				"not_authorized_transition",
				"Participant acceptance must be derived from stored receipts",
			);
		}
		await assertExactParticipantAcceptances(tx, mission, input.appendInput);
	} else {
		assertAuthorizedActor(input.actorAgentId, input.appendInput);
	}

	const storedRows = await tx
		.select()
		.from(missionEvents)
		.where(eq(missionEvents.missionId, mission.id))
		.orderBy(asc(missionEvents.sequenceNo));
	const currentState = replayMissionCoordinatorEvents(config, storedRows.map(eventFromRow));
	if (
		currentState.sequence_no !== mission.lastEventSequence ||
		!isDeepStrictEqual(currentState, missionStateFromRow(mission))
	) {
		throw new RelayError("internal", "Stored Mission projection does not match its event ledger");
	}

	if (input.appendInput.type !== "participants_accepted") {
		if (input.sourceAuthorization === null) {
			throw new RelayError("internal", "Mission result is missing source delivery authority");
		}
		await assertSourceDelivery(
			tx,
			mission.id,
			input.actorAgentId,
			input.appendInput,
			input.sourceAuthorization,
		);
	}

	const event = missionCoordinatorEventSchema.parse({
		...input.appendInput,
		event_id: randomUUID(),
		mission_id: mission.id,
		sequence_no: currentState.sequence_no + 1,
		created_at: recordedAt.toISOString(),
	});
	let nextState: MissionCoordinatorState;
	try {
		nextState = reduceMissionCoordinatorEvent(currentState, event);
	} catch (error) {
		if (error instanceof InvalidMissionCoordinatorEventError) {
			throw new RelayError("invalid_transition", error.message, { reason: error.reason });
		}
		throw error;
	}

	const previousEvent = storedRows.at(-1);
	await tx.insert(missionEvents).values({
		id: event.event_id,
		missionId: mission.id,
		sequenceNo: event.sequence_no,
		type: event.type,
		actorAgentId: input.actorAgentId,
		idempotencyKey: event.idempotency_key,
		sourceDeliveryId,
		causalParentEventId: previousEvent?.id ?? null,
		payload: eventPayload(event),
		createdAt: new Date(event.created_at),
	});

	if (sourceDeliveryId !== null && shouldSettleSourceDelivery(nextState, event)) {
		const settledAt = new Date(event.created_at);
		const settlementConditions =
			event.type === "verification_recorded" &&
			(nextState.status === "active" || nextState.status === "failed")
				? and(
						eq(nodeDeliveries.missionId, mission.id),
						eq(nodeDeliveries.kind, "verification"),
						eq(nodeDeliveries.contractVersion, event.contract_version),
						eq(nodeDeliveries.verificationRound, event.verification_round),
						isNull(nodeDeliveries.settledByEventId),
					)
				: and(
						eq(nodeDeliveries.id, sourceDeliveryId),
						eq(nodeDeliveries.missionId, mission.id),
						isNull(nodeDeliveries.settledByEventId),
					);
		const settled = await tx
			.update(nodeDeliveries)
			.set({ settledByEventId: event.event_id, settledAt, updatedAt: settledAt })
			.where(settlementConditions)
			.returning({ id: nodeDeliveries.id });
		if (!settled.some((delivery) => delivery.id === sourceDeliveryId)) {
			throw new RelayError("invalid_transition", "Source delivery is no longer available");
		}
	}

	const participantRows = await tx
		.select()
		.from(missionParticipants)
		.where(eq(missionParticipants.missionId, mission.id));
	const deliveryTargets = deriveDeliveryTargets(currentState, nextState, event);
	const createdDeliveryIds: string[] = [];
	for (const target of deliveryTargets) {
		const participant = participantRows.find((row) => row.agentId === target.agentId);
		if (!participant) {
			throw new RelayError("internal", "Derived delivery target is not a Mission participant");
		}
		const [causalParent] = await tx
			.select({ id: nodeDeliveries.id })
			.from(nodeDeliveries)
			.where(
				and(
					eq(nodeDeliveries.missionId, mission.id),
					eq(nodeDeliveries.nodeId, participant.nodeId),
				),
			)
			.orderBy(desc(nodeDeliveries.cursor))
			.limit(1);
		const [created] = await tx
			.insert(nodeDeliveries)
			.values({
				nodeId: participant.nodeId,
				missionId: mission.id,
				missionEventId: event.event_id,
				kind: target.kind,
				contractVersion: target.contractVersion,
				verificationRound: target.verificationRound,
				idempotencyKey: `event:${event.event_id}:${target.kind}:${participant.nodeId}`,
				causalParentDeliveryId: causalParent?.id ?? null,
			})
			.returning({ id: nodeDeliveries.id });
		if (!created) throw new RelayError("internal", "Failed to persist derived delivery");
		createdDeliveryIds.push(created.id);
	}

	await tx
		.update(missions)
		.set({
			state: nextState,
			status: nextState.status,
			lastEventSequence: nextState.sequence_no,
			contractVersion: nextState.contract_version,
			updatedAt: recordedAt,
		})
		.where(eq(missions.id, mission.id));
	await writeAudit(tx, {
		actorId: input.actorAgentId,
		action: "mission.event.append",
		resourceType: "mission_event",
		resourceId: event.event_id,
		requestId: input.requestId,
		metadata: {
			mission_id: mission.id,
			sequence_no: event.sequence_no,
			type: event.type,
			source_delivery_id: sourceDeliveryId,
			delivery_ids: createdDeliveryIds,
			derived: event.type === "participants_accepted",
		},
	});

	return {
		event,
		deliveryIds: createdDeliveryIds,
		state: nextState,
		replayed: false,
	};
}

export async function listStoredDeliveryEvents(
	db: Database,
	input: { nodeId: string; page: unknown },
): Promise<StoredDeliveryLedgerPage> {
	const page = storedDeliveryCursorPageRequestSchema.parse(input.page);
	const conditions = [
		eq(nodeDeliveries.nodeId, input.nodeId),
		eq(nodeDeliveries.status, "stored"),
		isNull(nodeDeliveries.settledByEventId),
		lte(nodeDeliveries.availableAt, sql`clock_timestamp()`),
		inArray(missions.status, ["active", "verifying"]),
		gt(missions.expiresAt, sql`clock_timestamp()`),
	];
	if (page.after_cursor !== null) {
		conditions.push(gt(nodeDeliveries.cursor, BigInt(page.after_cursor)));
	}
	const rows = await db
		.select({ delivery: nodeDeliveries, event: missionEvents })
		.from(nodeDeliveries)
		.innerJoin(missionEvents, eq(missionEvents.id, nodeDeliveries.missionEventId))
		.innerJoin(missions, eq(missions.id, nodeDeliveries.missionId))
		.where(and(...conditions))
		.orderBy(asc(nodeDeliveries.cursor))
		.limit(page.limit);
	const items = rows.map((row) => missionDeliveryItemFromRows(row.delivery, row.event));
	return storedMissionDeliveryCursorPageSchema.parse({
		items,
		next_cursor: items.at(-1)?.delivery.cursor ?? page.after_cursor,
	});
}

export async function lockMissionMutation(tx: LedgerTransaction, missionId: string): Promise<void> {
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${missionId}, 0))`);
}

function acceptanceInputFromParticipant(
	participant: MissionParticipant,
): MissionParticipantAcceptanceInput {
	if (participant.acceptanceReceipt === null) {
		throw new RelayError("internal", "Accepted participant is missing its durable receipt");
	}
	return missionParticipantAcceptanceInputSchema.parse(participant.acceptanceReceipt);
}

function acceptanceReceiptFromParticipant(
	participant: MissionParticipant,
	acceptance: MissionParticipantAcceptanceInput,
): MissionParticipantAcceptanceReceipt {
	if (participant.acceptedAt === null) {
		throw new RelayError("internal", "Accepted participant is missing its acceptance time");
	}
	return {
		mission_id: participant.missionId,
		participant_agent_id: participant.agentId,
		idempotency_key: acceptance.idempotency_key,
		contract: acceptance.contract,
		local_policy_grant: acceptance.local_policy_grant,
		accepted_at: participant.acceptedAt.toISOString(),
	};
}

async function readDatabaseClock(db: Pick<Database, "execute">): Promise<Date> {
	const [clock] = await db.execute(sql<{ now: string }>`SELECT clock_timestamp()::text AS now`);
	if (!clock || typeof clock.now !== "string") {
		throw new RelayError("internal", "Database clock is unavailable for Mission mutation");
	}
	const now = new Date(clock.now);
	if (!Number.isFinite(now.getTime())) {
		throw new RelayError("internal", "Database returned an invalid Mission timestamp");
	}
	return now;
}

function isAccepted(participant: MissionParticipant): boolean {
	return (
		participant.status === "accepted" &&
		participant.acceptedAt !== null &&
		participant.acceptanceIdempotencyKey !== null &&
		participant.acceptanceReceipt !== null
	);
}

async function assertExactParticipantAcceptances(
	tx: LedgerTransaction,
	mission: Mission,
	event: Extract<MissionCoordinatorAppendInput, { readonly type: "participants_accepted" }>,
): Promise<void> {
	const config = missionCoordinatorConfigSchema.parse(mission.coordinatorConfig);
	const manifest = config.mission_context.manifest;
	const participants = await tx
		.select()
		.from(missionParticipants)
		.where(eq(missionParticipants.missionId, mission.id));
	if (participants.length !== manifest.participants.length || !participants.every(isAccepted)) {
		throw new RelayError(
			"not_authorized_transition",
			"Both Mission participants must have durable acceptance receipts",
		);
	}
	if (!isDeepStrictEqual(event.contract, manifest.shared_contract)) {
		throw new RelayError("internal", "Derived acceptance contract does not match the manifest");
	}

	for (const manifestParticipant of manifest.participants) {
		const participant = participants.find(
			(candidate) => candidate.agentId === manifestParticipant.agent_id,
		);
		if (!participant) {
			throw new RelayError("internal", "Mission manifest and participant rows disagree");
		}
		const acceptance = acceptanceInputFromParticipant(participant);
		if (
			!isDeepStrictEqual(acceptance.contract, manifest.shared_contract) ||
			acceptance.local_policy_grant.profile_name !==
				manifestParticipant.requested_local_policy_profile
		) {
			throw new RelayError(
				"internal",
				"Stored participant acceptance no longer matches the immutable Mission",
			);
		}
	}
}

async function assertAllParticipantBindingsActive(
	tx: LedgerTransaction,
	missionId: string,
	expectedCount: number,
): Promise<void> {
	const activeBindings = await tx
		.select({ agentId: missionParticipants.agentId })
		.from(missionParticipants)
		.innerJoin(nodes, eq(nodes.id, missionParticipants.nodeId))
		.innerJoin(agents, eq(agents.id, missionParticipants.agentId))
		.innerJoin(
			workspaceBindings,
			and(
				eq(workspaceBindings.id, missionParticipants.workspaceBindingId),
				eq(workspaceBindings.nodeId, missionParticipants.nodeId),
			),
		)
		.where(
			and(
				eq(missionParticipants.missionId, missionId),
				eq(nodes.status, "active"),
				eq(agents.status, "active"),
				eq(workspaceBindings.status, "active"),
			),
		);
	if (activeBindings.length !== expectedCount) {
		throw new RelayError(
			"invalid_transition",
			"Every Mission participant must retain an active Node and workspace binding",
		);
	}
}

async function assertSourceDelivery(
	tx: LedgerTransaction,
	missionId: string,
	actorAgentId: string,
	event: Exclude<MissionCoordinatorAppendInput, { readonly type: "participants_accepted" }>,
	authorization: SourceDeliveryAuthorization,
): Promise<void> {
	if (
		authorization.status === "executing" &&
		(authorization.nodeId === undefined ||
			authorization.leaseId === undefined ||
			authorization.fencingToken === undefined)
	) {
		throw new RelayError("internal", "Executing source authorization is incomplete");
	}
	const [source] = await tx
		.select({
			delivery: nodeDeliveries,
			participantStatus: missionParticipants.status,
		})
		.from(nodeDeliveries)
		.innerJoin(
			missionParticipants,
			and(
				eq(missionParticipants.missionId, nodeDeliveries.missionId),
				eq(missionParticipants.nodeId, nodeDeliveries.nodeId),
			),
		)
		.where(
			and(
				eq(nodeDeliveries.id, event.delivery_id),
				eq(nodeDeliveries.missionId, missionId),
				eq(missionParticipants.agentId, actorAgentId),
			),
		);
	if (!source || source.participantStatus !== "accepted") {
		throw new RelayError(
			"not_authorized_transition",
			"Source delivery is not assigned to the authenticated Mission participant",
		);
	}

	const expectedKind: DeliveryKind =
		event.type === "turn_completed"
			? "turn"
			: event.type === "contract_acknowledged"
				? "contract_acknowledgement"
				: "verification";
	if (
		source.delivery.status !== authorization.status ||
		source.delivery.settledByEventId !== null ||
		source.delivery.kind !== expectedKind ||
		source.delivery.contractVersion !== event.contract_version ||
		(authorization.nodeId !== undefined && source.delivery.nodeId !== authorization.nodeId) ||
		(authorization.leaseId !== undefined &&
			source.delivery.activeLeaseId !== authorization.leaseId) ||
		(authorization.fencingToken !== undefined &&
			source.delivery.lastFencingToken !== authorization.fencingToken) ||
		(event.type === "verification_recorded" &&
			source.delivery.verificationRound !== event.verification_round)
	) {
		throw new RelayError(
			"invalid_transition",
			"Source delivery is unavailable or does not match the event kind and contract",
		);
	}
}

function shouldSettleSourceDelivery(
	next: MissionCoordinatorState,
	event: MissionCoordinatorEvent,
): boolean {
	if (event.type !== "verification_recorded") return event.type !== "participants_accepted";
	if (next.status !== "verifying") return true;
	if (event.evidence.outcome === "failed") return false;
	const required = next.required_verification_commands[event.participant_agent_id] ?? [];
	return required.every((commandId) =>
		next.verification_records.some(
			(record) =>
				record.participant_agent_id === event.participant_agent_id &&
				record.contract_version === event.contract_version &&
				record.verification_round === event.verification_round &&
				record.evidence.command_id === commandId &&
				record.evidence.outcome === "passed",
		),
	);
}

function assertAuthorizedActor(actorAgentId: string, event: MissionCoordinatorAppendInput): void {
	if (event.type === "participants_accepted") return;
	if (event.participant_agent_id !== actorAgentId) {
		throw new RelayError(
			"not_authorized_transition",
			"Mission event participant does not match the authenticated actor",
		);
	}
}

function deriveDeliveryTargets(
	previous: MissionCoordinatorState,
	next: MissionCoordinatorState,
	event: MissionCoordinatorEvent,
): Array<{
	agentId: string;
	kind: DeliveryKind;
	contractVersion: number;
	verificationRound: number | null;
}> {
	if (event.type === "turn_completed" && event.disposition.kind === "propose_contract") {
		const pendingVersion = next.pending_revision?.version;
		if (pendingVersion === undefined) {
			if (next.status === "failed") return [];
			throw new RelayError("internal", "Contract proposal did not produce a pending revision");
		}
		return next.mission_context.manifest.participants.map((participant) => ({
			agentId: participant.agent_id,
			kind: "contract_acknowledgement",
			contractVersion: pendingVersion,
			verificationRound: null,
		}));
	}
	if (previous.status !== "verifying" && next.status === "verifying") {
		return next.mission_context.manifest.participants.map((participant) => ({
			agentId: participant.agent_id,
			kind: "verification",
			contractVersion: next.contract_version,
			verificationRound: next.verification_round,
		}));
	}
	if (next.status === "active" && next.current_participant_agent_id !== null) {
		return [
			{
				agentId: next.current_participant_agent_id,
				kind: "turn",
				contractVersion: next.contract_version,
				verificationRound: null,
			},
		];
	}
	return [];
}

function eventPayload(event: MissionCoordinatorEvent): Record<string, unknown> {
	const payload = { ...event } as Record<string, unknown>;
	for (const field of [
		"event_id",
		"idempotency_key",
		"mission_id",
		"sequence_no",
		"created_at",
		"type",
	]) {
		delete payload[field];
	}
	return payload;
}

function appendInputFromEvent(event: MissionCoordinatorEvent): MissionCoordinatorAppendInput {
	const input = { ...event } as Record<string, unknown>;
	for (const field of ["event_id", "mission_id", "sequence_no", "created_at"]) {
		delete input[field];
	}
	return missionCoordinatorAppendInputSchema.parse(input);
}

export function eventFromRow(row: typeof missionEvents.$inferSelect): MissionCoordinatorEvent {
	if (row.payload === null || typeof row.payload !== "object" || Array.isArray(row.payload)) {
		throw new RelayError("internal", "Stored Mission event payload is not an object");
	}
	return missionCoordinatorEventSchema.parse({
		...(row.payload as Record<string, unknown>),
		event_id: row.id,
		idempotency_key: row.idempotencyKey,
		mission_id: row.missionId,
		sequence_no: row.sequenceNo,
		created_at: row.createdAt.toISOString(),
		type: row.type,
	});
}

export function deliveryFromRow(row: typeof nodeDeliveries.$inferSelect): Delivery {
	return deliverySchema.parse({
		delivery_id: row.id,
		node_id: row.nodeId,
		mission_id: row.missionId,
		mission_event_id: row.missionEventId,
		kind: row.kind,
		cursor: row.cursor.toString(),
		status: row.status,
		attempt_count: row.attemptCount,
		max_attempts: row.maxAttempts,
		last_fencing_token: row.lastFencingToken,
		contract_version: row.contractVersion,
		verification_round: row.verificationRound,
		lease:
			row.activeLeaseId === null || row.leaseExpiresAt === null
				? null
				: {
						lease_id: row.activeLeaseId,
						fencing_token: row.lastFencingToken,
						expires_at: row.leaseExpiresAt.toISOString(),
					},
		logical_settlement:
			row.settledByEventId === null || row.settledAt === null
				? null
				: {
						settled_by_event_id: row.settledByEventId,
						settled_at: row.settledAt.toISOString(),
					},
		idempotency_key: row.idempotencyKey,
		causal_parent_delivery_id: row.causalParentDeliveryId,
		available_at: row.availableAt.toISOString(),
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
		acknowledged_at: row.acknowledgedAt?.toISOString() ?? null,
		cancelled_at: row.cancelledAt?.toISOString() ?? null,
		cancellation_reason: row.cancellationReason,
		dead_lettered_at: row.deadLetteredAt?.toISOString() ?? null,
	});
}

export function missionDeliveryItemFromRows(
	delivery: typeof nodeDeliveries.$inferSelect,
	event: typeof missionEvents.$inferSelect,
): MissionDeliveryItem {
	return {
		delivery: deliveryFromRow(delivery),
		event: eventFromRow(event),
		actor_agent_id: event.actorAgentId,
		source_delivery_id: event.sourceDeliveryId,
		causal_parent_event_id: event.causalParentEventId,
	};
}

function missionStateFromRow(row: typeof missions.$inferSelect): MissionCoordinatorState {
	const config = missionCoordinatorConfigSchema.parse(row.coordinatorConfig);
	const parsed = missionCoordinatorStateSchema.safeParse(row.state);
	if (
		!parsed.success ||
		parsed.data.mission_context.manifest.mission_id !== config.mission_context.manifest.mission_id
	) {
		throw new RelayError("internal", "Stored Mission projection is invalid");
	}
	return structuredClone(parsed.data);
}

function assignmentFromRows(
	mission: Mission,
	participant: MissionParticipant,
): NodeMissionAssignment {
	const acceptance =
		participant.acceptanceReceipt === null
			? null
			: acceptanceReceiptFromParticipant(
					participant,
					missionParticipantAcceptanceInputSchema.parse(participant.acceptanceReceipt),
				);
	return nodeMissionAssignmentSchema.parse({
		mission_id: mission.id,
		coordinator_config: mission.coordinatorConfig,
		coordinator_state: missionStateFromRow(mission),
		participant_agent_id: participant.agentId,
		workspace_binding_id: participant.workspaceBindingId,
		acceptance_status: participant.status,
		acceptance_receipt: acceptance,
	});
}

interface MissionParticipantTarget {
	readonly agent_id: string;
	readonly workspace_alias: string;
	readonly repository_url: string;
}

async function resolveActiveParticipantBindings(
	tx: LedgerTransaction,
	participants: readonly MissionParticipantTarget[],
): Promise<MissionParticipantBinding[]> {
	const participantBindings: MissionParticipantBinding[] = [];
	for (const participant of participants) {
		const matches = await tx
			.select({
				workspaceBindingId: workspaceBindings.id,
				nodeId: nodes.id,
			})
			.from(workspaceBindings)
			.innerJoin(nodes, eq(nodes.id, workspaceBindings.nodeId))
			.where(
				and(
					eq(nodes.agentId, participant.agent_id),
					eq(nodes.status, "active"),
					eq(workspaceBindings.status, "active"),
					eq(workspaceBindings.alias, participant.workspace_alias),
					eq(workspaceBindings.repositoryUrl, participant.repository_url),
				),
			);
		if (matches.length !== 1) {
			throw new RelayError(
				"invalid_params",
				"Mission participant must resolve to exactly one active Node workspace",
				{
					participant_agent_id: participant.agent_id,
					workspace_alias: participant.workspace_alias,
					eligible_nodes: matches.length,
				},
			);
		}
		participantBindings.push({
			agentId: participant.agent_id,
			nodeId: matches[0]!.nodeId,
			workspaceBindingId: matches[0]!.workspaceBindingId,
		});
	}
	return participantBindings;
}

async function lockParticipantNodes(
	tx: LedgerTransaction,
	participantBindings: readonly MissionParticipantBinding[],
): Promise<void> {
	const nodeIds = [...new Set(participantBindings.map((binding) => binding.nodeId))].sort();
	for (const nodeId of nodeIds) await lockNodeMutation(tx, nodeId);
}

async function assertMissionCreationAuthoritiesActive(
	tx: LedgerTransaction,
	input: {
		readonly creatorAgentId: string;
		readonly participants: readonly MissionParticipantTarget[];
		readonly participantBindings: readonly MissionParticipantBinding[];
	},
): Promise<void> {
	const participantIds = input.participants.map((participant) => participant.agent_id);
	const requiredAgentIds = [...new Set([...participantIds, input.creatorAgentId])];
	const activeAgents = await tx
		.select({ id: agents.id })
		.from(agents)
		.where(and(inArray(agents.id, requiredAgentIds), eq(agents.status, "active")));
	if (activeAgents.length !== requiredAgentIds.length) {
		throw new RelayError(
			"invalid_params",
			"Mission creator and every participant must be active agents",
		);
	}

	const currentBindings = await resolveActiveParticipantBindings(tx, input.participants);
	if (!isDeepStrictEqual(currentBindings, input.participantBindings)) {
		throw new RelayError(
			"invalid_params",
			"Mission participant Node workspace binding changed during creation",
		);
	}
}

async function loadParticipantBindings(
	db: Pick<Database, "select">,
	missionId: string,
	participantAgentIds: readonly string[],
): Promise<MissionParticipantBinding[]> {
	const rows = await db
		.select({
			agentId: missionParticipants.agentId,
			nodeId: missionParticipants.nodeId,
			workspaceBindingId: missionParticipants.workspaceBindingId,
		})
		.from(missionParticipants)
		.where(eq(missionParticipants.missionId, missionId));
	return participantAgentIds.map((agentId) => {
		const row = rows.find((candidate) => candidate.agentId === agentId);
		if (!row) throw new RelayError("internal", "Stored Mission participant binding is missing");
		return row;
	});
}
