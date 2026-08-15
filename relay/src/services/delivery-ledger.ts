import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type DeliveryClaimInput,
	type DeliveryClaimResult,
	type DeliveryCompleteInput,
	type DeliveryCompleteResult,
	type DeliveryOperationReceipt,
	type DeliveryReleaseInput,
	type DeliveryReleaseResult,
	type DeliveryRenewInput,
	type DeliveryRenewResult,
	type DeliveryStartInput,
	type DeliveryStartResult,
	type MissionCoordinatorAppendInput,
	type MissionCoordinatorEvent,
	deliveryClaimInputSchema,
	deliveryClaimResultSchema,
	deliveryCompleteInputSchema,
	deliveryCompleteResultSchema,
	deliveryOperationReceiptSchema,
	deliveryReleaseInputSchema,
	deliveryReleaseResultSchema,
	deliveryRenewInputSchema,
	deliveryRenewResultSchema,
	deliveryStartInputSchema,
	deliveryStartResultSchema,
	missionCoordinatorAppendInputSchema,
	missionCoordinatorConfigSchema,
	missionCoordinatorStateSchema,
	recoverableMissionDeliveryPageRequestSchema,
	recoverableMissionDeliveryPageSchema,
} from "@agentrelay/protocol";
import { and, asc, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
	type DeliveryOperationReceipt as DeliveryOperationReceiptRow,
	type Mission,
	type NodeDelivery,
	agents,
	deliveryOperationReceipts,
	missionEvents,
	missionParticipants,
	missions,
	nodeDeliveries,
	nodes,
	workspaceBindings,
} from "../db/schema.js";
import { RelayError } from "../errors.js";
import { writeAudit } from "./audit.js";
import {
	appendMissionEventInTransaction,
	deliveryFromRow,
	listStoredDeliveryEvents,
	missionDeliveryItemFromRows,
} from "./mission-ledger.js";
import { reconcileMissionInTransaction, reconcileNodeMissions } from "./mission-reconciliation.js";
import { assertMissionTrustBoundary } from "./mission-trust.js";
import {
	type NodeCredentialContext,
	assertActiveNodeCredential,
	lockNodeMutation,
} from "./node-enrollment.js";

const LEASE_DURATION_MS = 60_000;
const MAX_RETRY_BACKOFF_MS = 60_000;

type DeliveryTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type PublicNodeOperation = "claim" | "start" | "renew" | "complete" | "release";

interface LockedDeliveryContext {
	readonly delivery: NodeDelivery;
	readonly mission: Mission;
	readonly participantStatus: string;
	readonly workspaceStatus: string;
}

interface LockedDeliveryResult {
	readonly context: LockedDeliveryContext;
	readonly now: Date;
	readonly reconciledStatus: string | null;
}

const postCommitRejection = Symbol("postCommitRejection");

interface PostCommitRejection {
	readonly [postCommitRejection]: true;
	readonly error: unknown;
}

export async function listAvailableDeliveryEvents(
	db: Database,
	input: { readonly nodeId: string; readonly page: unknown },
) {
	await reconcileNodeMissions(db, input.nodeId);
	return listStoredDeliveryEvents(db, input);
}

export async function listRecoverableDeliveryEvents(
	db: Database,
	input: { readonly nodeId: string; readonly page: unknown },
) {
	const page = recoverableMissionDeliveryPageRequestSchema.parse(input.page);
	await reconcileNodeMissions(db, input.nodeId);
	const asOf = await readDatabaseClock(db);
	const rows = await db
		.select({ delivery: nodeDeliveries, event: missionEvents })
		.from(nodeDeliveries)
		.innerJoin(missionEvents, eq(missionEvents.id, nodeDeliveries.missionEventId))
		.innerJoin(missions, eq(missions.id, nodeDeliveries.missionId))
		.where(
			and(
				eq(nodeDeliveries.nodeId, input.nodeId),
				isNull(nodeDeliveries.settledByEventId),
				inArray(missions.status, ["active", "verifying"]),
				gt(missions.expiresAt, asOf),
				or(
					and(
						eq(nodeDeliveries.status, "stored"),
						gt(nodeDeliveries.attemptCount, 0),
						lte(nodeDeliveries.availableAt, asOf),
					),
					inArray(nodeDeliveries.status, ["leased", "executing"]),
				),
			),
		)
		.orderBy(asc(nodeDeliveries.cursor))
		.limit(page.limit);
	return recoverableMissionDeliveryPageSchema.parse({
		items: rows.map((row) => missionDeliveryItemFromRows(row.delivery, row.event)),
		as_of: asOf.toISOString(),
	});
}

export async function claimDelivery(
	db: Database,
	auth: NodeCredentialContext,
	deliveryId: string,
	input: unknown,
): Promise<DeliveryClaimResult> {
	const parsed = deliveryClaimInputSchema.parse(input);
	const storedInput = operationInput(deliveryId, parsed);

	return runLockedDeliveryOperation(db, auth, deliveryId, async (tx, locked) => {
		let { context } = locked;
		await assertMissionRoutingAuthority(tx, context.mission);
		const replay = await replayClaim(tx, auth.nodeId, deliveryId, parsed, storedInput);
		if (replay !== null) {
			await assertDeliveryMissionTrust(tx, context.mission);
			assertReplayableDelivery(context.delivery);
			return replay;
		}
		if (locked.reconciledStatus !== null) {
			throw terminalMutationError(locked.reconciledStatus);
		}
		await assertDeliveryMissionTrust(tx, context.mission);
		const { now } = locked;
		assertRunnableContext(context, now);

		if (context.delivery.status === "leased" || context.delivery.status === "executing") {
			if (context.delivery.leaseExpiresAt === null) {
				throw new RelayError("internal", "Active delivery is missing its lease deadline");
			}
			if (context.delivery.leaseExpiresAt.getTime() > now.getTime()) {
				throw new RelayError("state_changed", "Delivery already has an active lease");
			}
			if (context.delivery.attemptCount >= context.delivery.maxAttempts) {
				return deadLetterExpiredFinalClaim(tx, auth, context, parsed, storedInput, now);
			}
			await expireLeaseForRetry(tx, auth, context.delivery, now);
			context = { ...context, delivery: await lockDelivery(tx, auth.nodeId, deliveryId) };
		}

		if (
			context.delivery.status !== "stored" ||
			context.delivery.settledByEventId !== null ||
			context.delivery.attemptCount >= context.delivery.maxAttempts
		) {
			throw new RelayError("invalid_transition", "Delivery is not available for a new claim");
		}
		if (context.delivery.availableAt.getTime() > now.getTime()) {
			throw new RelayError("state_changed", "Delivery retry is not available yet", {
				available_at: context.delivery.availableAt.toISOString(),
			});
		}

		const attemptCount = context.delivery.attemptCount + 1;
		const leaseId = randomUUID();
		const fencingToken = String(attemptCount);
		const leaseExpiresAt = boundedLeaseExpiry(now, context.mission.expiresAt);
		const [claimed] = await tx
			.update(nodeDeliveries)
			.set({
				status: "leased",
				attemptCount,
				lastFencingToken: fencingToken,
				activeLeaseId: leaseId,
				leaseExpiresAt,
				updatedAt: now,
			})
			.where(eq(nodeDeliveries.id, deliveryId))
			.returning();
		if (!claimed) throw new RelayError("internal", "Failed to persist delivery claim");
		const event = await loadMissionEvent(tx, claimed.missionEventId);
		const receipt = operationReceipt({
			operation: "claim",
			idempotencyKey: parsed.idempotency_key,
			nodeId: auth.nodeId,
			delivery: claimed,
			statusBefore: "stored",
			leaseId,
			fencingToken,
			leaseExpiresAt,
			claimOutcome: "claimed",
			recordedAt: now,
		});
		const result = deliveryClaimResultSchema.parse({
			outcome: "claimed",
			item: missionDeliveryItemFromRows(claimed, event),
			receipt,
			replayed: false,
		});
		await persistNodeReceipt(tx, auth, claimed, receipt, storedInput, result);
		await auditNodeOperation(tx, auth, claimed, receipt);
		return result;
	});
}

export async function startDelivery(
	db: Database,
	auth: NodeCredentialContext,
	deliveryId: string,
	input: unknown,
): Promise<DeliveryStartResult> {
	const parsed = deliveryStartInputSchema.parse(input);
	return mutateLeaseDelivery(
		db,
		auth,
		deliveryId,
		parsed,
		"start",
		(value) => deliveryStartResultSchema.parse(value),
		async (tx, context, now) => {
			if (context.delivery.status !== "leased") {
				throw new RelayError("invalid_transition", "Only a leased delivery can start execution");
			}
			assertLeaseAuthority(context.delivery, parsed, now);
			const [started] = await tx
				.update(nodeDeliveries)
				.set({ status: "executing", updatedAt: now })
				.where(eq(nodeDeliveries.id, deliveryId))
				.returning();
			if (!started) throw new RelayError("internal", "Failed to start delivery execution");
			const receipt = operationReceipt({
				operation: "start",
				idempotencyKey: parsed.idempotency_key,
				nodeId: auth.nodeId,
				delivery: started,
				statusBefore: "leased",
				leaseId: parsed.lease_id,
				fencingToken: parsed.fencing_token,
				leaseExpiresAt: started.leaseExpiresAt,
				recordedAt: now,
			});
			return deliveryStartResultSchema.parse({
				delivery: deliveryFromRow(started),
				receipt,
				replayed: false,
			});
		},
	);
}

export async function renewDelivery(
	db: Database,
	auth: NodeCredentialContext,
	deliveryId: string,
	input: unknown,
): Promise<DeliveryRenewResult> {
	const parsed = deliveryRenewInputSchema.parse(input);
	return mutateLeaseDelivery(
		db,
		auth,
		deliveryId,
		parsed,
		"renew",
		(value) => deliveryRenewResultSchema.parse(value),
		async (tx, context, now) => {
			assertActiveLeaseStatus(context.delivery);
			assertLeaseAuthority(context.delivery, parsed, now);
			const leaseExpiresAt = boundedLeaseExpiry(now, context.mission.expiresAt);
			if (
				context.delivery.leaseExpiresAt === null ||
				leaseExpiresAt.getTime() < context.delivery.leaseExpiresAt.getTime()
			) {
				throw new RelayError("invalid_transition", "Delivery lease deadline cannot move backwards");
			}
			const [renewed] = await tx
				.update(nodeDeliveries)
				.set({ leaseExpiresAt, updatedAt: now })
				.where(eq(nodeDeliveries.id, deliveryId))
				.returning();
			if (!renewed) throw new RelayError("internal", "Failed to renew delivery lease");
			const receipt = operationReceipt({
				operation: "renew",
				idempotencyKey: parsed.idempotency_key,
				nodeId: auth.nodeId,
				delivery: renewed,
				statusBefore: context.delivery.status,
				leaseId: parsed.lease_id,
				fencingToken: parsed.fencing_token,
				leaseExpiresAt,
				recordedAt: now,
			});
			return deliveryRenewResultSchema.parse({
				delivery: deliveryFromRow(renewed),
				receipt,
				replayed: false,
			});
		},
	);
}

export async function completeDelivery(
	db: Database,
	auth: NodeCredentialContext,
	deliveryId: string,
	input: unknown,
): Promise<DeliveryCompleteResult> {
	const parsed = deliveryCompleteInputSchema.parse(input);
	const storedInput = operationInput(deliveryId, parsed);

	return runLockedDeliveryOperation(db, auth, deliveryId, async (tx, locked) => {
		const { context, now } = locked;
		await assertMissionRoutingAuthority(tx, context.mission);
		const replay = await replayComplete(tx, auth.nodeId, deliveryId, parsed, storedInput);
		if (replay !== null) {
			assertReplayableDelivery(context.delivery);
			return replay;
		}
		if (locked.reconciledStatus !== null) {
			throw terminalMutationError(locked.reconciledStatus);
		}
		await assertDeliveryMissionTrust(tx, context.mission);
		assertRunnableContext(context, now);
		if (context.delivery.status !== "executing" || context.delivery.settledByEventId !== null) {
			throw new RelayError(
				"invalid_transition",
				"Only unsettled executing work can publish a completion",
			);
		}
		assertLeaseAuthority(context.delivery, parsed, now);

		const appendInputs = buildCompletionEvents(context, auth, parsed, now);
		const events: MissionCoordinatorEvent[] = [];
		const derivedDeliveryIds: string[] = [];
		let mission = context.mission;
		for (const appendInput of appendInputs) {
			const appended = await appendMissionEventInTransaction(tx, mission, {
				actorAgentId: auth.agentId,
				appendInput,
				requestId: auth.requestId,
				allowDerivedAcceptance: false,
				sourceAuthorization: {
					status: "executing",
					nodeId: auth.nodeId,
					leaseId: parsed.lease_id,
					fencingToken: parsed.fencing_token,
				},
				recordedAt: now,
			});
			events.push(appended.event);
			derivedDeliveryIds.push(...appended.deliveryIds);
			const [updatedMission] = await tx
				.select()
				.from(missions)
				.where(eq(missions.id, mission.id))
				.limit(1);
			if (!updatedMission) throw new RelayError("internal", "Mission vanished during completion");
			mission = updatedMission;
		}

		const finalEvent = events.at(-1);
		if (!finalEvent) throw new RelayError("internal", "Completion produced no Mission result");
		const [acknowledged] = await tx
			.update(nodeDeliveries)
			.set({
				status: "acknowledged",
				activeLeaseId: null,
				leaseExpiresAt: null,
				acknowledgedAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(nodeDeliveries.id, deliveryId),
					eq(nodeDeliveries.nodeId, auth.nodeId),
					eq(nodeDeliveries.status, "executing"),
					eq(nodeDeliveries.activeLeaseId, parsed.lease_id),
					eq(nodeDeliveries.lastFencingToken, parsed.fencing_token),
					eq(nodeDeliveries.settledByEventId, finalEvent.event_id),
					gt(nodeDeliveries.leaseExpiresAt, now),
				),
			)
			.returning();
		if (!acknowledged) {
			throw new RelayError("invalid_transition", "Completion did not settle its source delivery");
		}

		await cancelSupersededSiblings(tx, auth, acknowledged, finalEvent.event_id, now);
		const receipt = operationReceipt({
			operation: "complete",
			idempotencyKey: parsed.idempotency_key,
			nodeId: auth.nodeId,
			delivery: acknowledged,
			statusBefore: "executing",
			leaseId: parsed.lease_id,
			fencingToken: parsed.fencing_token,
			leaseExpiresAt: context.delivery.leaseExpiresAt,
			recordedAt: now,
		});
		const result = deliveryCompleteResultSchema.parse({
			delivery: deliveryFromRow(acknowledged),
			receipt,
			events,
			derived_delivery_ids: [...new Set(derivedDeliveryIds)],
			replayed: false,
		});
		await persistNodeReceipt(tx, auth, acknowledged, receipt, storedInput, result);
		await auditNodeOperation(tx, auth, acknowledged, receipt);
		return result;
	});
}

export async function releaseDelivery(
	db: Database,
	auth: NodeCredentialContext,
	deliveryId: string,
	input: unknown,
): Promise<DeliveryReleaseResult> {
	const parsed = deliveryReleaseInputSchema.parse(input);
	return mutateLeaseDelivery(
		db,
		auth,
		deliveryId,
		parsed,
		"release",
		(value) => deliveryReleaseResultSchema.parse(value),
		async (tx, context, now) => {
			assertActiveLeaseStatus(context.delivery);
			assertLeaseAuthority(context.delivery, parsed, now);
			const retryAt = new Date(now.getTime() + retryBackoffMs(context.delivery.attemptCount));
			const deadLetter =
				parsed.classification !== "transient" ||
				context.delivery.attemptCount >= context.delivery.maxAttempts ||
				retryAt.getTime() >= context.mission.expiresAt.getTime();
			const [released] = await tx
				.update(nodeDeliveries)
				.set({
					status: deadLetter ? "dead_lettered" : "stored",
					activeLeaseId: null,
					leaseExpiresAt: null,
					availableAt: deadLetter ? context.delivery.availableAt : retryAt,
					deadLetteredAt: deadLetter ? now : null,
					updatedAt: now,
				})
				.where(eq(nodeDeliveries.id, deliveryId))
				.returning();
			if (!released) throw new RelayError("internal", "Failed to release delivery");
			const receipt = operationReceipt({
				operation: "release",
				idempotencyKey: parsed.idempotency_key,
				nodeId: auth.nodeId,
				delivery: released,
				statusBefore: context.delivery.status,
				leaseId: parsed.lease_id,
				fencingToken: parsed.fencing_token,
				leaseExpiresAt: context.delivery.leaseExpiresAt,
				release: { classification: parsed.classification, summary: parsed.summary },
				recordedAt: now,
			});
			return deliveryReleaseResultSchema.parse({
				delivery: deliveryFromRow(released),
				receipt,
				replayed: false,
			});
		},
	);
}

async function mutateLeaseDelivery<
	TInput extends DeliveryStartInput | DeliveryRenewInput | DeliveryReleaseInput,
	TResult extends { replayed: boolean; receipt: DeliveryOperationReceipt },
>(
	db: Database,
	auth: NodeCredentialContext,
	deliveryId: string,
	input: TInput,
	operation: Exclude<PublicNodeOperation, "claim" | "complete">,
	parseResult: (input: unknown) => TResult,
	mutate: (tx: DeliveryTransaction, context: LockedDeliveryContext, now: Date) => Promise<TResult>,
): Promise<TResult> {
	const storedInput = operationInput(deliveryId, input);
	return runLockedDeliveryOperation(db, auth, deliveryId, async (tx, locked) => {
		const { context, now } = locked;
		await assertMissionRoutingAuthority(tx, context.mission);
		const replay = await replayOperation(
			tx,
			auth.nodeId,
			deliveryId,
			operation,
			input.idempotency_key,
			storedInput,
			parseResult,
		);
		if (replay !== null) {
			if (operation !== "release") {
				await assertDeliveryMissionTrust(tx, context.mission);
			}
			assertReplayableDelivery(context.delivery);
			return replay;
		}
		if (locked.reconciledStatus !== null) {
			throw terminalMutationError(locked.reconciledStatus);
		}
		await assertDeliveryMissionTrust(tx, context.mission);
		assertRunnableContext(context, now);
		const result = await mutate(tx, context, now);
		const receipt = deliveryOperationReceiptSchema.parse(result.receipt);
		await persistNodeReceipt(tx, auth, context.delivery, receipt, storedInput, result);
		await auditNodeOperation(tx, auth, context.delivery, receipt);
		if (receipt.status_after === "dead_lettered") {
			await reconcileMissionInTransaction(tx, context.delivery.missionId);
		}
		return result;
	});
}

async function replayClaim(
	tx: DeliveryTransaction,
	nodeId: string,
	deliveryId: string,
	input: DeliveryClaimInput,
	storedInput: Record<string, unknown>,
): Promise<DeliveryClaimResult | null> {
	const replay = await loadReplay(
		tx,
		nodeId,
		deliveryId,
		"claim",
		input.idempotency_key,
		storedInput,
	);
	return replay === null
		? null
		: deliveryClaimResultSchema.parse({ ...objectOutput(replay.output), replayed: true });
}

async function replayComplete(
	tx: DeliveryTransaction,
	nodeId: string,
	deliveryId: string,
	input: DeliveryCompleteInput,
	storedInput: Record<string, unknown>,
): Promise<DeliveryCompleteResult | null> {
	const replay = await loadReplay(
		tx,
		nodeId,
		deliveryId,
		"complete",
		input.idempotency_key,
		storedInput,
	);
	return replay === null
		? null
		: deliveryCompleteResultSchema.parse({ ...objectOutput(replay.output), replayed: true });
}

async function replayOperation<TResult>(
	tx: DeliveryTransaction,
	nodeId: string,
	deliveryId: string,
	operation: Exclude<PublicNodeOperation, "claim" | "complete">,
	idempotencyKey: string,
	storedInput: Record<string, unknown>,
	parseResult: (input: unknown) => TResult,
): Promise<TResult | null> {
	const replay = await loadReplay(tx, nodeId, deliveryId, operation, idempotencyKey, storedInput);
	if (replay === null) return null;
	return parseResult({ ...objectOutput(replay.output), replayed: true });
}

async function loadReplay(
	tx: DeliveryTransaction,
	nodeId: string,
	deliveryId: string,
	operation: PublicNodeOperation,
	idempotencyKey: string,
	storedInput: Record<string, unknown>,
): Promise<DeliveryOperationReceiptRow | null> {
	const [receipt] = await tx
		.select()
		.from(deliveryOperationReceipts)
		.where(
			and(
				eq(deliveryOperationReceipts.origin, "node"),
				eq(deliveryOperationReceipts.nodeId, nodeId),
				eq(deliveryOperationReceipts.idempotencyKey, idempotencyKey),
			),
		)
		.limit(1);
	if (!receipt) return null;
	if (
		receipt.deliveryId !== deliveryId ||
		receipt.operation !== operation ||
		!isDeepStrictEqual(receipt.input, storedInput)
	) {
		throw new RelayError(
			"duplicate_idempotency_key",
			"Delivery operation key is already bound to different input",
		);
	}
	return receipt;
}

async function prefetchMissionId(
	tx: DeliveryTransaction,
	nodeId: string,
	deliveryId: string,
): Promise<string> {
	const [row] = await tx
		.select({ missionId: nodeDeliveries.missionId })
		.from(nodeDeliveries)
		.where(and(eq(nodeDeliveries.nodeId, nodeId), eq(nodeDeliveries.id, deliveryId)))
		.limit(1);
	if (!row) throw new RelayError("delivery_not_found", "Delivery not found");
	return row.missionId;
}

async function reconcileAndLockDeliveryContext(
	tx: DeliveryTransaction,
	auth: NodeCredentialContext,
	deliveryId: string,
): Promise<LockedDeliveryResult> {
	const missionId = await prefetchMissionId(tx, auth.nodeId, deliveryId);
	const reconciliation = await reconcileMissionInTransaction(tx, missionId);
	const mission = await loadMission(tx, missionId);
	return {
		context: await lockDeliveryContext(tx, auth, deliveryId, mission),
		now: reconciliation.checkedAt,
		reconciledStatus: reconciliation.reconciled ? reconciliation.status : null,
	};
}

async function runLockedDeliveryOperation<TResult>(
	db: Database,
	auth: NodeCredentialContext,
	deliveryId: string,
	operation: (tx: DeliveryTransaction, locked: LockedDeliveryResult) => Promise<TResult>,
): Promise<TResult> {
	return runDeliveryTransaction(db, async (tx) => {
		await lockNodeMutation(tx, auth.nodeId);
		await assertActiveNodeCredential(tx, auth);
		const locked = await reconcileAndLockDeliveryContext(tx, auth, deliveryId);
		return preserveReconciliation(locked, () => operation(tx, locked));
	});
}

async function runDeliveryTransaction<TResult>(
	db: Database,
	operation: (tx: DeliveryTransaction) => Promise<TResult | PostCommitRejection>,
): Promise<TResult> {
	const outcome = await db.transaction(operation);
	if (isPostCommitRejection(outcome)) throw outcome.error;
	return outcome;
}

function terminalMutationError(status: string): RelayError {
	return new RelayError(
		"invalid_transition",
		`Mission reconciled to ${status} before the delivery mutation`,
	);
}

async function preserveReconciliation<TResult>(
	locked: LockedDeliveryResult,
	operation: () => Promise<TResult>,
): Promise<TResult | PostCommitRejection> {
	try {
		return await operation();
	} catch (error) {
		if (locked.reconciledStatus !== null) return postCommitReject(error);
		throw error;
	}
}

function postCommitReject(error: unknown): PostCommitRejection {
	return { [postCommitRejection]: true, error };
}

function isPostCommitRejection(value: unknown): value is PostCommitRejection {
	return (
		typeof value === "object" &&
		value !== null &&
		postCommitRejection in value &&
		(value as PostCommitRejection)[postCommitRejection] === true
	);
}

async function assertDeliveryMissionTrust(
	tx: DeliveryTransaction,
	mission: Mission,
): Promise<void> {
	const manifest = missionCoordinatorConfigSchema.parse(mission.coordinatorConfig).mission_context
		.manifest;
	await assertMissionTrustBoundary(tx, [
		mission.createdByAgentId,
		...manifest.participants.map((participant) => participant.agent_id),
	]);
}

async function loadMission(tx: DeliveryTransaction, missionId: string): Promise<Mission> {
	const [mission] = await tx.select().from(missions).where(eq(missions.id, missionId)).limit(1);
	if (!mission) throw new RelayError("internal", "Delivery Mission is missing");
	return mission;
}

async function assertMissionRoutingAuthority(
	tx: DeliveryTransaction,
	mission: Mission,
): Promise<void> {
	const manifest = missionCoordinatorConfigSchema.parse(mission.coordinatorConfig).mission_context
		.manifest;
	const expectedParticipants = new Map(
		manifest.participants.map((participant) => [participant.agent_id, participant] as const),
	);
	const routes = await tx
		.select({
			participantAgentId: missionParticipants.agentId,
			participantNodeId: missionParticipants.nodeId,
			participantStatus: missionParticipants.status,
			agentStatus: agents.status,
			nodeStatus: nodes.status,
			workspaceNodeId: workspaceBindings.nodeId,
			workspaceAlias: workspaceBindings.alias,
			workspaceRepositoryUrl: workspaceBindings.repositoryUrl,
			workspaceStatus: workspaceBindings.status,
		})
		.from(missionParticipants)
		.innerJoin(agents, eq(agents.id, missionParticipants.agentId))
		.innerJoin(
			nodes,
			and(eq(nodes.id, missionParticipants.nodeId), eq(nodes.agentId, missionParticipants.agentId)),
		)
		.innerJoin(
			workspaceBindings,
			and(
				eq(workspaceBindings.id, missionParticipants.workspaceBindingId),
				eq(workspaceBindings.nodeId, missionParticipants.nodeId),
			),
		)
		.where(eq(missionParticipants.missionId, mission.id));

	const authorityIsActive =
		routes.length === expectedParticipants.size &&
		routes.every((route) => {
			const expected = expectedParticipants.get(route.participantAgentId);
			return (
				expected !== undefined &&
				route.participantStatus === "accepted" &&
				route.agentStatus === "active" &&
				route.nodeStatus === "active" &&
				route.workspaceStatus === "active" &&
				route.workspaceNodeId === route.participantNodeId &&
				route.workspaceAlias === expected.workspace_alias &&
				route.workspaceRepositoryUrl === expected.repository_url
			);
		});
	if (!authorityIsActive) {
		throw new RelayError(
			"not_authorized_transition",
			"Mission participant routing authority is no longer active",
		);
	}
}

async function lockDeliveryContext(
	tx: DeliveryTransaction,
	auth: NodeCredentialContext,
	deliveryId: string,
	mission: Mission,
): Promise<LockedDeliveryContext> {
	const delivery = await lockDelivery(tx, auth.nodeId, deliveryId);
	const [row] = await tx
		.select({
			participantStatus: missionParticipants.status,
			workspaceStatus: workspaceBindings.status,
		})
		.from(missionParticipants)
		.innerJoin(workspaceBindings, eq(workspaceBindings.id, missionParticipants.workspaceBindingId))
		.where(
			and(
				eq(missionParticipants.missionId, mission.id),
				eq(missionParticipants.nodeId, auth.nodeId),
				eq(missionParticipants.agentId, auth.agentId),
			),
		)
		.limit(1);
	if (!row) {
		throw new RelayError("delivery_not_found", "Delivery not found");
	}
	return { delivery, mission, ...row };
}

async function lockDelivery(
	tx: DeliveryTransaction,
	nodeId: string,
	deliveryId: string,
): Promise<NodeDelivery> {
	const [delivery] = await tx
		.select()
		.from(nodeDeliveries)
		.where(and(eq(nodeDeliveries.nodeId, nodeId), eq(nodeDeliveries.id, deliveryId)))
		.for("update");
	if (!delivery) throw new RelayError("delivery_not_found", "Delivery not found");
	return delivery;
}

function assertRunnableContext(context: LockedDeliveryContext, now: Date): void {
	if (context.participantStatus !== "accepted" || context.workspaceStatus !== "active") {
		throw new RelayError("not_authorized_transition", "Delivery assignment is no longer active");
	}
	if (context.mission.expiresAt.getTime() <= now.getTime()) {
		throw new RelayError("invalid_transition", "Mission has expired");
	}
	if (context.mission.status !== "active" && context.mission.status !== "verifying") {
		throw new RelayError("invalid_transition", "Mission is not accepting Node work");
	}
}

function assertReplayableDelivery(delivery: NodeDelivery): void {
	if (delivery.status === "cancelled") {
		throw new RelayError(
			"not_authorized_transition",
			"Cancelled delivery receipts cannot authorize operation replay",
		);
	}
}

function assertActiveLeaseStatus(delivery: NodeDelivery): void {
	if (delivery.status !== "leased" && delivery.status !== "executing") {
		throw new RelayError("invalid_transition", "Delivery does not have active lease authority");
	}
}

function assertLeaseAuthority(
	delivery: NodeDelivery,
	input: Pick<DeliveryStartInput, "lease_id" | "fencing_token">,
	now: Date,
): void {
	if (
		delivery.activeLeaseId !== input.lease_id ||
		delivery.lastFencingToken !== input.fencing_token
	) {
		throw new RelayError("state_changed", "Delivery lease authority is stale");
	}
	if (delivery.leaseExpiresAt === null || delivery.leaseExpiresAt.getTime() <= now.getTime()) {
		throw new RelayError("invalid_transition", "Delivery lease has expired");
	}
}

function buildCompletionEvents(
	context: LockedDeliveryContext,
	auth: NodeCredentialContext,
	input: DeliveryCompleteInput,
	now: Date,
): MissionCoordinatorAppendInput[] {
	const { delivery } = context;
	const state = missionCoordinatorStateSchema.parse(context.mission.state);
	const expectedType =
		delivery.kind === "turn"
			? "turn_completed"
			: delivery.kind === "contract_acknowledgement"
				? "contract_acknowledged"
				: "verification_recorded";
	if (input.result.type !== expectedType) {
		throw new RelayError("invalid_params", "Completion result does not match delivery kind");
	}

	if (input.result.type === "turn_completed") {
		const { disposition } = input.result;
		const message =
			disposition.kind === "reply"
				? {
						message_id: randomUUID(),
						mission_id: delivery.missionId,
						sequence_no: state.messages.length + 1,
						author_agent_id: auth.agentId,
						type: disposition.message_type,
						body: disposition.message,
						artifacts: disposition.artifacts ?? [],
						contract_version: delivery.contractVersion,
						idempotency_key: `message:${randomUUID()}`,
						causal_parent_message_id: state.messages.at(-1)?.message_id ?? null,
						created_at: now.toISOString(),
					}
				: null;
		const revision =
			disposition.kind === "propose_contract"
				? {
						revision_id: randomUUID(),
						mission_id: delivery.missionId,
						previous_version: delivery.contractVersion,
						version: delivery.contractVersion + 1,
						artifact: disposition.artifact,
						proposed_by_agent_id: auth.agentId,
						acknowledged_by_agent_ids: [],
						idempotency_key: `revision:${randomUUID()}`,
						created_at: now.toISOString(),
					}
				: null;
		return [
			parseCompletionAppendInput({
				idempotency_key: `event:${randomUUID()}`,
				type: "turn_completed",
				participant_agent_id: auth.agentId,
				delivery_id: delivery.id,
				contract_version: delivery.contractVersion,
				disposition,
				message,
				revision,
			}),
		];
	}

	if (input.result.type === "contract_acknowledged") {
		const pending = state.pending_revision;
		if (pending === null) {
			throw new RelayError("invalid_transition", "Mission has no pending contract revision");
		}
		return [
			parseCompletionAppendInput({
				idempotency_key: `event:${randomUUID()}`,
				type: "contract_acknowledged",
				participant_agent_id: auth.agentId,
				delivery_id: delivery.id,
				revision_id: pending.revision_id,
				contract_version: delivery.contractVersion,
				artifact: pending.artifact,
			}),
		];
	}

	const requiredCommands = state.required_verification_commands[auth.agentId];
	if (delivery.verificationRound === null || requiredCommands === undefined) {
		throw new RelayError("invalid_transition", "Verification delivery routing is invalid");
	}
	const evidenceByCommand = new Map(
		input.result.evidence.map((evidence) => [evidence.command_id, evidence] as const),
	);
	if (
		evidenceByCommand.size !== requiredCommands.length ||
		requiredCommands.some((commandId) => !evidenceByCommand.has(commandId))
	) {
		throw new RelayError(
			"invalid_params",
			"Verification completion must contain the exact required command set",
			{ required_command_ids: requiredCommands },
		);
	}
	const orderedEvidence = requiredCommands.map((commandId) => evidenceByCommand.get(commandId)!);
	return orderedEvidence.map((evidence) =>
		parseCompletionAppendInput({
			idempotency_key: `event:${randomUUID()}`,
			type: "verification_recorded",
			participant_agent_id: auth.agentId,
			delivery_id: delivery.id,
			contract_version: delivery.contractVersion,
			verification_round: delivery.verificationRound,
			evidence,
		}),
	);
}

function parseCompletionAppendInput(input: unknown): MissionCoordinatorAppendInput {
	const parsed = missionCoordinatorAppendInputSchema.safeParse(input);
	if (!parsed.success) {
		throw new RelayError("invalid_params", "Completion content is invalid for this Mission", {
			issues: parsed.error.issues,
		});
	}
	return parsed.data;
}

async function cancelSupersededSiblings(
	tx: DeliveryTransaction,
	auth: NodeCredentialContext,
	source: NodeDelivery,
	settlementEventId: string,
	now: Date,
): Promise<void> {
	const siblings = await tx
		.select()
		.from(nodeDeliveries)
		.where(
			and(
				eq(nodeDeliveries.missionId, source.missionId),
				eq(nodeDeliveries.settledByEventId, settlementEventId),
				ne(nodeDeliveries.id, source.id),
				inArray(nodeDeliveries.status, ["stored", "leased", "executing"]),
			),
		)
		.orderBy(asc(nodeDeliveries.cursor))
		.for("update");
	for (const sibling of siblings) {
		const [cancelled] = await tx
			.update(nodeDeliveries)
			.set({
				status: "cancelled",
				activeLeaseId: null,
				leaseExpiresAt: null,
				cancelledAt: now,
				cancellationReason: "work_superseded",
				updatedAt: now,
			})
			.where(
				and(
					eq(nodeDeliveries.id, sibling.id),
					eq(nodeDeliveries.status, sibling.status),
					eq(nodeDeliveries.settledByEventId, settlementEventId),
				),
			)
			.returning();
		if (!cancelled) throw new RelayError("internal", "Failed to cancel superseded delivery");
		await tx.insert(deliveryOperationReceipts).values({
			origin: "relay",
			nodeId: sibling.nodeId,
			missionId: sibling.missionId,
			deliveryId: sibling.id,
			operation: "cancel",
			idempotencyKey: `cancel:${sibling.id}:${settlementEventId}`,
			credentialId: null,
			attemptCount: sibling.attemptCount,
			leaseId: sibling.activeLeaseId,
			fencingToken: sibling.activeLeaseId === null ? null : sibling.lastFencingToken,
			leaseExpiresAt: sibling.leaseExpiresAt,
			statusBefore: sibling.status,
			statusAfter: "cancelled",
			cancellationReason: "work_superseded",
			input: { reason: "work_superseded", settled_by_event_id: settlementEventId },
			output: { delivery: deliveryFromRow(cancelled) },
			recordedAt: now,
		});
		await writeAudit(tx, {
			actorId: auth.agentId,
			action: "delivery.cancel",
			resourceType: "node_delivery",
			resourceId: sibling.id,
			requestId: auth.requestId,
			metadata: {
				origin: "relay",
				node_id: sibling.nodeId,
				mission_id: sibling.missionId,
				reason: "work_superseded",
				settled_by_event_id: settlementEventId,
			},
		});
	}
}

async function deadLetterExpiredFinalClaim(
	tx: DeliveryTransaction,
	auth: NodeCredentialContext,
	context: LockedDeliveryContext,
	input: DeliveryClaimInput,
	storedInput: Record<string, unknown>,
	now: Date,
): Promise<DeliveryClaimResult> {
	const statusBefore = context.delivery.status;
	if (statusBefore !== "leased" && statusBefore !== "executing") {
		throw new RelayError("internal", "Terminal recovery requires an expired active delivery");
	}
	const [deadLettered] = await tx
		.update(nodeDeliveries)
		.set({
			status: "dead_lettered",
			activeLeaseId: null,
			leaseExpiresAt: null,
			deadLetteredAt: now,
			updatedAt: now,
		})
		.where(eq(nodeDeliveries.id, context.delivery.id))
		.returning();
	if (!deadLettered) throw new RelayError("internal", "Failed to dead-letter expired delivery");
	const receipt = operationReceipt({
		operation: "claim",
		idempotencyKey: input.idempotency_key,
		nodeId: auth.nodeId,
		delivery: deadLettered,
		statusBefore,
		leaseId: null,
		fencingToken: null,
		leaseExpiresAt: null,
		claimOutcome: "dead_lettered",
		recordedAt: now,
	});
	const result = deliveryClaimResultSchema.parse({
		outcome: "dead_lettered",
		delivery: deliveryFromRow(deadLettered),
		receipt,
		replayed: false,
	});
	await persistNodeReceipt(tx, auth, deadLettered, receipt, storedInput, result);
	await auditNodeOperation(tx, auth, deadLettered, receipt);
	await reconcileMissionInTransaction(tx, deadLettered.missionId);
	return result;
}

async function expireLeaseForRetry(
	tx: DeliveryTransaction,
	auth: NodeCredentialContext,
	delivery: NodeDelivery,
	now: Date,
): Promise<void> {
	if (
		(delivery.status !== "leased" && delivery.status !== "executing") ||
		delivery.activeLeaseId === null ||
		delivery.leaseExpiresAt === null
	) {
		throw new RelayError("internal", "Expired retry is missing prior lease authority");
	}
	const statusBefore = delivery.status;
	const [stored] = await tx
		.update(nodeDeliveries)
		.set({
			status: "stored",
			activeLeaseId: null,
			leaseExpiresAt: null,
			availableAt: now,
			updatedAt: now,
		})
		.where(eq(nodeDeliveries.id, delivery.id))
		.returning();
	if (!stored) throw new RelayError("internal", "Failed to recover expired delivery lease");
	await tx.insert(deliveryOperationReceipts).values({
		origin: "relay",
		nodeId: delivery.nodeId,
		missionId: delivery.missionId,
		deliveryId: delivery.id,
		operation: "lease_expired",
		idempotencyKey: `lease-expired:${delivery.id}:${delivery.attemptCount}`,
		credentialId: null,
		attemptCount: delivery.attemptCount,
		leaseId: delivery.activeLeaseId,
		fencingToken: delivery.lastFencingToken,
		leaseExpiresAt: delivery.leaseExpiresAt,
		statusBefore,
		statusAfter: "stored",
		cancellationReason: null,
		input: {
			lease_id: delivery.activeLeaseId,
			fencing_token: delivery.lastFencingToken,
		},
		output: { delivery: deliveryFromRow(stored) },
		recordedAt: now,
	});
	await writeAudit(tx, {
		actorId: auth.agentId,
		action: "delivery.lease_expired",
		resourceType: "node_delivery",
		resourceId: delivery.id,
		requestId: auth.requestId,
		metadata: {
			origin: "relay",
			node_id: delivery.nodeId,
			mission_id: delivery.missionId,
			attempt_count: delivery.attemptCount,
			lease_id: delivery.activeLeaseId,
			fencing_token: delivery.lastFencingToken,
			status_before: statusBefore,
			status_after: "stored",
		},
	});
}

async function loadMissionEvent(tx: DeliveryTransaction, eventId: string) {
	const [event] = await tx
		.select()
		.from(missionEvents)
		.where(eq(missionEvents.id, eventId))
		.limit(1);
	if (!event) throw new RelayError("internal", "Delivery source Mission event is missing");
	return event;
}

async function persistNodeReceipt(
	tx: DeliveryTransaction,
	auth: NodeCredentialContext,
	delivery: NodeDelivery,
	receipt: DeliveryOperationReceipt,
	input: Record<string, unknown>,
	output: Record<string, unknown> | object,
): Promise<void> {
	await tx.insert(deliveryOperationReceipts).values({
		id: receipt.receipt_id,
		origin: "node",
		nodeId: auth.nodeId,
		missionId: delivery.missionId,
		deliveryId: delivery.id,
		operation: receipt.operation,
		idempotencyKey: receipt.idempotency_key,
		credentialId: auth.credentialId,
		attemptCount: receipt.attempt_count,
		leaseId: receipt.lease?.lease_id ?? null,
		fencingToken: receipt.lease?.fencing_token ?? null,
		leaseExpiresAt: receipt.lease_expires_at === null ? null : new Date(receipt.lease_expires_at),
		statusBefore: receipt.status_before,
		statusAfter: receipt.status_after,
		cancellationReason: receipt.cancellation_reason,
		input,
		output,
		recordedAt: new Date(receipt.recorded_at),
	});
}

async function auditNodeOperation(
	tx: DeliveryTransaction,
	auth: NodeCredentialContext,
	delivery: NodeDelivery,
	receipt: DeliveryOperationReceipt,
): Promise<void> {
	await writeAudit(tx, {
		actorId: auth.agentId,
		action: `delivery.${receipt.operation}`,
		resourceType: "node_delivery",
		resourceId: delivery.id,
		requestId: auth.requestId,
		metadata: {
			node_id: auth.nodeId,
			credential_id: auth.credentialId,
			mission_id: delivery.missionId,
			attempt_count: receipt.attempt_count,
			fencing_token: receipt.lease?.fencing_token ?? null,
			status_before: receipt.status_before,
			status_after: receipt.status_after,
		},
	});
}

function operationReceipt(input: {
	readonly operation: "claim" | "start" | "renew" | "complete" | "release";
	readonly idempotencyKey: string;
	readonly nodeId: string;
	readonly delivery: NodeDelivery;
	readonly statusBefore: string;
	readonly leaseId: string | null;
	readonly fencingToken: string | null;
	readonly leaseExpiresAt: Date | null;
	readonly claimOutcome?: "claimed" | "dead_lettered";
	readonly release?: { readonly classification: string; readonly summary: string };
	readonly recordedAt: Date;
}): DeliveryOperationReceipt {
	return deliveryOperationReceiptSchema.parse({
		receipt_id: randomUUID(),
		operation: input.operation,
		idempotency_key: input.idempotencyKey,
		node_id: input.nodeId,
		delivery_id: input.delivery.id,
		attempt_count: input.delivery.attemptCount,
		lease:
			input.leaseId === null || input.fencingToken === null
				? null
				: { lease_id: input.leaseId, fencing_token: input.fencingToken },
		lease_expires_at: input.leaseExpiresAt?.toISOString() ?? null,
		status_before: input.statusBefore,
		status_after: input.delivery.status,
		logical_settlement:
			input.delivery.settledByEventId === null || input.delivery.settledAt === null
				? null
				: {
						settled_by_event_id: input.delivery.settledByEventId,
						settled_at: input.delivery.settledAt.toISOString(),
					},
		claim_outcome: input.claimOutcome ?? null,
		release: input.release ?? null,
		cancellation_reason: input.delivery.cancellationReason,
		recorded_at: input.recordedAt.toISOString(),
	});
}

function operationInput(
	deliveryId: string,
	input:
		| DeliveryClaimInput
		| DeliveryStartInput
		| DeliveryRenewInput
		| DeliveryCompleteInput
		| DeliveryReleaseInput,
): Record<string, unknown> {
	return { delivery_id: deliveryId, ...input };
}

function objectOutput(output: unknown): Record<string, unknown> {
	if (output === null || typeof output !== "object" || Array.isArray(output)) {
		throw new RelayError("internal", "Stored delivery operation output is invalid");
	}
	return output as Record<string, unknown>;
}

function boundedLeaseExpiry(now: Date, missionExpiresAt: Date): Date {
	const expiry = new Date(Math.min(now.getTime() + LEASE_DURATION_MS, missionExpiresAt.getTime()));
	if (expiry.getTime() <= now.getTime()) {
		throw new RelayError("invalid_transition", "Mission has no remaining lease window");
	}
	return expiry;
}

function retryBackoffMs(attemptCount: number): number {
	return Math.min(MAX_RETRY_BACKOFF_MS, 1_000 * 2 ** Math.max(0, attemptCount - 1));
}

async function readDatabaseClock(db: Pick<Database, "execute">): Promise<Date> {
	const [clock] = await db.execute(sql<{ now: string }>`SELECT clock_timestamp()::text AS now`);
	if (!clock) throw new RelayError("internal", "Database clock is unavailable");
	const value = clock.now;
	if (typeof value !== "string") {
		throw new RelayError("internal", "Database returned an invalid wall clock");
	}
	return parseDatabaseClock(value);
}

function parseDatabaseClock(value: string): Date {
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime())) {
		throw new RelayError("internal", "Database returned an invalid wall clock");
	}
	return parsed;
}
