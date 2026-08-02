import { randomUUID } from "node:crypto";
import type { DeliveryClaimResult, MissionCoordinatorConfig } from "@agentrelay/protocol";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	agents,
	auditLog,
	deliveryOperationReceipts,
	missionEvents,
	missionParticipants,
	missions,
	nodeCredentials,
	nodeDeliveries,
	nodes,
	workspaceBindings,
} from "../db/schema.js";
import { type TestDb, truncateAll, tryConnect } from "../db/test-utils.js";
import { claimDelivery, completeDelivery, startDelivery } from "./delivery-ledger.js";
import { acceptMissionParticipant, createMissionLedger } from "./mission-ledger.js";
import { revokeNode, revokeWorkspace } from "./node-enrollment.js";

const conn = await tryConnect();
const d = conn.available ? describe : describe.skip;
const TEST_DATABASE_URL = process.env.RELAY_TEST_DATABASE_URL ?? process.env.RELAY_DATABASE_URL;

if (!conn.available) {
	console.warn(`[delivery-revocation.test] skipping: ${conn.reason}`);
}

d("delivery cancellation during revocation", () => {
	let handle: TestDb;

	beforeAll(() => {
		if (!conn.handle) throw new Error("expected db handle");
		handle = conn.handle;
	});

	beforeEach(async () => {
		await truncateAll(handle.sql);
	});

	afterAll(async () => {
		if (handle) await handle.close();
	});

	it("cancels every active Node delivery with durable lease evidence before revocation", async () => {
		const fixture = await seedNode(handle, ["backend", "android"]);
		const executing = await seedDelivery(handle, fixture, {
			workspaceAlias: "backend",
			missionStatus: "active",
			deliveryStatus: "executing",
		});
		const settled = await seedDelivery(handle, fixture, {
			workspaceAlias: "android",
			missionStatus: "awaiting_acceptance",
			deliveryStatus: "stored",
			settled: true,
		});

		await revokeNode(handle.db, fixture.agentId, fixture.nodeId, {
			requestId: "req-node-revoke",
		});

		const deliveries = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(eq(nodeDeliveries.nodeId, fixture.nodeId))
			.orderBy(asc(nodeDeliveries.missionId), asc(nodeDeliveries.id));
		expect(deliveries).toHaveLength(2);
		for (const delivery of deliveries) {
			expect(delivery).toMatchObject({
				status: "cancelled",
				activeLeaseId: null,
				leaseExpiresAt: null,
				cancellationReason: "node_revoked",
			});
			expect(delivery.cancelledAt).not.toBeNull();
		}
		const storedSettlement = deliveries.find((delivery) => delivery.id === settled.deliveryId);
		expect(storedSettlement?.settledByEventId).toBe(settled.eventId);
		expect(storedSettlement?.settledAt?.toISOString()).toBe(settled.settledAt?.toISOString());

		const activeAfterRevocation = await handle.db
			.select({ id: nodeDeliveries.id })
			.from(nodeDeliveries)
			.where(
				and(eq(nodeDeliveries.nodeId, fixture.nodeId), isNotNull(nodeDeliveries.activeLeaseId)),
			);
		expect(activeAfterRevocation).toEqual([]);

		const receipts = await handle.db
			.select()
			.from(deliveryOperationReceipts)
			.where(eq(deliveryOperationReceipts.nodeId, fixture.nodeId))
			.orderBy(asc(deliveryOperationReceipts.missionId), asc(deliveryOperationReceipts.deliveryId));
		expect(receipts).toHaveLength(2);
		const executingReceipt = receipts.find(
			(receipt) => receipt.deliveryId === executing.deliveryId,
		);
		expect(executingReceipt).toMatchObject({
			origin: "relay",
			operation: "cancel",
			credentialId: null,
			attemptCount: 1,
			leaseId: executing.leaseId,
			fencingToken: "1",
			statusBefore: "executing",
			statusAfter: "cancelled",
			cancellationReason: "node_revoked",
		});
		expect(executingReceipt?.leaseExpiresAt?.toISOString()).toBe(
			executing.leaseExpiresAt?.toISOString(),
		);
		expect(executingReceipt?.input).toMatchObject({
			reason: "node_revoked",
			status_before: "executing",
			prior_lease: {
				lease_id: executing.leaseId,
				fencing_token: "1",
				lease_expires_at: executing.leaseExpiresAt?.toISOString(),
			},
		});
		const storedReceipt = receipts.find((receipt) => receipt.deliveryId === settled.deliveryId);
		expect(storedReceipt).toMatchObject({
			leaseId: null,
			fencingToken: null,
			leaseExpiresAt: null,
			statusBefore: "stored",
			statusAfter: "cancelled",
		});
		for (const receipt of receipts) {
			expect(() => JSON.stringify(receipt.input)).not.toThrow();
			expect(() => JSON.stringify(receipt.output)).not.toThrow();
		}

		const [node] = await handle.db.select().from(nodes).where(eq(nodes.id, fixture.nodeId));
		expect(node).toMatchObject({ status: "revoked" });
		expect(node?.revokedAt).not.toBeNull();
		const activeCredentials = await handle.db
			.select({ id: nodeCredentials.id })
			.from(nodeCredentials)
			.where(and(eq(nodeCredentials.nodeId, fixture.nodeId), isNull(nodeCredentials.revokedAt)));
		expect(activeCredentials).toEqual([]);

		const cancellationAudits = await handle.db
			.select({ resourceId: auditLog.resourceId, action: auditLog.action })
			.from(auditLog)
			.where(eq(auditLog.actorId, fixture.agentId))
			.orderBy(asc(auditLog.id));
		const expectedCancellationOrder = [executing, settled]
			.sort((left, right) =>
				left.missionId === right.missionId
					? left.deliveryId.localeCompare(right.deliveryId)
					: left.missionId.localeCompare(right.missionId),
			)
			.map((delivery) => ({ action: "delivery.cancel", resourceId: delivery.deliveryId }));
		expect(cancellationAudits).toEqual([
			...expectedCancellationOrder,
			{ action: "node.revoke", resourceId: fixture.nodeId },
		]);
	});

	it("cancels only Missions bound to the revoked workspace", async () => {
		const fixture = await seedNode(handle, ["backend", "android"]);
		const backend = await seedDelivery(handle, fixture, {
			workspaceAlias: "backend",
			missionStatus: "active",
			deliveryStatus: "leased",
		});
		const android = await seedDelivery(handle, fixture, {
			workspaceAlias: "android",
			missionStatus: "active",
			deliveryStatus: "leased",
		});

		await revokeWorkspace(
			handle.db,
			{
				nodeId: fixture.nodeId,
				agentId: fixture.agentId,
				credentialId: fixture.credentialId,
				requestId: "req-workspace-revoke",
			},
			"backend",
		);

		const [backendAfter] = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(eq(nodeDeliveries.id, backend.deliveryId));
		expect(backendAfter).toMatchObject({
			status: "cancelled",
			activeLeaseId: null,
			leaseExpiresAt: null,
			cancellationReason: "workspace_revoked",
		});
		const [androidAfter] = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(eq(nodeDeliveries.id, android.deliveryId));
		expect(androidAfter).toMatchObject({
			status: "leased",
			activeLeaseId: android.leaseId,
		});

		const targetWorkspaceId = fixture.workspaces.get("backend");
		if (!targetWorkspaceId) throw new Error("expected backend workspace");
		const activeForRevokedWorkspace = await handle.db
			.select({ id: nodeDeliveries.id })
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
					eq(missionParticipants.workspaceBindingId, targetWorkspaceId),
					isNotNull(nodeDeliveries.activeLeaseId),
				),
			);
		expect(activeForRevokedWorkspace).toEqual([]);

		const receipts = await handle.db
			.select()
			.from(deliveryOperationReceipts)
			.where(eq(deliveryOperationReceipts.nodeId, fixture.nodeId));
		expect(receipts).toHaveLength(1);
		expect(receipts[0]).toMatchObject({
			deliveryId: backend.deliveryId,
			origin: "relay",
			operation: "cancel",
			leaseId: backend.leaseId,
			fencingToken: "1",
			cancellationReason: "workspace_revoked",
		});

		const [node] = await handle.db.select().from(nodes).where(eq(nodes.id, fixture.nodeId));
		expect(node?.status).toBe("active");
		const [credential] = await handle.db
			.select()
			.from(nodeCredentials)
			.where(eq(nodeCredentials.id, fixture.credentialId));
		expect(credential?.revokedAt).toBeNull();
		const workspaces = await handle.db
			.select({ alias: workspaceBindings.alias, status: workspaceBindings.status })
			.from(workspaceBindings)
			.where(eq(workspaceBindings.nodeId, fixture.nodeId))
			.orderBy(asc(workspaceBindings.alias));
		expect(workspaces).toEqual([
			{ alias: "android", status: "active" },
			{ alias: "backend", status: "revoked" },
		]);

		const audits = await handle.db
			.select({ action: auditLog.action, resourceId: auditLog.resourceId })
			.from(auditLog)
			.where(eq(auditLog.actorId, fixture.agentId))
			.orderBy(asc(auditLog.id));
		expect(audits).toEqual([
			{ action: "delivery.cancel", resourceId: backend.deliveryId },
			{ action: "workspace.revoke", resourceId: targetWorkspaceId },
		]);
	});

	it.each(["node", "workspace"] as const)(
		"cancels work across both participant Nodes when peer completion precedes %s revocation",
		async (scope) => {
			const fixture = await createActiveTwoPartyMission(handle);
			await completeReadyTurn(handle, fixture.backend, fixture.initialDeliveryId, "backend-ready");
			const androidTurn = await onlyStoredTurn(handle, fixture.missionId, fixture.android.nodeId);
			const peerCompletion = await completeReadyTurn(
				handle,
				fixture.android,
				androidTurn,
				"android-ready",
			);
			expect(peerCompletion.derived_delivery_ids).toHaveLength(2);

			const activeWork = await handle.db
				.select()
				.from(nodeDeliveries)
				.where(inArray(nodeDeliveries.id, peerCompletion.derived_delivery_ids));
			expect(activeWork).toHaveLength(2);
			expect(activeWork.map((delivery) => delivery.nodeId)).toEqual(
				expect.arrayContaining([fixture.backend.nodeId, fixture.android.nodeId]),
			);
			expect(activeWork.every((delivery) => delivery.status === "stored")).toBe(true);

			await revokeParticipantAuthority(handle, fixture.backend, scope);

			const cancelledWork = await handle.db
				.select()
				.from(nodeDeliveries)
				.where(inArray(nodeDeliveries.id, peerCompletion.derived_delivery_ids));
			expect(cancelledWork).toHaveLength(2);
			for (const delivery of cancelledWork) {
				expect(delivery).toMatchObject({
					status: "cancelled",
					activeLeaseId: null,
					leaseExpiresAt: null,
					cancellationReason: `${scope}_revoked`,
				});
			}

			const receipts = await handle.db
				.select()
				.from(deliveryOperationReceipts)
				.where(
					and(
						inArray(deliveryOperationReceipts.deliveryId, peerCompletion.derived_delivery_ids),
						eq(deliveryOperationReceipts.operation, "cancel"),
					),
				);
			expect(receipts).toHaveLength(2);
			for (const delivery of cancelledWork) {
				const receipt = receipts.find((candidate) => candidate.deliveryId === delivery.id);
				expect(receipt).toMatchObject({
					nodeId: delivery.nodeId,
					missionId: fixture.missionId,
					statusBefore: "stored",
					statusAfter: "cancelled",
					leaseId: null,
					fencingToken: null,
					cancellationReason: `${scope}_revoked`,
					input: {
						node_id: delivery.nodeId,
						revoked_node_id: fixture.backend.nodeId,
						prior_lease: null,
					},
				});
			}

			const cancellationAudits = await handle.db
				.select({ resourceId: auditLog.resourceId, metadata: auditLog.metadata })
				.from(auditLog)
				.where(
					and(
						eq(auditLog.action, "delivery.cancel"),
						inArray(auditLog.resourceId, peerCompletion.derived_delivery_ids),
					),
				);
			expect(cancellationAudits).toHaveLength(2);
			for (const delivery of cancelledWork) {
				const audit = cancellationAudits.find((candidate) => candidate.resourceId === delivery.id);
				expect(audit?.metadata).toMatchObject({
					node_id: delivery.nodeId,
					revoked_node_id: fixture.backend.nodeId,
				});
			}
		},
	);

	it.each(["node", "workspace"] as const)(
		"rejects peer completion without derived work when %s revocation precedes it",
		async (scope) => {
			const fixture = await createActiveTwoPartyMission(handle);
			await completeReadyTurn(handle, fixture.backend, fixture.initialDeliveryId, "backend-ready");
			const androidTurn = await onlyStoredTurn(handle, fixture.missionId, fixture.android.nodeId);
			const execution = await claimAndStart(handle, fixture.android, androidTurn, "android-peer");
			const deliveriesBefore = await handle.db
				.select({ id: nodeDeliveries.id })
				.from(nodeDeliveries)
				.where(eq(nodeDeliveries.missionId, fixture.missionId));
			const eventsBefore = await handle.db
				.select({ id: missionEvents.id })
				.from(missionEvents)
				.where(eq(missionEvents.missionId, fixture.missionId));

			await revokeParticipantAuthority(handle, fixture.backend, scope);

			const [cancelledPeerWork] = await handle.db
				.select()
				.from(nodeDeliveries)
				.where(eq(nodeDeliveries.id, androidTurn));
			expect(cancelledPeerWork).toMatchObject({
				nodeId: fixture.android.nodeId,
				status: "cancelled",
				activeLeaseId: null,
				leaseExpiresAt: null,
				cancellationReason: `${scope}_revoked`,
			});
			const [peerCancelReceipt] = await handle.db
				.select()
				.from(deliveryOperationReceipts)
				.where(
					and(
						eq(deliveryOperationReceipts.deliveryId, androidTurn),
						eq(deliveryOperationReceipts.operation, "cancel"),
					),
				);
			expect(peerCancelReceipt).toMatchObject({
				nodeId: fixture.android.nodeId,
				leaseId: execution.leaseId,
				fencingToken: execution.fencingToken,
				statusBefore: "executing",
				statusAfter: "cancelled",
				input: {
					node_id: fixture.android.nodeId,
					revoked_node_id: fixture.backend.nodeId,
					prior_lease: {
						lease_id: execution.leaseId,
						fencing_token: execution.fencingToken,
						lease_expires_at: execution.leaseExpiresAt,
					},
				},
			});
			expect(peerCancelReceipt?.leaseExpiresAt?.toISOString()).toBe(execution.leaseExpiresAt);
			const [peerCancelAudit] = await handle.db
				.select({ metadata: auditLog.metadata })
				.from(auditLog)
				.where(and(eq(auditLog.action, "delivery.cancel"), eq(auditLog.resourceId, androidTurn)));
			expect(peerCancelAudit?.metadata).toMatchObject({
				node_id: fixture.android.nodeId,
				revoked_node_id: fixture.backend.nodeId,
				lease_id: execution.leaseId,
				fencing_token: execution.fencingToken,
				lease_expires_at: execution.leaseExpiresAt,
			});

			await expect(
				completeDelivery(handle.db, nodeAuth(fixture.android), androidTurn, {
					idempotency_key: "complete:android-peer",
					lease_id: execution.leaseId,
					fencing_token: execution.fencingToken,
					result: {
						type: "turn_completed",
						disposition: { kind: "ready", evidence: [] },
					},
				}),
			).rejects.toMatchObject({ code: "not_authorized_transition" });

			expect(
				await handle.db
					.select({ id: nodeDeliveries.id })
					.from(nodeDeliveries)
					.where(eq(nodeDeliveries.missionId, fixture.missionId)),
			).toHaveLength(deliveriesBefore.length);
			expect(
				await handle.db
					.select({ id: missionEvents.id })
					.from(missionEvents)
					.where(eq(missionEvents.missionId, fixture.missionId)),
			).toHaveLength(eventsBefore.length);
			expect(
				await handle.db
					.select()
					.from(deliveryOperationReceipts)
					.where(
						and(
							eq(deliveryOperationReceipts.deliveryId, androidTurn),
							eq(deliveryOperationReceipts.operation, "complete"),
						),
					),
			).toEqual([]);
		},
	);

	it("locks awaiting participant Missions before revocation can return", async () => {
		if (!TEST_DATABASE_URL) throw new Error("expected test database URL");
		const fixture = await seedNode(handle, ["backend"]);
		const workspaceId = fixture.workspaces.get("backend");
		if (!workspaceId) throw new Error("expected backend workspace");
		const missionId = randomUUID();
		await handle.db.insert(missions).values({
			id: missionId,
			createdByAgentId: fixture.agentId,
			coordinatorConfig: {},
			state: {},
			status: "awaiting_acceptance",
			expiresAt: new Date(Date.now() + 120_000),
		});
		await handle.db.insert(missionParticipants).values({
			missionId,
			agentId: fixture.agentId,
			nodeId: fixture.nodeId,
			workspaceBindingId: workspaceId,
			role: "engineer",
		});

		const blockerSql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => undefined });
		const lockAcquired = deferred();
		const releaseLock = deferred();
		let revocation: Promise<void> | undefined;
		const blocker = blockerSql.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(hashtextextended(${missionId}, 0))`;
			lockAcquired.resolve();
			await releaseLock.promise;
		});

		try {
			await lockAcquired.promise;
			revocation = revokeNode(handle.db, fixture.agentId, fixture.nodeId);
			await waitUntil(async () => {
				const [row] = await handle.sql<Array<{ waiters: string }>>`
					SELECT count(*)::text AS waiters
					FROM pg_locks
					WHERE locktype = 'advisory' AND NOT granted
				`;
				return Number(row?.waiters ?? "0") > 0;
			}, "revocation did not lock the awaiting Mission");

			const [beforeRelease] = await handle.db
				.select({ status: nodes.status })
				.from(nodes)
				.where(eq(nodes.id, fixture.nodeId));
			expect(beforeRelease?.status).toBe("active");
			releaseLock.resolve();
			await blocker;
			await revocation;

			const [afterRelease] = await handle.db
				.select({ status: nodes.status })
				.from(nodes)
				.where(eq(nodes.id, fixture.nodeId));
			expect(afterRelease?.status).toBe("revoked");
		} finally {
			releaseLock.resolve();
			await blocker.catch(() => undefined);
			await revocation?.catch(() => undefined);
			await blockerSql.end({ timeout: 2 });
		}
	});
});

interface NodeFixture {
	readonly agentId: string;
	readonly nodeId: string;
	readonly credentialId: string;
	readonly workspaces: ReadonlyMap<string, string>;
}

interface DeliveryFixture {
	readonly deliveryId: string;
	readonly eventId: string;
	readonly missionId: string;
	readonly leaseId: string | null;
	readonly leaseExpiresAt: Date | null;
	readonly settledAt: Date | null;
}

interface TwoPartyMissionFixture {
	readonly missionId: string;
	readonly backend: NodeFixture;
	readonly android: NodeFixture;
	readonly initialDeliveryId: string;
}

interface ActiveLease {
	readonly leaseId: string;
	readonly fencingToken: string;
	readonly leaseExpiresAt: string;
}

async function createActiveTwoPartyMission(handle: TestDb): Promise<TwoPartyMissionFixture> {
	const backend = await seedNode(handle, ["backend-api"]);
	const android = await seedNode(handle, ["android-app"]);
	const missionId = randomUUID();
	const now = new Date();
	const contract: MissionCoordinatorConfig["mission_context"]["manifest"]["shared_contract"] = {
		artifact_id: randomUUID(),
		type: "api_contract",
		version: 1,
		sha256: "a".repeat(64),
		media_type: "application/json",
		byte_size: 128,
	};
	const config: MissionCoordinatorConfig = {
		mission_context: {
			manifest: {
				schema_version: 1,
				mission_id: missionId,
				objective: "Ship one compatible contract across backend and Android",
				public_acceptance_criteria: ["Both repository checks pass"],
				participants: [
					{
						agent_id: backend.agentId,
						role: "backend",
						workspace_alias: "backend-api",
						repository_url: "https://example.test/backend-api.git",
						expected_base_commit: "1".repeat(40),
						initial_assignment: "Implement the response contract",
						requested_local_policy_profile: "bounded-code",
					},
					{
						agent_id: android.agentId,
						role: "android",
						workspace_alias: "android-app",
						repository_url: "https://example.test/android-app.git",
						expected_base_commit: "2".repeat(40),
						initial_assignment: "Consume the response contract",
						requested_local_policy_profile: "bounded-code",
					},
				],
				shared_contract: contract,
				max_turns: 20,
				max_wall_time_seconds: 3_600,
				token_budget: 100_000,
				expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
				allowed_artifact_types: ["api_contract"],
				created_at: new Date(now.getTime() - 1_000).toISOString(),
			},
			created_by: { principal_id: backend.agentId, kind: "agent" },
		},
		required_verification_commands: {
			[backend.agentId]: ["backend-test"],
			[android.agentId]: ["android-test"],
		},
	};

	await createMissionLedger(handle.db, {
		createdByAgentId: backend.agentId,
		coordinatorConfig: config,
	});
	await acceptMissionParticipant(handle.db, {
		missionId,
		participantAgentId: backend.agentId,
		nodeAuth: nodeAuth(backend),
		acceptance: participantAcceptance(contract, `accept:${missionId}:backend`, "b"),
	});
	await acceptMissionParticipant(handle.db, {
		missionId,
		participantAgentId: android.agentId,
		nodeAuth: nodeAuth(android),
		acceptance: participantAcceptance(contract, `accept:${missionId}:android`, "c"),
	});

	const initialDeliveryId = await onlyStoredTurn(handle, missionId, backend.nodeId);
	return { missionId, backend, android, initialDeliveryId };
}

function nodeAuth(fixture: NodeFixture) {
	return {
		agentId: fixture.agentId,
		nodeId: fixture.nodeId,
		credentialId: fixture.credentialId,
	};
}

function participantAcceptance(
	contract: MissionCoordinatorConfig["mission_context"]["manifest"]["shared_contract"],
	idempotencyKey: string,
	grantCharacter: string,
) {
	return {
		idempotency_key: idempotencyKey,
		contract: { ...contract },
		local_policy_grant: {
			profile_name: "bounded-code",
			grant_sha256: grantCharacter.repeat(64),
		},
	};
}

async function revokeParticipantAuthority(
	handle: TestDb,
	participant: NodeFixture,
	scope: "node" | "workspace",
): Promise<void> {
	if (scope === "node") {
		await revokeNode(handle.db, participant.agentId, participant.nodeId);
		return;
	}
	await revokeWorkspace(handle.db, nodeAuth(participant), "backend-api");
}

async function onlyStoredTurn(handle: TestDb, missionId: string, nodeId: string): Promise<string> {
	const rows = await handle.db
		.select({ id: nodeDeliveries.id })
		.from(nodeDeliveries)
		.where(
			and(
				eq(nodeDeliveries.missionId, missionId),
				eq(nodeDeliveries.nodeId, nodeId),
				eq(nodeDeliveries.kind, "turn"),
				eq(nodeDeliveries.status, "stored"),
			),
		);
	if (rows.length !== 1) throw new Error(`expected one stored turn, got ${rows.length}`);
	return rows[0]!.id;
}

async function claimAndStart(
	handle: TestDb,
	participant: NodeFixture,
	deliveryId: string,
	keySuffix: string,
): Promise<ActiveLease> {
	const claim = requireClaimed(
		await claimDelivery(handle.db, nodeAuth(participant), deliveryId, {
			idempotency_key: `claim:${keySuffix}`,
		}),
	);
	const lease = claim.item.delivery.lease;
	if (!lease) throw new Error("expected an active delivery lease");
	await startDelivery(handle.db, nodeAuth(participant), deliveryId, {
		idempotency_key: `start:${keySuffix}`,
		lease_id: lease.lease_id,
		fencing_token: lease.fencing_token,
	});
	return {
		leaseId: lease.lease_id,
		fencingToken: lease.fencing_token,
		leaseExpiresAt: lease.expires_at,
	};
}

async function completeReadyTurn(
	handle: TestDb,
	participant: NodeFixture,
	deliveryId: string,
	keySuffix: string,
) {
	const lease = await claimAndStart(handle, participant, deliveryId, keySuffix);
	return completeDelivery(handle.db, nodeAuth(participant), deliveryId, {
		idempotency_key: `complete:${keySuffix}`,
		lease_id: lease.leaseId,
		fencing_token: lease.fencingToken,
		result: {
			type: "turn_completed",
			disposition: { kind: "ready", evidence: [] },
		},
	});
}

function requireClaimed(result: DeliveryClaimResult) {
	if (result.outcome !== "claimed") throw new Error("expected a claimed delivery");
	return result;
}

async function seedNode(handle: TestDb, aliases: readonly string[]): Promise<NodeFixture> {
	const agentId = randomUUID();
	const nodeId = randomUUID();
	const credentialId = randomUUID();
	await handle.db.insert(agents).values({
		id: agentId,
		handle: `agent-${agentId}@test`,
		email: `agent-${agentId}@example.test`,
		displayName: "Agent",
		role: "engineer",
	});
	await handle.db.insert(nodes).values({ id: nodeId, agentId, name: "test-node" });
	await handle.db.insert(nodeCredentials).values({
		id: credentialId,
		nodeId,
		keyHash: Buffer.from(`hash-${credentialId}`),
		salt: Buffer.from(`salt-${credentialId}`),
	});
	const workspaces = new Map<string, string>();
	for (const alias of aliases) {
		const workspaceId = randomUUID();
		await handle.db.insert(workspaceBindings).values({
			id: workspaceId,
			nodeId,
			alias,
			repositoryUrl: `https://example.test/${alias}.git`,
		});
		workspaces.set(alias, workspaceId);
	}
	return { agentId, nodeId, credentialId, workspaces };
}

async function seedDelivery(
	handle: TestDb,
	fixture: NodeFixture,
	input: {
		readonly workspaceAlias: string;
		readonly missionStatus: "awaiting_acceptance" | "active";
		readonly deliveryStatus: "stored" | "leased" | "executing";
		readonly settled?: boolean;
	},
): Promise<DeliveryFixture> {
	const workspaceId = fixture.workspaces.get(input.workspaceAlias);
	if (!workspaceId) throw new Error(`missing workspace ${input.workspaceAlias}`);
	const missionId = randomUUID();
	const eventId = randomUUID();
	const deliveryId = randomUUID();
	const activeLease = input.deliveryStatus === "leased" || input.deliveryStatus === "executing";
	const leaseId = activeLease ? randomUUID() : null;
	const leaseExpiresAt = activeLease ? new Date(Date.now() + 60_000) : null;
	const settledAt = input.settled ? new Date() : null;

	await handle.db.insert(missions).values({
		id: missionId,
		createdByAgentId: fixture.agentId,
		coordinatorConfig: {},
		state: {},
		status: input.missionStatus,
		expiresAt: new Date(Date.now() + 120_000),
	});
	await handle.db.insert(missionParticipants).values({
		missionId,
		agentId: fixture.agentId,
		nodeId: fixture.nodeId,
		workspaceBindingId: workspaceId,
		role: "engineer",
	});
	await handle.db.insert(missionEvents).values({
		id: eventId,
		missionId,
		sequenceNo: 1,
		type: "participants_accepted",
		actorAgentId: fixture.agentId,
		idempotencyKey: `event:${eventId}`,
		payload: {},
	});
	await handle.db.insert(nodeDeliveries).values({
		id: deliveryId,
		nodeId: fixture.nodeId,
		missionId,
		missionEventId: eventId,
		kind: "turn",
		status: input.deliveryStatus,
		attemptCount: activeLease ? 1 : 0,
		lastFencingToken: activeLease ? "1" : "0",
		activeLeaseId: leaseId,
		leaseExpiresAt,
		contractVersion: 1,
		idempotencyKey: `delivery:${deliveryId}`,
		settledByEventId: input.settled ? eventId : null,
		settledAt,
	});
	return { deliveryId, eventId, missionId, leaseId, leaseExpiresAt, settledAt };
}

interface Deferred {
	readonly promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	let resolve = () => undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitUntil(
	predicate: () => Promise<boolean>,
	message: string,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(message);
}
