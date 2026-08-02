import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
	type NodeDelivery,
	deliveryOperationReceipts,
	missionParticipants,
	nodeDeliveries,
} from "../db/schema.js";
import { RelayError } from "../errors.js";
import { type AuditActor, writeAudit } from "./audit.js";

type RevocationTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

type RevocationScope =
	| { readonly reason: "node_revoked" }
	| { readonly reason: "workspace_revoked"; readonly workspaceBindingId: string };

interface CancelDeliveriesForRevocationInput {
	readonly nodeId: string;
	readonly actorId: string;
	readonly requestId?: string;
	readonly scope: RevocationScope;
}

type CancelDeliveriesForNodeRevocationsInput = AuditActor & {
	readonly nodeIds: readonly string[];
	readonly requestId?: string;
	readonly targetAgentId?: string;
};

type CancelMissionDeliveriesInput = AuditActor & {
	readonly missionIds: readonly string[];
	readonly requestId?: string;
	readonly revokedNodeIds: readonly string[];
	readonly scope: RevocationScope;
	readonly targetAgentId?: string;
};

/**
 * Cancels all active work in Missions invalidated by a revocation transaction
 * that already owns the Node lock.
 * Mission locks use the same key as Mission/delivery mutations and are acquired
 * in UUID order before any delivery row, so shared Missions cannot form a cycle.
 */
export async function cancelDeliveriesForRevocation(
	tx: RevocationTransaction,
	input: CancelDeliveriesForRevocationInput,
): Promise<readonly string[]> {
	const participantConditions = [eq(missionParticipants.nodeId, input.nodeId)];
	if (input.scope.reason === "workspace_revoked") {
		participantConditions.push(
			eq(missionParticipants.workspaceBindingId, input.scope.workspaceBindingId),
		);
	}
	const participantMissions = await tx
		.selectDistinct({ missionId: missionParticipants.missionId })
		.from(missionParticipants)
		.where(and(...participantConditions))
		.orderBy(asc(missionParticipants.missionId));
	const missionIds = participantMissions.map((participant) => participant.missionId);
	return cancelMissionDeliveries(tx, {
		missionIds,
		actorKind: "agent",
		actorId: input.actorId,
		requestId: input.requestId,
		revokedNodeIds: [input.nodeId],
		scope: input.scope,
	});
}

/** Cancels the union of Missions for a caller that owns every listed Node lock. */
export async function cancelDeliveriesForNodeRevocations(
	tx: RevocationTransaction,
	input: CancelDeliveriesForNodeRevocationsInput,
): Promise<readonly string[]> {
	const nodeIds = [...new Set(input.nodeIds)].sort();
	if (nodeIds.length === 0) return [];
	const participantMissions = await tx
		.selectDistinct({ missionId: missionParticipants.missionId })
		.from(missionParticipants)
		.where(inArray(missionParticipants.nodeId, nodeIds))
		.orderBy(asc(missionParticipants.missionId));
	return cancelMissionDeliveries(tx, {
		missionIds: participantMissions.map((participant) => participant.missionId),
		...copyAuditActor(input),
		requestId: input.requestId,
		revokedNodeIds: nodeIds,
		scope: { reason: "node_revoked" },
		targetAgentId: input.targetAgentId,
	});
}

async function cancelMissionDeliveries(
	tx: RevocationTransaction,
	input: CancelMissionDeliveriesInput,
): Promise<readonly string[]> {
	const missionIds = [...new Set(input.missionIds)].sort();
	if (missionIds.length === 0) return [];

	// Include awaiting Missions in the participant snapshot. A concurrent second
	// acceptance must cross one of these locks before it can derive Node work.
	for (const missionId of missionIds) {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${missionId}, 0))`);
	}

	const deliveries = await tx
		.select()
		.from(nodeDeliveries)
		.where(
			and(
				inArray(nodeDeliveries.missionId, missionIds),
				inArray(nodeDeliveries.status, ["stored", "leased", "executing"]),
			),
		)
		.orderBy(asc(nodeDeliveries.missionId), asc(nodeDeliveries.id))
		.for("update");
	if (deliveries.length === 0) return [];

	const now = await readDatabaseClock(tx);
	const cancelledIds: string[] = [];
	for (const delivery of deliveries) {
		const [cancelled] = await tx
			.update(nodeDeliveries)
			.set({
				status: "cancelled",
				activeLeaseId: null,
				leaseExpiresAt: null,
				cancelledAt: now,
				cancellationReason: input.scope.reason,
				updatedAt: now,
			})
			.where(eq(nodeDeliveries.id, delivery.id))
			.returning();
		if (!cancelled) {
			throw new RelayError("internal", "Failed to cancel delivery during revocation");
		}

		const priorLease = priorLeaseEvidence(delivery);
		await tx.insert(deliveryOperationReceipts).values({
			origin: "relay",
			nodeId: delivery.nodeId,
			missionId: delivery.missionId,
			deliveryId: delivery.id,
			operation: "cancel",
			idempotencyKey: `cancel:${input.scope.reason}:${delivery.id}`,
			credentialId: null,
			attemptCount: delivery.attemptCount,
			leaseId: priorLease?.lease_id ?? null,
			fencingToken: priorLease?.fencing_token ?? null,
			leaseExpiresAt: priorLease === null ? null : new Date(priorLease.lease_expires_at),
			statusBefore: delivery.status,
			statusAfter: "cancelled",
			cancellationReason: input.scope.reason,
			input: {
				reason: input.scope.reason,
				node_id: delivery.nodeId,
				revoked_node_id: input.revokedNodeIds.length === 1 ? input.revokedNodeIds[0] : null,
				revoked_node_ids: input.revokedNodeIds,
				workspace_binding_id:
					input.scope.reason === "workspace_revoked" ? input.scope.workspaceBindingId : null,
				status_before: delivery.status,
				prior_lease: priorLease,
			},
			output: cancelledOutput(cancelled),
			recordedAt: now,
		});
		const auditActor = copyAuditActor(input);
		await writeAudit(tx, {
			...auditActor,
			action: "delivery.cancel",
			resourceType: "node_delivery",
			resourceId: delivery.id,
			requestId: input.requestId,
			metadata: {
				...(input.targetAgentId
					? {
							target_agent_id: input.targetAgentId,
						}
					: {}),
				origin: "relay",
				node_id: delivery.nodeId,
				revoked_node_id: input.revokedNodeIds.length === 1 ? input.revokedNodeIds[0] : null,
				revoked_node_ids: input.revokedNodeIds,
				mission_id: delivery.missionId,
				workspace_binding_id:
					input.scope.reason === "workspace_revoked" ? input.scope.workspaceBindingId : null,
				reason: input.scope.reason,
				status_before: delivery.status,
				attempt_count: delivery.attemptCount,
				lease_id: priorLease?.lease_id ?? null,
				fencing_token: priorLease?.fencing_token ?? null,
				lease_expires_at: priorLease?.lease_expires_at ?? null,
			},
		});
		cancelledIds.push(delivery.id);
	}
	return cancelledIds;
}

function copyAuditActor(actor: AuditActor): AuditActor {
	if (actor.actorKind === "agent") {
		return { actorKind: "agent", actorId: actor.actorId };
	}
	return { actorKind: actor.actorKind, actorId: null };
}

function priorLeaseEvidence(delivery: NodeDelivery): {
	readonly lease_id: string;
	readonly fencing_token: string;
	readonly lease_expires_at: string;
} | null {
	if (delivery.activeLeaseId === null && delivery.leaseExpiresAt === null) return null;
	if (delivery.activeLeaseId === null || delivery.leaseExpiresAt === null) {
		throw new RelayError("internal", "Delivery has partial lease authority during revocation");
	}
	return {
		lease_id: delivery.activeLeaseId,
		fencing_token: delivery.lastFencingToken,
		lease_expires_at: delivery.leaseExpiresAt.toISOString(),
	};
}

function cancelledOutput(delivery: NodeDelivery): Record<string, unknown> {
	return {
		delivery: {
			delivery_id: delivery.id,
			node_id: delivery.nodeId,
			mission_id: delivery.missionId,
			status: delivery.status,
			attempt_count: delivery.attemptCount,
			last_fencing_token: delivery.lastFencingToken,
			lease: null,
			logical_settlement:
				delivery.settledByEventId === null || delivery.settledAt === null
					? null
					: {
							settled_by_event_id: delivery.settledByEventId,
							settled_at: delivery.settledAt.toISOString(),
						},
			cancelled_at: delivery.cancelledAt?.toISOString() ?? null,
			cancellation_reason: delivery.cancellationReason,
		},
	};
}

async function readDatabaseClock(tx: RevocationTransaction): Promise<Date> {
	const [clock] = await tx.execute(sql<{ now: string }>`SELECT clock_timestamp()::text AS now`);
	if (!clock || typeof clock.now !== "string") {
		throw new RelayError("internal", "Database clock is unavailable during revocation");
	}
	const now = new Date(clock.now);
	if (!Number.isFinite(now.getTime())) {
		throw new RelayError("internal", "Database returned an invalid revocation timestamp");
	}
	return now;
}
