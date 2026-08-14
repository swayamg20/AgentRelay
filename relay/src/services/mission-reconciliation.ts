import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type MissionCoordinatorEvent,
	missionCoordinatorConfigSchema,
	missionCoordinatorEventSchema,
	missionCoordinatorStateSchema,
	reduceMissionCoordinatorEvent,
	replayMissionCoordinatorEvents,
} from "@agentrelay/protocol";
import { and, asc, eq, exists, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
	deliveryOperationReceipts,
	missionEvents,
	missionParticipants,
	missions,
	nodeDeliveries,
} from "../db/schema.js";
import { RelayError } from "../errors.js";
import { writeAudit } from "./audit.js";
import { deliveryFromRow, eventFromRow, lockMissionMutation } from "./mission-ledger.js";

type ReconciliationTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type TerminalEvent = Extract<MissionCoordinatorEvent, { readonly type: "mission_terminal" }>;
type TerminalCause =
	| { readonly status: "expired"; readonly reason: "deadline_exceeded"; readonly deliveryId: null }
	| {
			readonly status: "failed";
			readonly reason: "delivery_dead_lettered";
			readonly deliveryId: string;
	  };

export interface MissionReconciliationResult {
	readonly missionId: string;
	readonly reconciled: boolean;
	readonly status: string;
	readonly event: TerminalEvent | null;
	readonly checkedAt: Date;
}

export async function reconcileMission(
	db: Database,
	missionId: string,
): Promise<MissionReconciliationResult> {
	return db.transaction((tx) => reconcileMissionInTransaction(tx, missionId));
}

export async function reconcileNodeMissions(db: Database, nodeId: string): Promise<void> {
	const unresolvedDeadLetter = db
		.select({ id: nodeDeliveries.id })
		.from(nodeDeliveries)
		.where(
			and(
				eq(nodeDeliveries.missionId, missions.id),
				eq(nodeDeliveries.status, "dead_lettered"),
				isNull(nodeDeliveries.settledByEventId),
			),
		)
		.limit(1);
	const candidates = await db
		.select({ missionId: missions.id })
		.from(missions)
		.innerJoin(missionParticipants, eq(missionParticipants.missionId, missions.id))
		.where(
			and(
				eq(missionParticipants.nodeId, nodeId),
				inArray(missions.status, ["active", "verifying"]),
				or(lte(missions.expiresAt, sql`clock_timestamp()`), exists(unresolvedDeadLetter)),
			),
		);
	for (const candidate of candidates) await reconcileMission(db, candidate.missionId);
}

export async function reconcileMissionInTransaction(
	tx: ReconciliationTransaction,
	missionId: string,
): Promise<MissionReconciliationResult> {
	await lockMissionMutation(tx, missionId);
	const [mission] = await tx.select().from(missions).where(eq(missions.id, missionId)).limit(1);
	if (!mission) throw new RelayError("internal", "Mission reconciliation target is missing");
	const now = await readDatabaseClock(tx);
	if (mission.status !== "active" && mission.status !== "verifying") {
		return { missionId, reconciled: false, status: mission.status, event: null, checkedAt: now };
	}

	const cause = await terminalCause(tx, missionId, mission.expiresAt, now);
	if (cause === null) {
		return { missionId, reconciled: false, status: mission.status, event: null, checkedAt: now };
	}

	const config = missionCoordinatorConfigSchema.parse(mission.coordinatorConfig);
	const storedEvents = await tx
		.select()
		.from(missionEvents)
		.where(eq(missionEvents.missionId, missionId))
		.orderBy(asc(missionEvents.sequenceNo));
	const currentState = replayMissionCoordinatorEvents(config, storedEvents.map(eventFromRow));
	const projectedState = missionCoordinatorStateSchema.parse(mission.state);
	if (
		currentState.sequence_no !== mission.lastEventSequence ||
		!isDeepStrictEqual(currentState, projectedState)
	) {
		throw new RelayError("internal", "Stored Mission projection does not match its event ledger");
	}

	const eventId = randomUUID();
	const terminalIdempotencyKey =
		cause.status === "expired"
			? "relay:mission-terminal:deadline"
			: `relay:mission-terminal:delivery:${cause.deliveryId}`;
	const parsedEvent = missionCoordinatorEventSchema.parse({
		event_id: eventId,
		idempotency_key: terminalIdempotencyKey,
		mission_id: missionId,
		sequence_no: currentState.sequence_no + 1,
		created_at: now.toISOString(),
		type: "mission_terminal",
		terminal_status: cause.status,
		reason: cause.reason,
		triggering_delivery_id: cause.deliveryId,
	});
	if (parsedEvent.type !== "mission_terminal") {
		throw new RelayError("internal", "Mission reconciliation produced a non-terminal event");
	}
	const event: TerminalEvent = parsedEvent;
	const nextState = reduceMissionCoordinatorEvent(currentState, event);
	const previousEvent = storedEvents.at(-1);
	await tx.insert(missionEvents).values({
		id: event.event_id,
		missionId,
		sequenceNo: event.sequence_no,
		type: event.type,
		actorKind: "system",
		actorAgentId: null,
		idempotencyKey: event.idempotency_key,
		sourceDeliveryId: cause.deliveryId,
		causalParentEventId: previousEvent?.id ?? null,
		payload: {
			terminal_status: event.terminal_status,
			reason: event.reason,
			triggering_delivery_id: event.triggering_delivery_id,
		},
		createdAt: now,
	});

	const cancellationReason = cause.status === "expired" ? "mission_expired" : "mission_failed";
	const activeDeliveries = await tx
		.select()
		.from(nodeDeliveries)
		.where(
			and(
				eq(nodeDeliveries.missionId, missionId),
				inArray(nodeDeliveries.status, ["stored", "leased", "executing"]),
				isNull(nodeDeliveries.settledByEventId),
			),
		)
		.orderBy(asc(nodeDeliveries.cursor))
		.for("update");
	for (const delivery of activeDeliveries) {
		const [cancelled] = await tx
			.update(nodeDeliveries)
			.set({
				status: "cancelled",
				activeLeaseId: null,
				leaseExpiresAt: null,
				settledByEventId: delivery.settledByEventId ?? event.event_id,
				settledAt: delivery.settledAt ?? now,
				cancelledAt: now,
				cancellationReason,
				updatedAt: now,
			})
			.where(and(eq(nodeDeliveries.id, delivery.id), eq(nodeDeliveries.status, delivery.status)))
			.returning();
		if (!cancelled) throw new RelayError("internal", "Failed to cancel terminal Mission work");
		await tx.insert(deliveryOperationReceipts).values({
			origin: "relay",
			nodeId: delivery.nodeId,
			missionId,
			deliveryId: delivery.id,
			operation: "cancel",
			idempotencyKey: `relay:mission-terminal:${missionId}:${delivery.id}`,
			credentialId: null,
			attemptCount: delivery.attemptCount,
			leaseId: delivery.activeLeaseId,
			fencingToken: delivery.activeLeaseId === null ? null : delivery.lastFencingToken,
			leaseExpiresAt: delivery.leaseExpiresAt,
			statusBefore: delivery.status,
			statusAfter: "cancelled",
			cancellationReason,
			input: { reason: cancellationReason, settled_by_event_id: event.event_id },
			output: { delivery: deliveryFromRow(cancelled) },
			recordedAt: now,
		});
		await writeAudit(tx, {
			actorKind: "system",
			actorId: null,
			action: "delivery.cancel",
			resourceType: "node_delivery",
			resourceId: delivery.id,
			metadata: {
				origin: "relay",
				node_id: delivery.nodeId,
				mission_id: missionId,
				reason: cancellationReason,
				settled_by_event_id: event.event_id,
			},
		});
	}

	await tx
		.update(missions)
		.set({
			state: nextState,
			status: nextState.status,
			lastEventSequence: nextState.sequence_no,
			contractVersion: nextState.contract_version,
			updatedAt: now,
		})
		.where(eq(missions.id, missionId));
	await writeAudit(tx, {
		actorKind: "system",
		actorId: null,
		action: "mission.terminal",
		resourceType: "mission_event",
		resourceId: event.event_id,
		metadata: {
			mission_id: missionId,
			sequence_no: event.sequence_no,
			status: event.terminal_status,
			reason: event.reason,
			triggering_delivery_id: event.triggering_delivery_id,
			cancelled_delivery_ids: activeDeliveries.map((delivery) => delivery.id),
		},
	});
	return { missionId, reconciled: true, status: nextState.status, event, checkedAt: now };
}

async function terminalCause(
	tx: ReconciliationTransaction,
	missionId: string,
	expiresAt: Date,
	now: Date,
): Promise<TerminalCause | null> {
	if (expiresAt.getTime() <= now.getTime()) {
		return { status: "expired", reason: "deadline_exceeded", deliveryId: null };
	}
	const [deadLettered] = await tx
		.select({ id: nodeDeliveries.id })
		.from(nodeDeliveries)
		.where(
			and(
				eq(nodeDeliveries.missionId, missionId),
				eq(nodeDeliveries.status, "dead_lettered"),
				isNull(nodeDeliveries.settledByEventId),
			),
		)
		.orderBy(asc(nodeDeliveries.cursor))
		.limit(1);
	return deadLettered
		? { status: "failed", reason: "delivery_dead_lettered", deliveryId: deadLettered.id }
		: null;
}

async function readDatabaseClock(tx: ReconciliationTransaction): Promise<Date> {
	const [clock] = await tx.execute(sql<{ now: string }>`SELECT clock_timestamp()::text AS now`);
	if (!clock || typeof clock.now !== "string") {
		throw new RelayError("internal", "Database clock is unavailable during Mission reconciliation");
	}
	const now = new Date(clock.now);
	if (!Number.isFinite(now.getTime())) {
		throw new RelayError("internal", "Database returned an invalid reconciliation timestamp");
	}
	return now;
}
