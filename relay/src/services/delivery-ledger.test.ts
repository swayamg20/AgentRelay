import { randomUUID } from "node:crypto";
import type { DeliveryClaimResult, MissionCoordinatorConfig } from "@agentrelay/protocol";
import { and, asc, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	agentBlocks,
	auditLog,
	deliveryOperationReceipts,
	missionEvents,
	missions,
	nodeDeliveries,
} from "../db/schema.js";
import { type TestDb, truncateAll, tryConnect } from "../db/test-utils.js";
import { registerAgentWithInitialKey } from "./agent-registration.js";
import {
	claimDelivery,
	completeDelivery,
	listAvailableDeliveryEvents,
	listRecoverableDeliveryEvents,
	releaseDelivery,
	renewDelivery,
	startDelivery,
} from "./delivery-ledger.js";
import { acceptMissionParticipant, createMissionLedger } from "./mission-ledger.js";
import {
	type NodeCredentialContext,
	enrollNode,
	registerWorkspace,
	revokeNode,
	revokeWorkspace,
	rotateNodeCredential,
} from "./node-enrollment.js";

const KEY_PEPPER = "p".repeat(32);
const TEST_DATABASE_URL = process.env.RELAY_TEST_DATABASE_URL ?? process.env.RELAY_DATABASE_URL;
const conn = await tryConnect();
const d = conn.available ? describe : describe.skip;

if (!conn.available) {
	console.warn(`[delivery-ledger.test] skipping: ${conn.reason}`);
}

d("delivery claim and execution ledger", () => {
	let handle: TestDb;

	beforeAll(() => {
		if (!conn.handle) throw new Error("expected database handle");
		handle = conn.handle;
	});

	beforeEach(async () => {
		await truncateAll(handle.sql);
	});

	afterAll(async () => {
		if (handle) await handle.close();
	});

	it("allows only one winner when two claims race for the same delivery", async () => {
		const fixture = await createActivatedFixture(handle);
		const attempts = await Promise.allSettled([
			claimDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, {
				idempotency_key: "claim:concurrent:first",
			}),
			claimDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, {
				idempotency_key: "claim:concurrent:second",
			}),
		]);

		const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
		const rejected = attempts.filter((attempt) => attempt.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		if (fulfilled[0]?.status !== "fulfilled" || rejected[0]?.status !== "rejected") {
			throw new Error("expected exactly one fulfilled and one rejected claim");
		}
		expect(fulfilled[0].value).toMatchObject({
			outcome: "claimed",
			replayed: false,
			item: { delivery: { attempt_count: 1, status: "leased" } },
		});
		expect(rejected[0].reason).toMatchObject({ code: "state_changed" });

		const claimReceipts = await handle.db
			.select()
			.from(deliveryOperationReceipts)
			.where(
				and(
					eq(deliveryOperationReceipts.deliveryId, fixture.initialDeliveryId),
					eq(deliveryOperationReceipts.operation, "claim"),
				),
			);
		expect(claimReceipts).toHaveLength(1);
	});

	it("replays claim, start, and complete exactly while rejecting changed keyed input", async () => {
		const fixture = await createActivatedFixture(handle);
		const claimInput = { idempotency_key: "claim:exact-replay" };
		const firstClaim = requireClaimed(
			await claimDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, claimInput),
		);
		const replayedClaim = requireClaimed(
			await claimDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, {
				...claimInput,
			}),
		);
		expect(replayedClaim).toEqual({ ...firstClaim, replayed: true });

		const lease = requireLease(firstClaim);
		const startInput = {
			idempotency_key: "start:exact-replay",
			lease_id: lease.lease_id,
			fencing_token: lease.fencing_token,
		};
		const firstStart = await startDelivery(
			handle.db,
			fixture.backend.auth,
			fixture.initialDeliveryId,
			startInput,
		);
		const replayedClaimAfterStart = requireClaimed(
			await claimDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, {
				...claimInput,
			}),
		);
		expect(replayedClaimAfterStart).toEqual({ ...firstClaim, replayed: true });
		const replayedStart = await startDelivery(
			handle.db,
			fixture.backend.auth,
			fixture.initialDeliveryId,
			{ ...startInput },
		);
		expect(replayedStart).toEqual({ ...firstStart, replayed: true });
		await expect(
			startDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, {
				...startInput,
				fencing_token: "999",
			}),
		).rejects.toMatchObject({ code: "duplicate_idempotency_key" });

		const completeInput = {
			idempotency_key: "complete:exact-replay",
			lease_id: lease.lease_id,
			fencing_token: lease.fencing_token,
			result: {
				type: "turn_completed" as const,
				disposition: {
					kind: "reply" as const,
					message_type: "progress" as const,
					message: "The backend contract is ready for Android integration.",
				},
			},
		};
		const firstComplete = await completeDelivery(
			handle.db,
			fixture.backend.auth,
			fixture.initialDeliveryId,
			completeInput,
		);
		const replayedStartAfterComplete = await startDelivery(
			handle.db,
			fixture.backend.auth,
			fixture.initialDeliveryId,
			{ ...startInput },
		);
		expect(replayedStartAfterComplete).toEqual({ ...firstStart, replayed: true });
		const replayedComplete = await completeDelivery(
			handle.db,
			fixture.backend.auth,
			fixture.initialDeliveryId,
			structuredClone(completeInput),
		);
		expect(replayedComplete).toEqual({ ...firstComplete, replayed: true });
		await expect(
			completeDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, {
				...completeInput,
				result: {
					...completeInput.result,
					disposition: {
						...completeInput.result.disposition,
						message: "A different result for the same completion key.",
					},
				},
			}),
		).rejects.toMatchObject({ code: "duplicate_idempotency_key" });

		expect(firstComplete).toMatchObject({
			replayed: false,
			delivery: { status: "acknowledged" },
			receipt: { operation: "complete", status_after: "acknowledged" },
		});
		expect(firstComplete.events).toHaveLength(1);
		expect(firstComplete.derived_delivery_ids).toHaveLength(1);

		const resultEvents = await handle.db
			.select()
			.from(missionEvents)
			.where(
				and(
					eq(missionEvents.missionId, fixture.missionId),
					eq(missionEvents.sourceDeliveryId, fixture.initialDeliveryId),
					eq(missionEvents.type, "turn_completed"),
				),
			);
		expect(resultEvents).toHaveLength(1);

		const [sourceDelivery] = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(eq(nodeDeliveries.id, fixture.initialDeliveryId));
		expect(sourceDelivery).toMatchObject({
			status: "acknowledged",
			settledByEventId: firstComplete.events[0]?.event_id,
			acknowledgedAt: expect.any(Date),
		});

		const completionReceipts = await handle.db
			.select()
			.from(deliveryOperationReceipts)
			.where(
				and(
					eq(deliveryOperationReceipts.deliveryId, fixture.initialDeliveryId),
					eq(deliveryOperationReceipts.operation, "complete"),
				),
			);
		expect(completionReceipts).toHaveLength(1);

		const downstreamDeliveries = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(eq(nodeDeliveries.missionEventId, firstComplete.events[0]!.event_id));
		expect(downstreamDeliveries).toHaveLength(1);
		expect(downstreamDeliveries[0]?.id).toBe(firstComplete.derived_delivery_ids[0]);
	});

	it("renews the same lease authority from database time and rejects renewal after expiry", async () => {
		const fixture = await createActivatedFixture(handle);
		const claim = requireClaimed(
			await claimDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, {
				idempotency_key: "claim:renew",
			}),
		);
		const lease = requireLease(claim);
		const [shortened] = await handle.db
			.update(nodeDeliveries)
			.set({ leaseExpiresAt: sql`clock_timestamp() + interval '1 second'` })
			.where(eq(nodeDeliveries.id, fixture.initialDeliveryId))
			.returning({ leaseExpiresAt: nodeDeliveries.leaseExpiresAt });
		if (!shortened?.leaseExpiresAt) throw new Error("expected the shortened active lease");

		const renewed = await renewDelivery(
			handle.db,
			fixture.backend.auth,
			fixture.initialDeliveryId,
			{
				idempotency_key: "renew:active",
				lease_id: lease.lease_id,
				fencing_token: lease.fencing_token,
			},
		);
		const renewedLease = renewed.delivery.lease;
		if (!renewedLease) throw new Error("expected renewal to preserve an active lease");
		expect(renewedLease).toMatchObject({
			lease_id: lease.lease_id,
			fencing_token: lease.fencing_token,
		});
		expect(Date.parse(renewedLease.expires_at)).toBeGreaterThan(shortened.leaseExpiresAt.getTime());
		expect(Date.parse(renewedLease.expires_at) - Date.parse(renewed.receipt.recorded_at)).toBe(
			60_000,
		);
		expect(renewed.receipt.lease_expires_at).toBe(renewedLease.expires_at);

		if (!TEST_DATABASE_URL) throw new Error("expected test database URL");
		const blockerSql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => undefined });
		const lockAcquired = deferred<number>();
		const expireAndRelease = deferred<void>();
		let renewalOutcome:
			| Promise<
					| { readonly status: "fulfilled"; readonly value: unknown }
					| { readonly status: "rejected"; readonly reason: unknown }
			  >
			| undefined;
		const blocker = blockerSql.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(hashtextextended(${fixture.missionId}, 0))`;
			const [state] = await tx`
				SELECT
					pg_backend_pid()::integer AS blocker_pid,
					lease_expires_at > clock_timestamp() AS lease_valid
				FROM node_deliveries
				WHERE id = ${fixture.initialDeliveryId}
			`;
			if (!state?.lease_valid) throw new Error("expected a valid lease before the blocked renewal");
			lockAcquired.resolve(Number(state.blocker_pid));
			await expireAndRelease.promise;
			await tx`
				UPDATE node_deliveries
				SET lease_expires_at = clock_timestamp() - interval '1 second'
				WHERE id = ${fixture.initialDeliveryId}
			`;
		});

		try {
			const blockerPid = await lockAcquired.promise;
			renewalOutcome = renewDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, {
				idempotency_key: "renew:expired-after-wait",
				lease_id: lease.lease_id,
				fencing_token: lease.fencing_token,
			}).then(
				(value) => ({ status: "fulfilled" as const, value }),
				(reason: unknown) => ({ status: "rejected" as const, reason }),
			);
			await waitForBlockedBy(handle, blockerPid, "renewal did not wait on the Mission lock");
			expireAndRelease.resolve(undefined);
			await blocker;
			const outcome = await renewalOutcome;
			expect(outcome.status).toBe("rejected");
			if (outcome.status !== "rejected") throw new Error("expired renewal unexpectedly succeeded");
			expect(outcome.reason).toMatchObject({ code: "invalid_transition" });
		} finally {
			expireAndRelease.resolve(undefined);
			await blocker.catch(() => undefined);
			await renewalOutcome;
			await blockerSql.end({ timeout: 2 });
		}

		const renewReceipts = await handle.db
			.select()
			.from(deliveryOperationReceipts)
			.where(
				and(
					eq(deliveryOperationReceipts.deliveryId, fixture.initialDeliveryId),
					eq(deliveryOperationReceipts.operation, "renew"),
				),
			);
		expect(renewReceipts).toHaveLength(1);
	});

	it("continues and exactly replays an existing lease with a rotated active credential", async () => {
		const fixture = await createActivatedFixture(handle);
		const claimInput = { idempotency_key: "claim:before-rotation" };
		const claimed = requireClaimed(
			await claimDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, claimInput),
		);
		const lease = requireLease(claimed);
		const rotatedCredential = await rotateNodeCredential(
			handle.db,
			fixture.backend.agentId,
			fixture.backend.nodeId,
			{ expected_credential_id: fixture.backend.auth.credentialId },
			"test",
			KEY_PEPPER,
			{ requestId: "test:rotate-active-lease" },
		);
		const rotatedAuth: NodeCredentialContext = {
			...fixture.backend.auth,
			credentialId: rotatedCredential.id,
			requestId: "test:rotated-active-lease",
		};

		await expect(
			claimDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, claimInput),
		).rejects.toMatchObject({ code: "unauthenticated" });
		const replayedClaim = requireClaimed(
			await claimDelivery(handle.db, rotatedAuth, fixture.initialDeliveryId, { ...claimInput }),
		);
		expect(replayedClaim).toEqual({ ...claimed, replayed: true });

		const startInput = {
			idempotency_key: "start:after-rotation",
			lease_id: lease.lease_id,
			fencing_token: lease.fencing_token,
		};
		const started = await startDelivery(
			handle.db,
			rotatedAuth,
			fixture.initialDeliveryId,
			startInput,
		);
		const replayedStart = await startDelivery(handle.db, rotatedAuth, fixture.initialDeliveryId, {
			...startInput,
		});
		expect(replayedStart).toEqual({ ...started, replayed: true });

		const completed = await completeDelivery(handle.db, rotatedAuth, fixture.initialDeliveryId, {
			idempotency_key: "complete:after-rotation",
			lease_id: lease.lease_id,
			fencing_token: lease.fencing_token,
			result: {
				type: "turn_completed",
				disposition: {
					kind: "reply",
					message_type: "progress",
					message: "The rotated Node credential retained the lease.",
				},
			},
		});
		expect(completed.delivery.status).toBe("acknowledged");

		const receipts = await handle.db
			.select()
			.from(deliveryOperationReceipts)
			.where(eq(deliveryOperationReceipts.deliveryId, fixture.initialDeliveryId));
		expect(receipts.filter((receipt) => receipt.operation === "claim")).toHaveLength(1);
		expect(receipts.find((receipt) => receipt.operation === "claim")?.credentialId).toBe(
			fixture.backend.auth.credentialId,
		);
		expect(receipts.filter((receipt) => receipt.operation === "start")).toHaveLength(1);
		expect(receipts.find((receipt) => receipt.operation === "start")?.credentialId).toBe(
			rotatedCredential.id,
		);
		expect(receipts.find((receipt) => receipt.operation === "complete")?.credentialId).toBe(
			rotatedCredential.id,
		);
	});

	it("rejects exact claim and start replay after the assigned workspace is revoked", async () => {
		const fixture = await createActivatedFixture(handle);
		const claimInput = { idempotency_key: "claim:before-own-workspace-revoke" };
		const claim = requireClaimed(
			await claimDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, claimInput),
		);
		const lease = requireLease(claim);
		const startInput = {
			idempotency_key: "start:before-own-workspace-revoke",
			lease_id: lease.lease_id,
			fencing_token: lease.fencing_token,
		};
		await startDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, startInput);

		await revokeWorkspace(handle.db, fixture.backend.auth, "backend-api");

		await expect(
			claimDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, {
				...claimInput,
			}),
		).rejects.toMatchObject({ code: "not_authorized_transition" });
		await expect(
			startDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, {
				...startInput,
			}),
		).rejects.toMatchObject({ code: "not_authorized_transition" });

		const [delivery] = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(eq(nodeDeliveries.id, fixture.initialDeliveryId));
		expect(delivery).toMatchObject({
			status: "cancelled",
			cancellationReason: "workspace_revoked",
		});
	});

	it("rejects exact claim and start replay after a peer Node is revoked", async () => {
		const fixture = await createActivatedFixture(handle);
		const claimInput = { idempotency_key: "claim:before-peer-revoke" };
		const claim = requireClaimed(
			await claimDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, claimInput),
		);
		const lease = requireLease(claim);
		const startInput = {
			idempotency_key: "start:before-peer-revoke",
			lease_id: lease.lease_id,
			fencing_token: lease.fencing_token,
		};
		await startDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, startInput);

		await revokeNode(handle.db, fixture.android.agentId, fixture.android.nodeId, {
			requestId: "test:peer-node-revoke",
		});

		await expect(
			claimDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, {
				...claimInput,
			}),
		).rejects.toMatchObject({ code: "not_authorized_transition" });
		await expect(
			startDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, {
				...startInput,
			}),
		).rejects.toMatchObject({ code: "not_authorized_transition" });

		const [delivery] = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(eq(nodeDeliveries.id, fixture.initialDeliveryId));
		expect(delivery).toMatchObject({ status: "cancelled", cancellationReason: "node_revoked" });
	});

	it("fences completion that waits behind a newly committed participant block", async () => {
		if (!TEST_DATABASE_URL) throw new Error("expected test database URL");
		const fixture = await createActivatedFixture(handle);
		const execution = await claimAndStart(
			handle,
			fixture.backend,
			fixture.initialDeliveryId,
			"block-fence",
		);
		const blockerSql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => undefined });
		const lockAcquired = deferred<number>();
		const commitBlock = deferred<void>();
		let completion:
			| Promise<
					| { readonly status: "fulfilled"; readonly value: unknown }
					| { readonly status: "rejected"; readonly reason: unknown }
			  >
			| undefined;
		const blocker = blockerSql.begin(async (tx) => {
			const lockKey = `agentrelay:block:${fixture.android.agentId}:${fixture.backend.agentId}`;
			await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}::text, 0))`;
			const [connection] = await tx`SELECT pg_backend_pid()::integer AS pid`;
			lockAcquired.resolve(Number(connection?.pid));
			await commitBlock.promise;
			await tx`
				INSERT INTO agent_blocks (blocker_id, blocked_id)
				VALUES (${fixture.android.agentId}, ${fixture.backend.agentId})
			`;
		});

		try {
			const blockerPid = await lockAcquired.promise;
			completion = completeDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, {
				idempotency_key: "complete:block-fence",
				lease_id: execution.lease.lease_id,
				fencing_token: execution.lease.fencing_token,
				result: {
					type: "turn_completed",
					disposition: {
						kind: "reply",
						message_type: "progress",
						message: "This result must remain behind the block fence.",
					},
				},
			}).then(
				(value) => ({ status: "fulfilled" as const, value }),
				(reason: unknown) => ({ status: "rejected" as const, reason }),
			);
			await waitForBlockedBy(handle, blockerPid, "completion did not wait on the block fence");
			commitBlock.resolve(undefined);
			await blocker;
			const outcome = await completion;
			expect(outcome.status).toBe("rejected");
			if (outcome.status !== "rejected")
				throw new Error("blocked completion unexpectedly succeeded");
			expect(outcome.reason).toMatchObject({ code: "teammate_blocked" });
		} finally {
			commitBlock.resolve(undefined);
			await blocker.catch(() => undefined);
			await completion;
			await blockerSql.end({ timeout: 2 });
		}

		const resultEvents = await handle.db
			.select()
			.from(missionEvents)
			.where(eq(missionEvents.sourceDeliveryId, fixture.initialDeliveryId));
		expect(resultEvents).toEqual([]);
		const [delivery] = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(eq(nodeDeliveries.id, fixture.initialDeliveryId));
		expect(delivery).toMatchObject({ status: "executing", settledByEventId: null });
		await expect(
			startDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, {
				idempotency_key: "start:block-fence",
				lease_id: execution.lease.lease_id,
				fencing_token: execution.lease.fencing_token,
			}),
		).rejects.toMatchObject({ code: "teammate_blocked" });
		const completionReceipts = await handle.db
			.select()
			.from(deliveryOperationReceipts)
			.where(
				and(
					eq(deliveryOperationReceipts.deliveryId, fixture.initialDeliveryId),
					eq(deliveryOperationReceipts.operation, "complete"),
				),
			);
		expect(completionReceipts).toEqual([]);
	});

	it("replays terminal completion and release receipts as history after a later block", async () => {
		const completedFixture = await createActivatedFixture(handle);
		const completedExecution = await claimAndStart(
			handle,
			completedFixture.backend,
			completedFixture.initialDeliveryId,
			"terminal-replay",
		);
		const completeInput = {
			idempotency_key: "complete:terminal-replay",
			lease_id: completedExecution.lease.lease_id,
			fencing_token: completedExecution.lease.fencing_token,
			result: {
				type: "turn_completed" as const,
				disposition: { kind: "ready" as const, evidence: [] },
			},
		};
		const completed = await completeDelivery(
			handle.db,
			completedFixture.backend.auth,
			completedFixture.initialDeliveryId,
			completeInput,
		);
		await handle.db.insert(agentBlocks).values({
			blockerId: completedFixture.android.agentId,
			blockedId: completedFixture.backend.agentId,
		});
		const replayedCompletion = await completeDelivery(
			handle.db,
			completedFixture.backend.auth,
			completedFixture.initialDeliveryId,
			{ ...completeInput },
		);
		expect(replayedCompletion).toEqual({ ...completed, replayed: true });

		const releasedFixture = await createActivatedFixture(handle);
		const releasedExecution = await claimAndStart(
			handle,
			releasedFixture.backend,
			releasedFixture.initialDeliveryId,
			"terminal-release-replay",
		);
		const releaseInput = {
			idempotency_key: "release:terminal-replay",
			lease_id: releasedExecution.lease.lease_id,
			fencing_token: releasedExecution.lease.fencing_token,
			classification: "permanent" as const,
			summary: "This historical terminal release remains replayable.",
		};
		const released = await releaseDelivery(
			handle.db,
			releasedFixture.backend.auth,
			releasedFixture.initialDeliveryId,
			releaseInput,
		);
		await handle.db.insert(agentBlocks).values({
			blockerId: releasedFixture.android.agentId,
			blockedId: releasedFixture.backend.agentId,
		});
		const replayedRelease = await releaseDelivery(
			handle.db,
			releasedFixture.backend.auth,
			releasedFixture.initialDeliveryId,
			{ ...releaseInput },
		);
		expect(replayedRelease).toEqual({ ...released, replayed: true });
	});

	it("rejects completion when database time has passed its lease deadline", async () => {
		const fixture = await createActivatedFixture(handle);
		const execution = await claimAndStart(
			handle,
			fixture.backend,
			fixture.initialDeliveryId,
			"complete-after-expiry",
		);
		await expireActiveLease(handle, fixture.initialDeliveryId);

		await expect(
			completeDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, {
				idempotency_key: "complete:after-expiry",
				lease_id: execution.lease.lease_id,
				fencing_token: execution.lease.fencing_token,
				result: {
					type: "turn_completed",
					disposition: { kind: "ready", evidence: [] },
				},
			}),
		).rejects.toMatchObject({ code: "invalid_transition" });

		const resultEvents = await handle.db
			.select()
			.from(missionEvents)
			.where(eq(missionEvents.sourceDeliveryId, fixture.initialDeliveryId));
		expect(resultEvents).toEqual([]);
		const [delivery] = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(eq(nodeDeliveries.id, fixture.initialDeliveryId));
		expect(delivery).toMatchObject({
			status: "executing",
			settledByEventId: null,
			acknowledgedAt: null,
		});
		const completionReceipts = await handle.db
			.select()
			.from(deliveryOperationReceipts)
			.where(
				and(
					eq(deliveryOperationReceipts.deliveryId, fixture.initialDeliveryId),
					eq(deliveryOperationReceipts.operation, "complete"),
				),
			);
		expect(completionReceipts).toEqual([]);
	});

	it("hides stored work after its Mission expires", async () => {
		const fixture = await createActivatedFixture(handle);
		await handle.db
			.update(missions)
			.set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
			.where(eq(missions.id, fixture.missionId));

		const page = await listAvailableDeliveryEvents(handle.db, {
			nodeId: fixture.backend.nodeId,
			page: { after_cursor: null, limit: 50 },
		});
		expect(page.items).toEqual([]);
	});

	it("does not let an expired Mission starve later recoverable work", async () => {
		const fixture = await createActivatedFixture(handle);
		await claimDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, {
			idempotency_key: "claim:expired-mission",
		});
		await handle.db
			.update(missions)
			.set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
			.where(eq(missions.id, fixture.missionId));

		const validMissionId = randomUUID();
		const validConfig = structuredClone(fixture.config);
		validConfig.mission_context.manifest.mission_id = validMissionId;
		validConfig.mission_context.manifest.expires_at = new Date(
			(await databaseNow(handle)).getTime() + 3_600_000,
		).toISOString();
		await createMissionLedger(handle.db, {
			createdByAgentId: fixture.backend.agentId,
			coordinatorConfig: validConfig,
		});
		await acceptMissionParticipant(handle.db, {
			missionId: validMissionId,
			participantAgentId: fixture.backend.agentId,
			nodeAuth: fixture.backend.auth,
			acceptance: participantAcceptance(fixture.contract, `accept:backend:${validMissionId}`, "d"),
		});
		await acceptMissionParticipant(handle.db, {
			missionId: validMissionId,
			participantAgentId: fixture.android.agentId,
			nodeAuth: fixture.android.auth,
			acceptance: participantAcceptance(fixture.contract, `accept:android:${validMissionId}`, "e"),
		});
		const validDelivery = await onlyAvailableDelivery(handle, fixture.backend.nodeId, "turn");
		await claimDelivery(handle.db, fixture.backend.auth, validDelivery.delivery_id, {
			idempotency_key: "claim:valid-recovery",
		});

		const recovery = await listRecoverableDeliveryEvents(handle.db, {
			nodeId: fixture.backend.nodeId,
			page: { limit: 1 },
		});
		expect(recovery.items.map((item) => item.delivery.delivery_id)).toEqual([
			validDelivery.delivery_id,
		]);
	});

	it("rejects an old lease fence after expiry and reclaim", async () => {
		const fixture = await createActivatedFixture(handle);
		const firstClaim = requireClaimed(
			await claimDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, {
				idempotency_key: "claim:stale:first",
			}),
		);
		const firstLease = requireLease(firstClaim);
		await expireActiveLease(handle, fixture.initialDeliveryId);

		const secondClaim = requireClaimed(
			await claimDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, {
				idempotency_key: "claim:stale:second",
			}),
		);
		const secondLease = requireLease(secondClaim);
		expect(secondClaim.item.delivery.attempt_count).toBe(2);
		expect(secondLease.fencing_token).toBe("2");
		expect(secondLease.lease_id).not.toBe(firstLease.lease_id);

		await expect(
			startDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, {
				idempotency_key: "start:stale:first-fence",
				lease_id: firstLease.lease_id,
				fencing_token: firstLease.fencing_token,
			}),
		).rejects.toMatchObject({ code: "state_changed" });

		const receipts = await handle.db
			.select()
			.from(deliveryOperationReceipts)
			.where(eq(deliveryOperationReceipts.deliveryId, fixture.initialDeliveryId));
		expect(receipts).toHaveLength(3);
		expect(receipts.filter((receipt) => receipt.operation === "claim")).toHaveLength(2);
		expect(receipts.filter((receipt) => receipt.operation === "lease_expired")).toHaveLength(1);
		const leaseExpiryAudits = await handle.db
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.action, "delivery.lease_expired"),
					eq(auditLog.resourceId, fixture.initialDeliveryId),
				),
			);
		expect(leaseExpiryAudits).toHaveLength(1);
		expect(leaseExpiryAudits[0]).toMatchObject({
			actorId: fixture.backend.agentId,
			resourceType: "node_delivery",
			metadata: {
				origin: "relay",
				node_id: fixture.backend.nodeId,
				mission_id: fixture.missionId,
				attempt_count: 1,
				lease_id: firstLease.lease_id,
				fencing_token: firstLease.fencing_token,
				status_before: "leased",
				status_after: "stored",
			},
		});
	});

	it("recovers a due transient release without rewinding the normal cursor", async () => {
		const fixture = await createActivatedFixture(handle);
		const firstPage = await listAvailableDeliveryEvents(handle.db, {
			nodeId: fixture.backend.nodeId,
			page: { after_cursor: null, limit: 50 },
		});
		const initial = firstPage.items[0];
		if (!initial) throw new Error("expected the activation delivery");
		const claim = requireClaimed(
			await claimDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, {
				idempotency_key: "claim:transient-release",
			}),
		);
		const lease = requireLease(claim);

		const released = await releaseDelivery(
			handle.db,
			fixture.backend.auth,
			fixture.initialDeliveryId,
			{
				idempotency_key: "release:transient",
				lease_id: lease.lease_id,
				fencing_token: lease.fencing_token,
				classification: "transient",
				summary: "The local executor is temporarily unavailable.",
			},
		);
		expect(released.delivery).toMatchObject({ status: "stored", attempt_count: 1 });

		const [deliveryRow] = await handle.db
			.select({ createdAt: nodeDeliveries.createdAt })
			.from(nodeDeliveries)
			.where(eq(nodeDeliveries.id, fixture.initialDeliveryId));
		if (!deliveryRow) throw new Error("expected released delivery row");
		await handle.db
			.update(nodeDeliveries)
			.set({ availableAt: deliveryRow.createdAt })
			.where(eq(nodeDeliveries.id, fixture.initialDeliveryId));

		const normalPoll = await listAvailableDeliveryEvents(handle.db, {
			nodeId: fixture.backend.nodeId,
			page: { after_cursor: initial.delivery.cursor, limit: 50 },
		});
		expect(normalPoll.items).toEqual([]);
		expect(normalPoll.next_cursor).toBe(initial.delivery.cursor);

		const recoveryPoll = await listRecoverableDeliveryEvents(handle.db, {
			nodeId: fixture.backend.nodeId,
			page: { limit: 50 },
		});
		expect(recoveryPoll.items).toHaveLength(1);
		expect(recoveryPoll.items[0]?.delivery).toMatchObject({
			delivery_id: fixture.initialDeliveryId,
			status: "stored",
			attempt_count: 1,
		});
	});

	it("dead-letters the final expired claim instead of issuing another lease", async () => {
		const fixture = await createActivatedFixture(handle);
		const firstClaim = requireClaimed(
			await claimDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, {
				idempotency_key: "claim:final:first",
			}),
		);
		expect(firstClaim.item.delivery.attempt_count).toBe(1);
		await handle.db
			.update(nodeDeliveries)
			.set({
				maxAttempts: 1,
				leaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
			})
			.where(eq(nodeDeliveries.id, fixture.initialDeliveryId));

		const finalClaim = await claimDelivery(
			handle.db,
			fixture.backend.auth,
			fixture.initialDeliveryId,
			{ idempotency_key: "claim:final:recovery" },
		);
		expect(finalClaim).toMatchObject({
			outcome: "dead_lettered",
			replayed: false,
			delivery: {
				status: "dead_lettered",
				attempt_count: 1,
				max_attempts: 1,
				lease: null,
				dead_lettered_at: expect.any(String),
			},
			receipt: {
				operation: "claim",
				claim_outcome: "dead_lettered",
				status_before: "leased",
				status_after: "dead_lettered",
				lease: null,
			},
		});

		const receipts = await handle.db
			.select()
			.from(deliveryOperationReceipts)
			.where(eq(deliveryOperationReceipts.deliveryId, fixture.initialDeliveryId));
		expect(receipts.filter((receipt) => receipt.operation === "claim")).toHaveLength(2);
		expect(receipts.filter((receipt) => receipt.operation === "lease_expired")).toHaveLength(0);
		const recoveryPoll = await listRecoverableDeliveryEvents(handle.db, {
			nodeId: fixture.backend.nodeId,
			page: { limit: 50 },
		});
		expect(recoveryPoll.items).toEqual([]);
	});

	it("publishes a multi-command verification batch in configured order", async () => {
		const fixture = await createActivatedFixture(handle, {
			backendCommands: ["backend-types", "backend-tests"],
		});
		await completeReadyTurn(handle, fixture.backend, fixture.initialDeliveryId, "backend-ready");
		const androidTurn = await onlyAvailableDelivery(handle, fixture.android.nodeId, "turn");
		await completeReadyTurn(handle, fixture.android, androidTurn.delivery_id, "android-ready");

		const verification = await onlyAvailableDelivery(
			handle,
			fixture.backend.nodeId,
			"verification",
		);
		const execution = await claimAndStart(
			handle,
			fixture.backend,
			verification.delivery_id,
			"backend-verification",
		);
		const recordedAt = (await databaseNow(handle)).toISOString();
		const evidence = ["backend-tests", "backend-types"].map((commandId) => ({
			verification_id: randomUUID(),
			command_id: commandId,
			outcome: "passed" as const,
			exit_code: 0,
			duration_ms: 25,
			summary: `${commandId} passed`,
			output_sha256: "b".repeat(64),
			artifacts: [],
			recorded_at: recordedAt,
		}));
		const completed = await completeDelivery(
			handle.db,
			fixture.backend.auth,
			verification.delivery_id,
			{
				idempotency_key: "complete:backend-verification",
				lease_id: execution.lease.lease_id,
				fencing_token: execution.lease.fencing_token,
				result: { type: "verification_recorded", evidence },
			},
		);

		expect(completed.delivery.status).toBe("acknowledged");
		expect(completed.events).toHaveLength(2);
		expect(
			completed.events.map((event) =>
				event.type === "verification_recorded" ? event.evidence.command_id : event.type,
			),
		).toEqual(["backend-types", "backend-tests"]);
		expect(completed.events[1]!.sequence_no).toBe(completed.events[0]!.sequence_no + 1);

		const eventRows = await handle.db
			.select()
			.from(missionEvents)
			.where(eq(missionEvents.sourceDeliveryId, verification.delivery_id))
			.orderBy(asc(missionEvents.sequenceNo));
		expect(eventRows).toHaveLength(2);
		const [mission] = await handle.db
			.select()
			.from(missions)
			.where(eq(missions.id, fixture.missionId));
		expect(mission?.status).toBe("verifying");
	});

	it("cancels logically superseded sibling deliveries after a failed verification batch", async () => {
		const fixture = await createActivatedFixture(handle, {
			backendCommands: ["backend-types", "backend-tests"],
		});
		await completeReadyTurn(handle, fixture.backend, fixture.initialDeliveryId, "failure-ready");
		const androidTurn = await onlyAvailableDelivery(handle, fixture.android.nodeId, "turn");
		await completeReadyTurn(
			handle,
			fixture.android,
			androidTurn.delivery_id,
			"failure-android-ready",
		);

		const backendVerification = await onlyAvailableDelivery(
			handle,
			fixture.backend.nodeId,
			"verification",
		);
		const androidVerification = await onlyAvailableDelivery(
			handle,
			fixture.android.nodeId,
			"verification",
		);
		const backendExecution = await claimAndStart(
			handle,
			fixture.backend,
			backendVerification.delivery_id,
			"failed-backend-verification",
		);
		const androidExecution = await claimAndStart(
			handle,
			fixture.android,
			androidVerification.delivery_id,
			"superseded-android-verification",
		);
		const recordedAt = (await databaseNow(handle)).toISOString();
		const completed = await completeDelivery(
			handle.db,
			fixture.backend.auth,
			backendVerification.delivery_id,
			{
				idempotency_key: "complete:failed-backend-verification",
				lease_id: backendExecution.lease.lease_id,
				fencing_token: backendExecution.lease.fencing_token,
				result: {
					type: "verification_recorded",
					evidence: [
						verificationEvidence("backend-tests", "passed", recordedAt),
						verificationEvidence("backend-types", "failed", recordedAt),
					],
				},
			},
		);
		const settlementEvent = completed.events.at(-1);
		if (!settlementEvent) throw new Error("expected the failed verification settlement event");
		expect(completed.delivery).toMatchObject({
			status: "acknowledged",
			logical_settlement: { settled_by_event_id: settlementEvent.event_id },
		});
		expect(
			completed.events.map((event) =>
				event.type === "verification_recorded"
					? [event.evidence.command_id, event.evidence.outcome]
					: [event.type, null],
			),
		).toEqual([
			["backend-types", "failed"],
			["backend-tests", "passed"],
		]);

		const [cancelledSibling] = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(eq(nodeDeliveries.id, androidVerification.delivery_id));
		expect(cancelledSibling).toMatchObject({
			status: "cancelled",
			activeLeaseId: null,
			leaseExpiresAt: null,
			settledByEventId: settlementEvent.event_id,
			cancellationReason: "work_superseded",
			cancelledAt: expect.any(Date),
		});
		const [cancelReceipt] = await handle.db
			.select()
			.from(deliveryOperationReceipts)
			.where(
				and(
					eq(deliveryOperationReceipts.deliveryId, androidVerification.delivery_id),
					eq(deliveryOperationReceipts.operation, "cancel"),
				),
			);
		expect(cancelReceipt).toMatchObject({
			origin: "relay",
			statusBefore: "executing",
			statusAfter: "cancelled",
			leaseId: androidExecution.lease.lease_id,
			fencingToken: androidExecution.lease.fencing_token,
			cancellationReason: "work_superseded",
		});

		const [mission] = await handle.db
			.select()
			.from(missions)
			.where(eq(missions.id, fixture.missionId));
		expect(mission).toMatchObject({ status: "active" });
		expect(completed.derived_delivery_ids).toHaveLength(1);
		const [retryTurn] = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(eq(nodeDeliveries.id, completed.derived_delivery_ids[0]!));
		expect(retryTurn).toMatchObject({
			nodeId: fixture.backend.nodeId,
			kind: "turn",
			status: "stored",
		});
	});
});

interface ParticipantFixture {
	readonly agentId: string;
	readonly nodeId: string;
	readonly auth: NodeCredentialContext;
}

interface DeliveryFixture {
	readonly missionId: string;
	readonly config: MissionCoordinatorConfig;
	readonly contract: MissionCoordinatorConfig["mission_context"]["manifest"]["shared_contract"];
	readonly backend: ParticipantFixture;
	readonly android: ParticipantFixture;
	readonly initialDeliveryId: string;
}

async function createActivatedFixture(
	handle: TestDb,
	options: { readonly backendCommands?: readonly string[] } = {},
): Promise<DeliveryFixture> {
	const backend = await registerParticipant(handle, {
		role: "backend",
		nodeName: "backend-mac",
		workspaceAlias: "backend-api",
		repositoryUrl: "https://github.com/acme/backend.git",
	});
	const android = await registerParticipant(handle, {
		role: "android",
		nodeName: "android-mac",
		workspaceAlias: "android-app",
		repositoryUrl: "https://github.com/acme/android.git",
	});
	const now = await databaseNow(handle);
	const missionId = randomUUID();
	const contract: DeliveryFixture["contract"] = {
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
				objective: "Ship one compatible profile contract across backend and Android",
				public_acceptance_criteria: ["Both repository checks pass"],
				participants: [
					{
						agent_id: backend.agentId,
						role: "backend",
						workspace_alias: "backend-api",
						repository_url: "https://github.com/acme/backend.git",
						expected_base_commit: "1".repeat(40),
						initial_assignment: "Implement the response contract",
						requested_local_policy_profile: "bounded-code",
					},
					{
						agent_id: android.agentId,
						role: "android",
						workspace_alias: "android-app",
						repository_url: "https://github.com/acme/android.git",
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
			[backend.agentId]: [...(options.backendCommands ?? ["backend-test"])],
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
		nodeAuth: backend.auth,
		acceptance: participantAcceptance(contract, "accept:backend", "d"),
	});
	await acceptMissionParticipant(handle.db, {
		missionId,
		participantAgentId: android.agentId,
		nodeAuth: android.auth,
		acceptance: participantAcceptance(contract, "accept:android", "e"),
	});

	const initial = await onlyAvailableDelivery(handle, backend.nodeId, "turn");
	return {
		missionId,
		config,
		contract,
		backend,
		android,
		initialDeliveryId: initial.delivery_id,
	};
}

async function registerParticipant(
	handle: TestDb,
	input: {
		readonly role: "backend" | "android";
		readonly nodeName: string;
		readonly workspaceAlias: string;
		readonly repositoryUrl: string;
	},
): Promise<ParticipantFixture> {
	const suffix = randomUUID();
	const registration = await registerAgentWithInitialKey(handle.db, {
		handle: `${input.role}-${suffix}@agentrelay.test`,
		email: `${input.role}-${suffix}@agentrelay.test`,
		displayName: input.role === "backend" ? "Backend" : "Android",
		role: input.role,
		pepper: KEY_PEPPER,
		keyEnvironment: "test",
	});
	const enrollment = await enrollNode(
		handle.db,
		registration.agent.id,
		{ name: input.nodeName, capabilities: ["missions.execute"] },
		"test",
		KEY_PEPPER,
	);
	const auth: NodeCredentialContext = {
		nodeId: enrollment.node.node_id,
		agentId: registration.agent.id,
		credentialId: enrollment.credential.id,
		requestId: `test:${suffix}`,
	};
	await registerWorkspace(handle.db, auth, {
		alias: input.workspaceAlias,
		repository_url: input.repositoryUrl,
		allowed_base_refs: ["refs/heads/main"],
	});
	return { agentId: registration.agent.id, nodeId: enrollment.node.node_id, auth };
}

function participantAcceptance(
	contract: DeliveryFixture["contract"],
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

function verificationEvidence(commandId: string, outcome: "passed" | "failed", recordedAt: string) {
	return {
		verification_id: randomUUID(),
		command_id: commandId,
		outcome,
		exit_code: outcome === "passed" ? 0 : 1,
		duration_ms: 25,
		summary: `${commandId} ${outcome}`,
		output_sha256: "c".repeat(64),
		artifacts: [],
		recorded_at: recordedAt,
	};
}

function requireClaimed(result: DeliveryClaimResult) {
	if (result.outcome !== "claimed") throw new Error("expected a claimed delivery");
	return result;
}

function requireLease(result: ReturnType<typeof requireClaimed>) {
	const lease = result.item.delivery.lease;
	if (!lease) throw new Error("expected an active delivery lease");
	return lease;
}

async function expireActiveLease(handle: TestDb, deliveryId: string): Promise<void> {
	await handle.db
		.update(nodeDeliveries)
		.set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
		.where(eq(nodeDeliveries.id, deliveryId));
}

async function databaseNow(handle: TestDb): Promise<Date> {
	const [row] = await handle.sql<Array<{ now: string | Date }>>`SELECT clock_timestamp() AS now`;
	if (!row) throw new Error("expected the database clock");
	return new Date(row.now);
}

function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
} {
	let resolve = (_value: T): void => undefined;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitForBlockedBy(
	handle: TestDb,
	blockerPid: number,
	message: string,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const [row] = await handle.sql<Array<{ waiters: string }>>`
			SELECT count(*)::text AS waiters
			FROM pg_stat_activity
			WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
		`;
		if (Number(row?.waiters ?? "0") > 0) return;
	}
	throw new Error(message);
}

async function onlyAvailableDelivery(
	handle: TestDb,
	nodeId: string,
	kind: "turn" | "verification",
) {
	const page = await listAvailableDeliveryEvents(handle.db, {
		nodeId,
		page: { after_cursor: null, limit: 50 },
	});
	const matching = page.items.filter((item) => item.delivery.kind === kind);
	if (matching.length !== 1) {
		throw new Error(`expected exactly one available ${kind} delivery, got ${matching.length}`);
	}
	return matching[0]!.delivery;
}

async function claimAndStart(
	handle: TestDb,
	participant: ParticipantFixture,
	deliveryId: string,
	keySuffix: string,
) {
	const claim = requireClaimed(
		await claimDelivery(handle.db, participant.auth, deliveryId, {
			idempotency_key: `claim:${keySuffix}`,
		}),
	);
	const lease = requireLease(claim);
	const start = await startDelivery(handle.db, participant.auth, deliveryId, {
		idempotency_key: `start:${keySuffix}`,
		lease_id: lease.lease_id,
		fencing_token: lease.fencing_token,
	});
	return { claim, lease, start };
}

async function completeReadyTurn(
	handle: TestDb,
	participant: ParticipantFixture,
	deliveryId: string,
	keySuffix: string,
) {
	const execution = await claimAndStart(handle, participant, deliveryId, keySuffix);
	return completeDelivery(handle.db, participant.auth, deliveryId, {
		idempotency_key: `complete:${keySuffix}`,
		lease_id: execution.lease.lease_id,
		fencing_token: execution.lease.fencing_token,
		result: {
			type: "turn_completed",
			disposition: { kind: "ready", evidence: [] },
		},
	});
}
