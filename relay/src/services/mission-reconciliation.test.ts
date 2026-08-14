import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	auditLog,
	deliveryOperationReceipts,
	missionEvents,
	missions,
	nodeDeliveries,
	workspaceBindings,
} from "../db/schema.js";
import { type TestDb, truncateAll, tryConnect } from "../db/test-utils.js";
import {
	claimDelivery,
	completeDelivery,
	listAvailableDeliveryEvents,
	releaseDelivery,
} from "./delivery-ledger.js";
import {
	claimAndStart,
	completeReadyTurn,
	createActivatedFixture,
	databaseNow,
	deferred,
	onlyAvailableDelivery,
	verificationEvidence,
	waitForBlockedBy,
} from "./delivery-ledger.test-support.js";
import { reconcileMission } from "./mission-reconciliation.js";

const TEST_DATABASE_URL = process.env.RELAY_TEST_DATABASE_URL ?? process.env.RELAY_DATABASE_URL;
const conn = await tryConnect();
const d = conn.available ? describe : describe.skip;

if (!conn.available) {
	console.warn(`[mission-reconciliation.test] skipping: ${conn.reason}`);
}

d("Mission terminal reconciliation", () => {
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

	it("lazily expires an active Mission and atomically cancels stored work", async () => {
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

		const [mission] = await handle.db
			.select()
			.from(missions)
			.where(eq(missions.id, fixture.missionId));
		expect(mission).toMatchObject({ status: "expired" });
		expect(mission?.state).toMatchObject({ status: "expired", sequence_no: 2 });

		const terminalEvents = await handle.db
			.select()
			.from(missionEvents)
			.where(
				and(
					eq(missionEvents.missionId, fixture.missionId),
					eq(missionEvents.type, "mission_terminal"),
				),
			);
		expect(terminalEvents).toHaveLength(1);
		const terminalEvent = terminalEvents[0]!;
		expect(terminalEvent).toMatchObject({
			sequenceNo: 2,
			actorKind: "system",
			actorAgentId: null,
			sourceDeliveryId: null,
			payload: {
				terminal_status: "expired",
				reason: "deadline_exceeded",
				triggering_delivery_id: null,
			},
		});

		const [delivery] = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(eq(nodeDeliveries.id, fixture.initialDeliveryId));
		expect(delivery).toMatchObject({
			status: "cancelled",
			activeLeaseId: null,
			leaseExpiresAt: null,
			settledByEventId: terminalEvent.id,
			cancellationReason: "mission_expired",
			cancelledAt: expect.any(Date),
		});

		const cancelReceipts = await handle.db
			.select()
			.from(deliveryOperationReceipts)
			.where(
				and(
					eq(deliveryOperationReceipts.deliveryId, fixture.initialDeliveryId),
					eq(deliveryOperationReceipts.operation, "cancel"),
				),
			);
		expect(cancelReceipts).toHaveLength(1);
		expect(cancelReceipts[0]).toMatchObject({
			origin: "relay",
			statusBefore: "stored",
			statusAfter: "cancelled",
			cancellationReason: "mission_expired",
			input: {
				reason: "mission_expired",
				settled_by_event_id: terminalEvent.id,
			},
			output: {
				delivery: {
					status: "cancelled",
					logical_settlement: { settled_by_event_id: terminalEvent.id },
				},
			},
		});
		const terminalAudits = await handle.db
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.actorKind, "system"),
					eq(auditLog.action, "mission.terminal"),
					eq(auditLog.resourceId, terminalEvent.id),
				),
			);
		expect(terminalAudits).toHaveLength(1);
		expect(terminalAudits[0]?.metadata).toMatchObject({
			mission_id: fixture.missionId,
			status: "expired",
			reason: "deadline_exceeded",
			triggering_delivery_id: null,
			cancelled_delivery_ids: [fixture.initialDeliveryId],
		});
	});

	it("repeated Mission reconciliation is an exact no-op", async () => {
		const fixture = await createActivatedFixture(handle);
		await handle.db
			.update(missions)
			.set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
			.where(eq(missions.id, fixture.missionId));

		const first = await reconcileMission(handle.db, fixture.missionId);
		const second = await reconcileMission(handle.db, fixture.missionId);
		expect(first).toMatchObject({
			missionId: fixture.missionId,
			reconciled: true,
			status: "expired",
			event: { type: "mission_terminal", terminal_status: "expired" },
		});
		expect(second).toMatchObject({
			missionId: fixture.missionId,
			reconciled: false,
			status: "expired",
			event: null,
		});

		const terminalEvents = await handle.db
			.select()
			.from(missionEvents)
			.where(
				and(
					eq(missionEvents.missionId, fixture.missionId),
					eq(missionEvents.type, "mission_terminal"),
				),
			);
		const cancelReceipts = await handle.db
			.select()
			.from(deliveryOperationReceipts)
			.where(
				and(
					eq(deliveryOperationReceipts.deliveryId, fixture.initialDeliveryId),
					eq(deliveryOperationReceipts.operation, "cancel"),
				),
			);
		const terminalAudits = await handle.db
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.action, "mission.terminal"),
					eq(auditLog.resourceId, first.event!.event_id),
				),
			);
		expect(terminalEvents).toHaveLength(1);
		expect(cancelReceipts).toHaveLength(1);
		expect(terminalAudits).toHaveLength(1);
	});

	it("commits expiry reconciliation before rejecting late completion", async () => {
		if (!TEST_DATABASE_URL) throw new Error("expected test database URL");
		const fixture = await createActivatedFixture(handle);
		const execution = await claimAndStart(
			handle,
			fixture.backend,
			fixture.initialDeliveryId,
			"expiry-race",
		);
		const blockerSql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => undefined });
		const lockAcquired = deferred<number>();
		const expireAndRelease = deferred<void>();
		let completion:
			| Promise<
					| { readonly status: "fulfilled"; readonly value: unknown }
					| { readonly status: "rejected"; readonly reason: unknown }
			  >
			| undefined;
		let reconciliation: ReturnType<typeof reconcileMission> | undefined;
		const observerSql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => undefined });
		const blocker = blockerSql.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(hashtextextended(${fixture.missionId}, 0))`;
			const [connection] = await tx`SELECT pg_backend_pid()::integer AS pid`;
			lockAcquired.resolve(Number(connection?.pid));
			await expireAndRelease.promise;
			await tx`
				UPDATE missions
				SET expires_at = clock_timestamp() - interval '1 second'
				WHERE id = ${fixture.missionId}
			`;
		});

		try {
			const blockerPid = await lockAcquired.promise;
			completion = completeDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, {
				idempotency_key: "complete:expiry-race",
				lease_id: execution.lease.lease_id,
				fencing_token: execution.lease.fencing_token,
				result: {
					type: "turn_completed",
					disposition: { kind: "ready", evidence: [] },
				},
			}).then(
				(value) => ({ status: "fulfilled" as const, value }),
				(reason: unknown) => ({ status: "rejected" as const, reason }),
			);
			reconciliation = reconcileMission(handle.db, fixture.missionId);
			await waitForBlockedBy(
				observerSql,
				blockerPid,
				"completion and reconciliation did not both wait on the Mission lock",
				2,
			);
			expireAndRelease.resolve(undefined);
			await blocker;
			const [outcome, reconciliationResult] = await Promise.all([completion, reconciliation]);
			expect(outcome.status).toBe("rejected");
			if (outcome.status !== "rejected") throw new Error("late completion unexpectedly succeeded");
			expect(outcome.reason).toMatchObject({ code: "invalid_transition" });
			expect(reconciliationResult).toMatchObject({
				missionId: fixture.missionId,
				status: "expired",
			});
		} finally {
			expireAndRelease.resolve(undefined);
			await blocker.catch(() => undefined);
			await completion;
			await reconciliation;
			await blockerSql.end({ timeout: 2 });
			await observerSql.end({ timeout: 2 });
		}

		const [mission] = await handle.db
			.select()
			.from(missions)
			.where(eq(missions.id, fixture.missionId));
		const [delivery] = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(eq(nodeDeliveries.id, fixture.initialDeliveryId));
		expect(mission).toMatchObject({ status: "expired" });
		expect(delivery).toMatchObject({
			status: "cancelled",
			activeLeaseId: null,
			leaseExpiresAt: null,
			cancellationReason: "mission_expired",
		});
		const [cancelReceipt] = await handle.db
			.select()
			.from(deliveryOperationReceipts)
			.where(
				and(
					eq(deliveryOperationReceipts.deliveryId, fixture.initialDeliveryId),
					eq(deliveryOperationReceipts.operation, "cancel"),
				),
			);
		expect(cancelReceipt).toMatchObject({
			origin: "relay",
			statusBefore: "executing",
			leaseId: execution.lease.lease_id,
			fencingToken: execution.lease.fencing_token,
			cancellationReason: "mission_expired",
		});
		const completionEvents = await handle.db
			.select()
			.from(missionEvents)
			.where(eq(missionEvents.sourceDeliveryId, fixture.initialDeliveryId));
		const completionReceipts = await handle.db
			.select()
			.from(deliveryOperationReceipts)
			.where(
				and(
					eq(deliveryOperationReceipts.deliveryId, fixture.initialDeliveryId),
					eq(deliveryOperationReceipts.operation, "complete"),
				),
			);
		expect(completionEvents).toEqual([]);
		expect(completionReceipts).toEqual([]);
	});

	it("replays a committed completion when that replay first observes Mission expiry", async () => {
		const fixture = await createActivatedFixture(handle);
		const execution = await claimAndStart(
			handle,
			fixture.backend,
			fixture.initialDeliveryId,
			"completion-before-expiry",
		);
		const completeInput = {
			idempotency_key: "complete:before-expiry",
			lease_id: execution.lease.lease_id,
			fencing_token: execution.lease.fencing_token,
			result: {
				type: "turn_completed" as const,
				disposition: {
					kind: "reply" as const,
					message_type: "progress" as const,
					message: "This exact receipt predates Mission expiry.",
				},
			},
		};
		const completed = await completeDelivery(
			handle.db,
			fixture.backend.auth,
			fixture.initialDeliveryId,
			completeInput,
		);
		await handle.db
			.update(missions)
			.set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
			.where(eq(missions.id, fixture.missionId));

		const replayed = await completeDelivery(
			handle.db,
			fixture.backend.auth,
			fixture.initialDeliveryId,
			structuredClone(completeInput),
		);
		expect(replayed).toEqual({ ...completed, replayed: true });
		const [mission] = await handle.db
			.select()
			.from(missions)
			.where(eq(missions.id, fixture.missionId));
		expect(mission).toMatchObject({ status: "expired" });
		const terminalEvents = await handle.db
			.select()
			.from(missionEvents)
			.where(
				and(
					eq(missionEvents.missionId, fixture.missionId),
					eq(missionEvents.type, "mission_terminal"),
				),
			);
		expect(terminalEvents).toHaveLength(1);
		const [source] = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(eq(nodeDeliveries.id, fixture.initialDeliveryId));
		expect(source).toMatchObject({ status: "acknowledged" });
	});

	it("commits expiry reconciliation before denying a replay with a revoked workspace route", async () => {
		const fixture = await createActivatedFixture(handle);
		const claimInput = { idempotency_key: "claim:revoked-route-expiry" };
		await claimDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, claimInput);
		await handle.db
			.update(missions)
			.set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
			.where(eq(missions.id, fixture.missionId));
		await handle.db
			.update(workspaceBindings)
			.set({ status: "revoked", revokedAt: sql`clock_timestamp()` })
			.where(
				and(
					eq(workspaceBindings.nodeId, fixture.backend.nodeId),
					eq(workspaceBindings.alias, "backend-api"),
				),
			);

		await expect(
			claimDelivery(handle.db, fixture.backend.auth, fixture.initialDeliveryId, claimInput),
		).rejects.toMatchObject({ code: "not_authorized_transition" });

		const [mission] = await handle.db
			.select()
			.from(missions)
			.where(eq(missions.id, fixture.missionId));
		const [delivery] = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(eq(nodeDeliveries.id, fixture.initialDeliveryId));
		expect(mission).toMatchObject({ status: "expired" });
		expect(delivery).toMatchObject({
			status: "cancelled",
			cancellationReason: "mission_expired",
		});
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
		const terminalEvents = await handle.db
			.select()
			.from(missionEvents)
			.where(
				and(
					eq(missionEvents.missionId, fixture.missionId),
					eq(missionEvents.type, "mission_terminal"),
				),
			);
		expect(terminalEvents).toHaveLength(1);
	});

	it("fails a verifying Mission when required work dead-letters and cancels its sibling", async () => {
		const fixture = await createActivatedFixture(handle);
		await completeReadyTurn(
			handle,
			fixture.backend,
			fixture.initialDeliveryId,
			"dead-letter-ready",
		);
		const androidTurn = await onlyAvailableDelivery(handle, fixture.android.nodeId, "turn");
		await completeReadyTurn(
			handle,
			fixture.android,
			androidTurn.delivery_id,
			"dead-letter-android-ready",
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
			"dead-letter-backend-verification",
		);
		const androidExecution = await claimAndStart(
			handle,
			fixture.android,
			androidVerification.delivery_id,
			"dead-letter-android-verification",
		);

		const released = await releaseDelivery(
			handle.db,
			fixture.backend.auth,
			backendVerification.delivery_id,
			{
				idempotency_key: "release:dead-letter-backend-verification",
				lease_id: backendExecution.lease.lease_id,
				fencing_token: backendExecution.lease.fencing_token,
				classification: "permanent",
				summary: "Required verification cannot complete.",
			},
		);
		expect(released.delivery).toMatchObject({
			status: "dead_lettered",
			logical_settlement: null,
		});

		const [mission] = await handle.db
			.select()
			.from(missions)
			.where(eq(missions.id, fixture.missionId));
		expect(mission).toMatchObject({ status: "failed" });
		expect(mission?.state).toMatchObject({ status: "failed" });
		const terminalEvents = await handle.db
			.select()
			.from(missionEvents)
			.where(
				and(
					eq(missionEvents.missionId, fixture.missionId),
					eq(missionEvents.type, "mission_terminal"),
				),
			);
		expect(terminalEvents).toHaveLength(1);
		const terminalEvent = terminalEvents[0]!;
		expect(terminalEvent).toMatchObject({
			actorKind: "system",
			actorAgentId: null,
			sourceDeliveryId: backendVerification.delivery_id,
			payload: {
				terminal_status: "failed",
				reason: "delivery_dead_lettered",
				triggering_delivery_id: backendVerification.delivery_id,
			},
		});

		const [cancelledSibling] = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(eq(nodeDeliveries.id, androidVerification.delivery_id));
		expect(cancelledSibling).toMatchObject({
			status: "cancelled",
			activeLeaseId: null,
			leaseExpiresAt: null,
			settledByEventId: terminalEvent.id,
			cancellationReason: "mission_failed",
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
			cancellationReason: "mission_failed",
			input: {
				reason: "mission_failed",
				settled_by_event_id: terminalEvent.id,
			},
		});
		const terminalAudits = await handle.db
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.actorKind, "system"),
					eq(auditLog.action, "mission.terminal"),
					eq(auditLog.resourceId, terminalEvent.id),
				),
			);
		const siblingCancelAudits = await handle.db
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.actorKind, "system"),
					eq(auditLog.action, "delivery.cancel"),
					eq(auditLog.resourceId, androidVerification.delivery_id),
				),
			);
		expect(terminalAudits).toHaveLength(1);
		expect(siblingCancelAudits).toHaveLength(1);
		expect(terminalAudits[0]?.metadata).toMatchObject({
			mission_id: fixture.missionId,
			status: "failed",
			reason: "delivery_dead_lettered",
			triggering_delivery_id: backendVerification.delivery_id,
			cancelled_delivery_ids: [androidVerification.delivery_id],
		});
	});

	it("serializes final completion against permanent release into one terminal outcome", async () => {
		const fixture = await createActivatedFixture(handle);
		await completeReadyTurn(handle, fixture.backend, fixture.initialDeliveryId, "race-ready");
		const androidTurn = await onlyAvailableDelivery(handle, fixture.android.nodeId, "turn");
		await completeReadyTurn(handle, fixture.android, androidTurn.delivery_id, "race-android-ready");
		const backendVerification = await onlyAvailableDelivery(
			handle,
			fixture.backend.nodeId,
			"verification",
		);
		const backendExecution = await claimAndStart(
			handle,
			fixture.backend,
			backendVerification.delivery_id,
			"race-backend-verification",
		);
		const recordedAt = (await databaseNow(handle)).toISOString();
		await completeDelivery(handle.db, fixture.backend.auth, backendVerification.delivery_id, {
			idempotency_key: "complete:race-backend-verification",
			lease_id: backendExecution.lease.lease_id,
			fencing_token: backendExecution.lease.fencing_token,
			result: {
				type: "verification_recorded",
				evidence: [verificationEvidence("backend-test", "passed", recordedAt)],
			},
		});

		const androidVerification = await onlyAvailableDelivery(
			handle,
			fixture.android.nodeId,
			"verification",
		);
		const androidExecution = await claimAndStart(
			handle,
			fixture.android,
			androidVerification.delivery_id,
			"race-android-verification",
		);
		const completeInput = {
			idempotency_key: "complete:race-final-verification",
			lease_id: androidExecution.lease.lease_id,
			fencing_token: androidExecution.lease.fencing_token,
			result: {
				type: "verification_recorded" as const,
				evidence: [verificationEvidence("android-test", "passed", recordedAt)],
			},
		};
		const releaseInput = {
			idempotency_key: "release:race-final-verification",
			lease_id: androidExecution.lease.lease_id,
			fencing_token: androidExecution.lease.fencing_token,
			classification: "permanent" as const,
			summary: "The final verifier cannot continue.",
		};
		const outcomes = await Promise.allSettled([
			completeDelivery(
				handle.db,
				fixture.android.auth,
				androidVerification.delivery_id,
				completeInput,
			),
			releaseDelivery(
				handle.db,
				fixture.android.auth,
				androidVerification.delivery_id,
				releaseInput,
			),
		]);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);

		const [mission] = await handle.db
			.select()
			.from(missions)
			.where(eq(missions.id, fixture.missionId));
		const [delivery] = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(eq(nodeDeliveries.id, androidVerification.delivery_id));
		const terminalEvents = await handle.db
			.select()
			.from(missionEvents)
			.where(
				and(
					eq(missionEvents.missionId, fixture.missionId),
					eq(missionEvents.type, "mission_terminal"),
				),
			);
		const finalVerificationEvents = await handle.db
			.select()
			.from(missionEvents)
			.where(eq(missionEvents.sourceDeliveryId, androidVerification.delivery_id));
		const operationReceipts = await handle.db
			.select()
			.from(deliveryOperationReceipts)
			.where(eq(deliveryOperationReceipts.deliveryId, androidVerification.delivery_id));

		if (mission?.status === "completed") {
			expect(delivery).toMatchObject({ status: "acknowledged" });
			expect(terminalEvents).toEqual([]);
			expect(
				finalVerificationEvents.filter((event) => event.type === "verification_recorded"),
			).toHaveLength(1);
			expect(operationReceipts.filter((receipt) => receipt.operation === "complete")).toHaveLength(
				1,
			);
			expect(operationReceipts.filter((receipt) => receipt.operation === "release")).toHaveLength(
				0,
			);
		} else {
			expect(mission).toMatchObject({ status: "failed" });
			expect(delivery).toMatchObject({ status: "dead_lettered" });
			expect(terminalEvents).toHaveLength(1);
			expect(
				finalVerificationEvents.filter((event) => event.type === "verification_recorded"),
			).toHaveLength(0);
			expect(operationReceipts.filter((receipt) => receipt.operation === "release")).toHaveLength(
				1,
			);
			expect(operationReceipts.filter((receipt) => receipt.operation === "complete")).toHaveLength(
				0,
			);
		}
	});
});
