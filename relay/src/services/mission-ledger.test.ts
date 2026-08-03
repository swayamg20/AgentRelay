import { randomUUID } from "node:crypto";
import type { MissionCoordinatorConfig } from "@agentrelay/protocol";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import {
	agents,
	auditLog,
	missionEvents,
	missionParticipants,
	missions,
	nodeDeliveries,
	nodes,
	workspaceBindings,
} from "../db/schema.js";
import { type TestDb, truncateAll, tryConnect } from "../db/test-utils.js";
import {
	acceptMissionParticipant,
	appendMissionEvent,
	createMissionLedger,
	listStoredDeliveryEvents,
} from "./mission-ledger.js";

const TEST_URL = process.env.RELAY_TEST_DATABASE_URL ?? process.env.RELAY_DATABASE_URL;
const conn = await tryConnect();
const d = conn.available ? describe : describe.skip;

if (!conn.available) {
	console.warn(`[mission-ledger.test] skipping: ${conn.reason}`);
}

d("durable Mission ledger", () => {
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

	it("creates an immutable Mission with exact Node/workspace routing and replays by Mission ID", async () => {
		const fixture = await seedFixture(handle);
		const first = await createMissionLedger(handle.db, {
			createdByAgentId: fixture.backendAgentId,
			coordinatorConfig: fixture.config,
		});
		expect(first.replayed).toBe(false);
		expect(first.state.status).toBe("awaiting_acceptance");
		expect(first.participantBindings).toEqual([
			{
				agentId: fixture.backendAgentId,
				nodeId: fixture.backendNodeId,
				workspaceBindingId: fixture.backendBindingId,
			},
			{
				agentId: fixture.androidAgentId,
				nodeId: fixture.androidNodeId,
				workspaceBindingId: fixture.androidBindingId,
			},
		]);

		const replay = await createMissionLedger(handle.db, {
			createdByAgentId: fixture.backendAgentId,
			coordinatorConfig: structuredClone(fixture.config),
		});
		expect(replay).toEqual({ ...first, replayed: true });

		const changed = structuredClone(fixture.config);
		changed.mission_context.manifest.objective = "Different objective";
		await expect(
			createMissionLedger(handle.db, {
				createdByAgentId: fixture.backendAgentId,
				coordinatorConfig: changed,
			}),
		).rejects.toMatchObject({ code: "duplicate_idempotency_key" });

		expect(await handle.db.select().from(missions)).toHaveLength(1);
		expect(await handle.db.select().from(missionParticipants)).toHaveLength(2);
	});

	it("derives activation from two exact acceptance receipts and replays a concurrent receipt", async () => {
		const fixture = await createFixtureMission(handle);

		await expect(
			appendMissionEvent(handle.db, {
				missionId: fixture.missionId,
				actorAgentId: fixture.backendAgentId,
				event: aggregateAcceptanceInput(fixture, "accept:spoofed-aggregate"),
			}),
		).rejects.toMatchObject({ code: "not_authorized_transition" });

		const wrongContract = participantAcceptanceInput(
			fixture,
			fixture.backendAgentId,
			"accept:wrong-contract",
		);
		wrongContract.contract = { ...fixture.contractV1, sha256: "f".repeat(64) };
		await expect(
			acceptMissionParticipant(handle.db, {
				missionId: fixture.missionId,
				participantAgentId: fixture.backendAgentId,
				acceptance: wrongContract,
			}),
		).rejects.toMatchObject({ code: "invalid_params" });

		const wrongProfile = participantAcceptanceInput(
			fixture,
			fixture.backendAgentId,
			"accept:wrong-profile",
		);
		wrongProfile.local_policy_grant = {
			...wrongProfile.local_policy_grant,
			profile_name: "read-only",
		};
		await expect(
			acceptMissionParticipant(handle.db, {
				missionId: fixture.missionId,
				participantAgentId: fixture.backendAgentId,
				acceptance: wrongProfile,
			}),
		).rejects.toMatchObject({ code: "invalid_params" });

		const backendAcceptance = participantAcceptanceInput(
			fixture,
			fixture.backendAgentId,
			"accept:backend",
		);
		const [backendFirst, backendReplay] = await Promise.all([
			acceptMissionParticipant(handle.db, {
				missionId: fixture.missionId,
				participantAgentId: fixture.backendAgentId,
				acceptance: backendAcceptance,
			}),
			acceptMissionParticipant(handle.db, {
				missionId: fixture.missionId,
				participantAgentId: fixture.backendAgentId,
				acceptance: structuredClone(backendAcceptance),
			}),
		]);
		expect([backendFirst, backendReplay].filter((result) => result.replayed)).toHaveLength(1);
		expect(backendFirst.receipt).toEqual(backendReplay.receipt);
		expect(backendFirst.receipt).toMatchObject({
			participant_agent_id: fixture.backendAgentId,
			contract: fixture.contractV1,
			local_policy_grant: backendAcceptance.local_policy_grant,
		});
		expect(await handle.db.select().from(missionEvents)).toEqual([]);
		expect(await handle.db.select().from(nodeDeliveries)).toEqual([]);

		const changedReplay = structuredClone(backendAcceptance);
		changedReplay.local_policy_grant.grant_sha256 = "9".repeat(64);
		await expect(
			acceptMissionParticipant(handle.db, {
				missionId: fixture.missionId,
				participantAgentId: fixture.backendAgentId,
				acceptance: changedReplay,
			}),
		).rejects.toMatchObject({ code: "duplicate_idempotency_key" });

		const androidAcceptance = participantAcceptanceInput(
			fixture,
			fixture.androidAgentId,
			"accept:android",
		);
		await acceptMissionParticipant(handle.db, {
			missionId: fixture.missionId,
			participantAgentId: fixture.androidAgentId,
			acceptance: androidAcceptance,
		});

		const [mission] = await handle.db.select().from(missions);
		expect(mission).toMatchObject({ status: "active", lastEventSequence: 1 });
		const participants = await handle.db
			.select()
			.from(missionParticipants)
			.where(eq(missionParticipants.missionId, fixture.missionId));
		expect(participants).toHaveLength(2);
		expect(participants.every((participant) => participant.status === "accepted")).toBe(true);
		expect(participants.map((participant) => participant.acceptanceReceipt)).toEqual(
			expect.arrayContaining([backendAcceptance, androidAcceptance]),
		);
		expect(await handle.db.select().from(missionEvents)).toHaveLength(1);
		expect(await handle.db.select().from(nodeDeliveries)).toHaveLength(1);
	});

	it("serializes concurrent exact event retries with stable event and delivery identities", async () => {
		const fixture = await createFixtureMission(handle);
		const activated = await activateMission(handle, fixture);
		const event = replyInput({
			fixture,
			participantAgentId: fixture.backendAgentId,
			deliveryId: activated.backendTurnDeliveryId,
			idempotencyKey: "turn:concurrent",
			messageId: randomUUID(),
			messageIdempotencyKey: "message:concurrent",
			message: "Should avatar_url be nullable?",
			sequenceNo: 1,
			causalParentMessageId: null,
		});
		const [first, replay] = await Promise.all([
			appendMissionEvent(handle.db, {
				missionId: fixture.missionId,
				actorAgentId: fixture.backendAgentId,
				event,
			}),
			appendMissionEvent(handle.db, {
				missionId: fixture.missionId,
				actorAgentId: fixture.backendAgentId,
				event: structuredClone(event),
			}),
		]);
		expect([first, replay].filter((result) => result.replayed)).toHaveLength(1);
		expect(first.event.event_id).toBe(replay.event.event_id);
		expect(first.deliveryIds).toEqual(replay.deliveryIds);
		expect(first.deliveryIds).toHaveLength(1);
		expect(await handle.db.select().from(missionEvents)).toHaveLength(2);
		expect(await handle.db.select().from(nodeDeliveries)).toHaveLength(2);
		expect(
			await handle.db.select().from(auditLog).where(eq(auditLog.action, "mission.event.append")),
		).toHaveLength(2);

		const changed = structuredClone(event);
		changed.disposition.message = "A different question";
		changed.message.body = "A different question";
		await expect(
			appendMissionEvent(handle.db, {
				missionId: fixture.missionId,
				actorAgentId: fixture.backendAgentId,
				event: changed,
			}),
		).rejects.toMatchObject({ code: "duplicate_idempotency_key" });

		await expect(
			appendMissionEvent(handle.db, {
				missionId: fixture.missionId,
				actorAgentId: fixture.androidAgentId,
				event: { ...event, event_id: randomUUID() },
			}),
		).rejects.toThrow(/Unrecognized key/);
	});

	it("rolls back the second acceptance, derived event, delivery, projection, and audit together", async () => {
		const fixture = await createFixtureMission(handle);
		await acceptMissionParticipant(handle.db, {
			missionId: fixture.missionId,
			participantAgentId: fixture.backendAgentId,
			acceptance: participantAcceptanceInput(
				fixture,
				fixture.backendAgentId,
				"accept:rollback:backend",
			),
		});
		await handle.sql.unsafe(`
			CREATE OR REPLACE FUNCTION reject_node_delivery_test() RETURNS TRIGGER AS $$
			BEGIN
				RAISE EXCEPTION 'forced delivery failure';
			END;
			$$ LANGUAGE plpgsql;
			CREATE TRIGGER reject_node_delivery_test
				BEFORE INSERT ON node_deliveries
				FOR EACH ROW EXECUTE FUNCTION reject_node_delivery_test();
		`);

		try {
			await expect(
				acceptMissionParticipant(handle.db, {
					missionId: fixture.missionId,
					participantAgentId: fixture.androidAgentId,
					acceptance: participantAcceptanceInput(
						fixture,
						fixture.androidAgentId,
						"accept:rollback:android",
					),
				}),
			).rejects.toThrow(/forced delivery failure/);
		} finally {
			await handle.sql.unsafe(`
				DROP TRIGGER IF EXISTS reject_node_delivery_test ON node_deliveries;
				DROP FUNCTION IF EXISTS reject_node_delivery_test();
			`);
		}

		expect(await handle.db.select().from(missionEvents)).toEqual([]);
		expect(await handle.db.select().from(nodeDeliveries)).toEqual([]);
		const [mission] = await handle.db.select().from(missions);
		expect(mission).toMatchObject({ status: "awaiting_acceptance", lastEventSequence: 0 });
		const participants = await handle.db
			.select()
			.from(missionParticipants)
			.where(eq(missionParticipants.missionId, fixture.missionId));
		expect(
			Object.fromEntries(
				participants.map((participant) => [participant.agentId, participant.status]),
			),
		).toEqual({
			[fixture.backendAgentId]: "accepted",
			[fixture.androidAgentId]: "pending",
		});
		expect(
			await handle.db
				.select()
				.from(auditLog)
				.where(eq(auditLog.action, "mission.participant.accept")),
		).toHaveLength(1);
		expect(
			await handle.db.select().from(auditLog).where(eq(auditLog.action, "mission.event.append")),
		).toEqual([]);
	});

	it("stamps pending contract acknowledgement deliveries with v2 and serializes both acknowledgements", async () => {
		const fixture = await createFixtureMission(handle);
		const activated = await activateMission(handle, fixture);
		const proposed = await appendMissionEvent(handle.db, {
			missionId: fixture.missionId,
			actorAgentId: fixture.backendAgentId,
			event: proposalInput(fixture, activated.backendTurnDeliveryId),
		});
		expect(proposed.deliveryIds).toHaveLength(2);

		const acknowledgementDeliveries = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(inArray(nodeDeliveries.id, [...proposed.deliveryIds]));
		expect(acknowledgementDeliveries).toHaveLength(2);
		expect(
			acknowledgementDeliveries.map((delivery) => ({
				kind: delivery.kind,
				contractVersion: delivery.contractVersion,
			})),
		).toEqual([
			{ kind: "contract_acknowledgement", contractVersion: 2 },
			{ kind: "contract_acknowledgement", contractVersion: 2 },
		]);
		const backendAckDelivery = acknowledgementDeliveries.find(
			(delivery) => delivery.nodeId === fixture.backendNodeId,
		);
		const androidAckDelivery = acknowledgementDeliveries.find(
			(delivery) => delivery.nodeId === fixture.androidNodeId,
		);
		if (!backendAckDelivery || !androidAckDelivery) {
			throw new Error("expected one contract acknowledgement delivery per participant Node");
		}

		const results = await Promise.all([
			appendMissionEvent(handle.db, {
				missionId: fixture.missionId,
				actorAgentId: fixture.backendAgentId,
				event: acknowledgementInput(
					fixture,
					fixture.backendAgentId,
					backendAckDelivery.id,
					"ack:backend",
				),
			}),
			appendMissionEvent(handle.db, {
				missionId: fixture.missionId,
				actorAgentId: fixture.androidAgentId,
				event: acknowledgementInput(
					fixture,
					fixture.androidAgentId,
					androidAckDelivery.id,
					"ack:android",
				),
			}),
		]);
		expect(results.map((result) => result.event.sequence_no).sort((a, b) => a - b)).toEqual([3, 4]);
		expect(results.flatMap((result) => result.deliveryIds)).toHaveLength(1);
		const [mission] = await handle.db.select().from(missions);
		expect(mission).toMatchObject({
			status: "active",
			lastEventSequence: 4,
			contractVersion: 2,
		});
	});

	it("rejects fabricated, cross-Mission, wrong-Node, wrong-kind, and consumed source deliveries", async () => {
		const fixture = await createFixtureMission(handle);
		const activated = await activateMission(handle, fixture);
		const other = await createFixtureMission(handle);
		const otherActivated = await activateMission(handle, other);

		const expectNoAdvance = async (operation: () => Promise<unknown>) => {
			const [before] = await handle.db
				.select({ sequence: missions.lastEventSequence })
				.from(missions)
				.where(eq(missions.id, fixture.missionId));
			const eventCount = (
				await handle.db
					.select()
					.from(missionEvents)
					.where(eq(missionEvents.missionId, fixture.missionId))
			).length;
			await expect(operation()).rejects.toMatchObject({
				code: expect.stringMatching(/^(invalid_transition|not_authorized_transition)$/),
			});
			const [after] = await handle.db
				.select({ sequence: missions.lastEventSequence })
				.from(missions)
				.where(eq(missions.id, fixture.missionId));
			expect(after?.sequence).toBe(before?.sequence);
			expect(
				await handle.db
					.select()
					.from(missionEvents)
					.where(eq(missionEvents.missionId, fixture.missionId)),
			).toHaveLength(eventCount);
		};

		await expectNoAdvance(() =>
			appendMissionEvent(handle.db, {
				missionId: fixture.missionId,
				actorAgentId: fixture.backendAgentId,
				event: readyInput(fixture.backendAgentId, randomUUID(), "turn:fabricated-source"),
			}),
		);
		await expectNoAdvance(() =>
			appendMissionEvent(handle.db, {
				missionId: fixture.missionId,
				actorAgentId: fixture.backendAgentId,
				event: readyInput(
					fixture.backendAgentId,
					otherActivated.backendTurnDeliveryId,
					"turn:cross-mission-source",
				),
			}),
		);

		const proposed = await appendMissionEvent(handle.db, {
			missionId: fixture.missionId,
			actorAgentId: fixture.backendAgentId,
			event: proposalInput(fixture, activated.backendTurnDeliveryId),
		});
		const ackDeliveries = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(inArray(nodeDeliveries.id, [...proposed.deliveryIds]));
		const backendAckDelivery = ackDeliveries.find(
			(delivery) => delivery.nodeId === fixture.backendNodeId,
		);
		const androidAckDelivery = ackDeliveries.find(
			(delivery) => delivery.nodeId === fixture.androidNodeId,
		);
		if (!backendAckDelivery || !androidAckDelivery) {
			throw new Error("expected both acknowledgement delivery rows");
		}

		await expectNoAdvance(() =>
			appendMissionEvent(handle.db, {
				missionId: fixture.missionId,
				actorAgentId: fixture.androidAgentId,
				event: acknowledgementInput(
					fixture,
					fixture.androidAgentId,
					backendAckDelivery.id,
					"ack:wrong-node",
				),
			}),
		);
		await expectNoAdvance(() =>
			appendMissionEvent(handle.db, {
				missionId: fixture.missionId,
				actorAgentId: fixture.androidAgentId,
				event: readyInput(fixture.androidAgentId, androidAckDelivery.id, "turn:wrong-kind", 2),
			}),
		);

		await appendMissionEvent(handle.db, {
			missionId: fixture.missionId,
			actorAgentId: fixture.backendAgentId,
			event: acknowledgementInput(
				fixture,
				fixture.backendAgentId,
				backendAckDelivery.id,
				"ack:consume-source",
			),
		});
		const [consumed] = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(eq(nodeDeliveries.id, backendAckDelivery.id));
		expect(consumed).toMatchObject({
			status: "stored",
			settledByEventId: expect.any(String),
			settledAt: expect.any(Date),
		});
		await expectNoAdvance(() =>
			appendMissionEvent(handle.db, {
				missionId: fixture.missionId,
				actorAgentId: fixture.backendAgentId,
				event: acknowledgementInput(
					fixture,
					fixture.backendAgentId,
					backendAckDelivery.id,
					"ack:reuse-consumed-source",
				),
			}),
		);
	});

	it("settles every failed verification delivery in its round and rejects stale-round output", async () => {
		const fixture = await createFixtureMission(handle);
		const activated = await activateMission(handle, fixture);
		const backendReady = await appendMissionEvent(handle.db, {
			missionId: fixture.missionId,
			actorAgentId: fixture.backendAgentId,
			event: readyInput(
				fixture.backendAgentId,
				activated.backendTurnDeliveryId,
				"ready:round-1:backend",
			),
		});
		const androidReady = await appendMissionEvent(handle.db, {
			missionId: fixture.missionId,
			actorAgentId: fixture.androidAgentId,
			event: readyInput(
				fixture.androidAgentId,
				only(backendReady.deliveryIds, "round-one Android turn delivery"),
				"ready:round-1:android",
			),
		});
		const roundOneDeliveries = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(inArray(nodeDeliveries.id, [...androidReady.deliveryIds]));
		const backendRoundOne = roundOneDeliveries.find(
			(delivery) => delivery.nodeId === fixture.backendNodeId,
		);
		const androidRoundOne = roundOneDeliveries.find(
			(delivery) => delivery.nodeId === fixture.androidNodeId,
		);
		if (!backendRoundOne || !androidRoundOne) {
			throw new Error("expected both round-one verification deliveries");
		}
		expect(roundOneDeliveries.every((delivery) => delivery.verificationRound === 1)).toBe(true);

		const failed = await appendMissionEvent(handle.db, {
			missionId: fixture.missionId,
			actorAgentId: fixture.backendAgentId,
			event: verificationInput(
				fixture.backendAgentId,
				backendRoundOne.id,
				"backend-test",
				"verify:round-1:failed",
				{ outcome: "failed" },
			),
		});
		expect(failed.state).toMatchObject({ status: "active", verification_round: 1 });
		expect(failed.deliveryIds).toHaveLength(1);
		const settledRoundOne = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(inArray(nodeDeliveries.id, [...androidReady.deliveryIds]));
		expect(
			settledRoundOne.map((delivery) => ({
				status: delivery.status,
				verificationRound: delivery.verificationRound,
				settledByEventId: delivery.settledByEventId,
				settledAt: delivery.settledAt,
			})),
		).toEqual([
			{
				status: "stored",
				verificationRound: 1,
				settledByEventId: failed.event.event_id,
				settledAt: expect.any(Date),
			},
			{
				status: "stored",
				verificationRound: 1,
				settledByEventId: failed.event.event_id,
				settledAt: expect.any(Date),
			},
		]);

		await expect(
			appendMissionEvent(handle.db, {
				missionId: fixture.missionId,
				actorAgentId: fixture.androidAgentId,
				event: verificationInput(
					fixture.androidAgentId,
					androidRoundOne.id,
					"android-test",
					"verify:round-1:stale",
				),
			}),
		).rejects.toMatchObject({ code: "invalid_transition" });

		const retryBackendReady = await appendMissionEvent(handle.db, {
			missionId: fixture.missionId,
			actorAgentId: fixture.backendAgentId,
			event: readyInput(
				fixture.backendAgentId,
				only(failed.deliveryIds, "retry backend turn delivery"),
				"ready:round-2:backend",
			),
		});
		const retryAndroidReady = await appendMissionEvent(handle.db, {
			missionId: fixture.missionId,
			actorAgentId: fixture.androidAgentId,
			event: readyInput(
				fixture.androidAgentId,
				only(retryBackendReady.deliveryIds, "retry Android turn delivery"),
				"ready:round-2:android",
			),
		});
		expect(retryAndroidReady.state).toMatchObject({ status: "verifying", verification_round: 2 });
		const roundTwoDeliveries = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(inArray(nodeDeliveries.id, [...retryAndroidReady.deliveryIds]));
		expect(roundTwoDeliveries).toHaveLength(2);
		expect(
			roundTwoDeliveries.every(
				(delivery) =>
					delivery.verificationRound === 2 &&
					delivery.settledByEventId === null &&
					delivery.settledAt === null,
			),
		).toBe(true);
	});

	it("replays ordered Node-isolated cursor pages without mutating delivery state", async () => {
		const fixture = await createFixtureMission(handle);
		const activated = await activateMission(handle, fixture);
		await appendMissionEvent(handle.db, {
			missionId: fixture.missionId,
			actorAgentId: fixture.backendAgentId,
			event: proposalInput(fixture, activated.backendTurnDeliveryId),
		});

		const backendPage = await listStoredDeliveryEvents(handle.db, {
			nodeId: fixture.backendNodeId,
			page: { after_cursor: null, limit: 50 },
		});
		const androidPage = await listStoredDeliveryEvents(handle.db, {
			nodeId: fixture.androidNodeId,
			page: { after_cursor: null, limit: 50 },
		});
		expect(backendPage.items).toHaveLength(1);
		expect(backendPage.items[0]?.event.type).toBe("turn_completed");
		expect(backendPage.items[0]?.event.participant_agent_id).toBe(fixture.backendAgentId);
		expect(backendPage.items[0]?.delivery.kind).toBe("contract_acknowledgement");
		expect(androidPage.items).toHaveLength(1);
		expect(androidPage.items[0]?.event.type).toBe("turn_completed");
		expect(androidPage.items[0]?.event.participant_agent_id).toBe(fixture.backendAgentId);
		expect(androidPage.items[0]?.delivery.kind).toBe("contract_acknowledgement");
		expect(BigInt(backendPage.next_cursor ?? "0")).toBeLessThan(
			BigInt(androidPage.next_cursor ?? "0"),
		);

		const replay = await listStoredDeliveryEvents(handle.db, {
			nodeId: fixture.backendNodeId,
			page: { after_cursor: null, limit: 50 },
		});
		expect(replay).toEqual(backendPage);
		const exhausted = await listStoredDeliveryEvents(handle.db, {
			nodeId: fixture.backendNodeId,
			page: { after_cursor: backendPage.next_cursor, limit: 50 },
		});
		expect(exhausted).toEqual({ items: [], next_cursor: backendPage.next_cursor });

		if (!TEST_URL) throw new Error("expected test database URL");
		const reopened = createDb({ RELAY_DATABASE_URL: TEST_URL, RELAY_DB_POOL_SIZE: 2 });
		try {
			expect(
				await listStoredDeliveryEvents(reopened.db, {
					nodeId: fixture.androidNodeId,
					page: { after_cursor: null, limit: 50 },
				}),
			).toEqual(androidPage);
		} finally {
			await reopened.close();
		}

		const stored = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(eq(nodeDeliveries.status, "stored"));
		expect(stored).toHaveLength(3);
		expect(stored.filter((delivery) => delivery.settledByEventId === null)).toHaveLength(2);
	});

	it("rejects delayed output after terminal completion without changing ledger rows", async () => {
		const fixture = await createFixtureMission(handle);
		const activated = await activateMission(handle, fixture);
		const backendReady = await appendMissionEvent(handle.db, {
			missionId: fixture.missionId,
			actorAgentId: fixture.backendAgentId,
			event: readyInput(fixture.backendAgentId, activated.backendTurnDeliveryId, "ready:backend"),
		});
		const androidReady = await appendMissionEvent(handle.db, {
			missionId: fixture.missionId,
			actorAgentId: fixture.androidAgentId,
			event: readyInput(
				fixture.androidAgentId,
				only(backendReady.deliveryIds, "Android turn delivery"),
				"ready:android",
			),
		});
		expect(androidReady.state.status).toBe("verifying");
		const verificationDeliveries = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(inArray(nodeDeliveries.id, [...androidReady.deliveryIds]));
		const backendVerificationDelivery = verificationDeliveries.find(
			(delivery) => delivery.nodeId === fixture.backendNodeId,
		);
		const androidVerificationDelivery = verificationDeliveries.find(
			(delivery) => delivery.nodeId === fixture.androidNodeId,
		);
		if (!backendVerificationDelivery || !androidVerificationDelivery) {
			throw new Error("expected one verification delivery per participant Node");
		}

		await appendMissionEvent(handle.db, {
			missionId: fixture.missionId,
			actorAgentId: fixture.backendAgentId,
			event: verificationInput(
				fixture.backendAgentId,
				backendVerificationDelivery.id,
				"backend-test",
				"verify:backend",
			),
		});
		const completed = await appendMissionEvent(handle.db, {
			missionId: fixture.missionId,
			actorAgentId: fixture.androidAgentId,
			event: verificationInput(
				fixture.androidAgentId,
				androidVerificationDelivery.id,
				"android-test",
				"verify:android",
			),
		});
		expect(completed.state.status).toBe("completed");
		const eventsBefore = await handle.db
			.select()
			.from(missionEvents)
			.where(eq(missionEvents.missionId, fixture.missionId))
			.orderBy(asc(missionEvents.sequenceNo));
		const deliveriesBefore = await handle.db
			.select()
			.from(nodeDeliveries)
			.where(eq(nodeDeliveries.missionId, fixture.missionId))
			.orderBy(asc(nodeDeliveries.cursor));
		const [missionBefore] = await handle.db
			.select()
			.from(missions)
			.where(eq(missions.id, fixture.missionId));

		await expect(
			appendMissionEvent(handle.db, {
				missionId: fixture.missionId,
				actorAgentId: fixture.backendAgentId,
				event: verificationInput(
					fixture.backendAgentId,
					backendVerificationDelivery.id,
					"backend-test",
					"verify:late",
				),
			}),
		).rejects.toMatchObject({ code: "invalid_transition" });
		expect(
			await handle.db
				.select()
				.from(missionEvents)
				.where(eq(missionEvents.missionId, fixture.missionId))
				.orderBy(asc(missionEvents.sequenceNo)),
		).toEqual(eventsBefore);
		expect(
			await handle.db
				.select()
				.from(nodeDeliveries)
				.where(eq(nodeDeliveries.missionId, fixture.missionId))
				.orderBy(asc(nodeDeliveries.cursor)),
		).toEqual(deliveriesBefore);
		expect(
			await handle.db.select().from(missions).where(eq(missions.id, fixture.missionId)),
		).toEqual([missionBefore]);
	});
});

interface Fixture {
	readonly missionId: string;
	readonly backendAgentId: string;
	readonly androidAgentId: string;
	readonly backendNodeId: string;
	readonly androidNodeId: string;
	readonly backendBindingId: string;
	readonly androidBindingId: string;
	readonly contractV1: ContractRef;
	readonly contractV2: ContractRef;
	readonly revisionId: string;
	readonly config: MissionCoordinatorConfig;
}

interface ContractRef {
	readonly artifact_id: string;
	readonly type: "api_contract";
	readonly version: number;
	readonly sha256: string;
	readonly media_type: "application/json";
	readonly byte_size: number;
}

interface ActivatedMission {
	readonly backendTurnDeliveryId: string;
}

async function seedFixture(handle: TestDb): Promise<Fixture> {
	const missionId = randomUUID();
	const backendAgentId = randomUUID();
	const androidAgentId = randomUUID();
	const backendNodeId = randomUUID();
	const androidNodeId = randomUUID();
	const backendBindingId = randomUUID();
	const androidBindingId = randomUUID();
	const artifactId = randomUUID();
	const contractV1: ContractRef = {
		artifact_id: artifactId,
		type: "api_contract",
		version: 1,
		sha256: "a".repeat(64),
		media_type: "application/json",
		byte_size: 128,
	};
	const contractV2: ContractRef = { ...contractV1, version: 2, sha256: "b".repeat(64) };
	const createdAt = new Date(Date.now() - 1_000).toISOString();
	const config: MissionCoordinatorConfig = {
		mission_context: {
			manifest: {
				schema_version: 1,
				mission_id: missionId,
				objective: "Ship one compatible profile contract across backend and Android",
				public_acceptance_criteria: ["Both repository checks pass"],
				participants: [
					{
						agent_id: backendAgentId,
						role: "backend",
						workspace_alias: "backend-api",
						repository_url: "https://github.com/acme/backend.git",
						expected_base_commit: "1".repeat(40),
						initial_assignment: "Implement the response contract",
						requested_local_policy_profile: "bounded-code",
					},
					{
						agent_id: androidAgentId,
						role: "android",
						workspace_alias: "android-app",
						repository_url: "https://github.com/acme/android.git",
						expected_base_commit: "2".repeat(40),
						initial_assignment: "Consume the response contract",
						requested_local_policy_profile: "bounded-code",
					},
				],
				shared_contract: contractV1 as ContractRef & { version: 1 },
				max_turns: 20,
				max_wall_time_seconds: 3_600,
				token_budget: 100_000,
				expires_at: new Date(Date.now() + 3_600_000).toISOString(),
				allowed_artifact_types: ["api_contract"],
				created_at: createdAt,
			},
			created_by: { principal_id: backendAgentId, kind: "agent" },
		},
		required_verification_commands: {
			[backendAgentId]: ["backend-test"],
			[androidAgentId]: ["android-test"],
		},
	};

	await handle.db.insert(agents).values([
		{
			id: backendAgentId,
			handle: `backend-${backendAgentId}@acme`,
			email: `backend-${backendAgentId}@example.com`,
			displayName: "Backend",
			role: "backend",
		},
		{
			id: androidAgentId,
			handle: `android-${androidAgentId}@acme`,
			email: `android-${androidAgentId}@example.com`,
			displayName: "Android",
			role: "android",
		},
	]);
	await handle.db.insert(nodes).values([
		{ id: backendNodeId, agentId: backendAgentId, name: "backend-mac" },
		{ id: androidNodeId, agentId: androidAgentId, name: "android-mac" },
	]);
	await handle.db.insert(workspaceBindings).values([
		{
			id: backendBindingId,
			nodeId: backendNodeId,
			alias: "backend-api",
			repositoryUrl: "https://github.com/acme/backend.git",
			allowedBaseRefs: ["refs/heads/main"],
		},
		{
			id: androidBindingId,
			nodeId: androidNodeId,
			alias: "android-app",
			repositoryUrl: "https://github.com/acme/android.git",
			allowedBaseRefs: ["refs/heads/main"],
		},
	]);

	return {
		missionId,
		backendAgentId,
		androidAgentId,
		backendNodeId,
		androidNodeId,
		backendBindingId,
		androidBindingId,
		contractV1,
		contractV2,
		revisionId: randomUUID(),
		config,
	};
}

async function createFixtureMission(handle: TestDb): Promise<Fixture> {
	const fixture = await seedFixture(handle);
	await createMissionLedger(handle.db, {
		createdByAgentId: fixture.backendAgentId,
		coordinatorConfig: fixture.config,
	});
	return fixture;
}

async function activateMission(handle: TestDb, fixture: Fixture): Promise<ActivatedMission> {
	await acceptMissionParticipant(handle.db, {
		missionId: fixture.missionId,
		participantAgentId: fixture.backendAgentId,
		acceptance: participantAcceptanceInput(
			fixture,
			fixture.backendAgentId,
			`accept:${fixture.missionId}:backend`,
		),
	});
	await acceptMissionParticipant(handle.db, {
		missionId: fixture.missionId,
		participantAgentId: fixture.androidAgentId,
		acceptance: participantAcceptanceInput(
			fixture,
			fixture.androidAgentId,
			`accept:${fixture.missionId}:android`,
		),
	});
	const [delivery] = await handle.db
		.select({ id: nodeDeliveries.id })
		.from(nodeDeliveries)
		.where(
			and(
				eq(nodeDeliveries.missionId, fixture.missionId),
				eq(nodeDeliveries.nodeId, fixture.backendNodeId),
				eq(nodeDeliveries.kind, "turn"),
				eq(nodeDeliveries.status, "stored"),
			),
		);
	if (!delivery) throw new Error("expected activation to schedule the backend turn");
	return { backendTurnDeliveryId: delivery.id };
}

function participantAcceptanceInput(
	fixture: Fixture,
	participantAgentId: string,
	idempotencyKey: string,
) {
	return {
		idempotency_key: idempotencyKey,
		contract: { ...fixture.contractV1 },
		local_policy_grant: {
			profile_name: "bounded-code",
			grant_sha256: participantAgentId === fixture.backendAgentId ? "d".repeat(64) : "e".repeat(64),
		},
	};
}

function aggregateAcceptanceInput(fixture: Fixture, idempotencyKey: string) {
	return {
		idempotency_key: idempotencyKey,
		type: "participants_accepted" as const,
		participant_agent_ids: [fixture.backendAgentId, fixture.androidAgentId],
		contract: fixture.contractV1,
	};
}

function replyInput(input: {
	fixture: Fixture;
	participantAgentId: string;
	deliveryId: string;
	idempotencyKey: string;
	messageId: string;
	messageIdempotencyKey: string;
	message: string;
	sequenceNo: number;
	causalParentMessageId: string | null;
}) {
	return {
		idempotency_key: input.idempotencyKey,
		type: "turn_completed" as const,
		participant_agent_id: input.participantAgentId,
		delivery_id: input.deliveryId,
		contract_version: 1,
		disposition: {
			kind: "reply" as const,
			message_type: "question" as const,
			message: input.message,
		},
		message: {
			message_id: input.messageId,
			mission_id: input.fixture.missionId,
			sequence_no: input.sequenceNo,
			author_agent_id: input.participantAgentId,
			type: "question" as const,
			body: input.message,
			artifacts: [],
			contract_version: 1,
			idempotency_key: input.messageIdempotencyKey,
			causal_parent_message_id: input.causalParentMessageId,
			created_at: new Date().toISOString(),
		},
		revision: null,
	};
}

function proposalInput(fixture: Fixture, deliveryId: string) {
	return {
		idempotency_key: "turn:backend:proposal",
		type: "turn_completed" as const,
		participant_agent_id: fixture.backendAgentId,
		delivery_id: deliveryId,
		contract_version: 1,
		disposition: { kind: "propose_contract" as const, artifact: fixture.contractV2 },
		message: null,
		revision: {
			revision_id: fixture.revisionId,
			mission_id: fixture.missionId,
			previous_version: 1,
			version: 2,
			artifact: fixture.contractV2,
			proposed_by_agent_id: fixture.backendAgentId,
			acknowledged_by_agent_ids: [],
			idempotency_key: "revision:2",
			created_at: new Date().toISOString(),
		},
	};
}

function acknowledgementInput(
	fixture: Fixture,
	participantAgentId: string,
	deliveryId: string,
	idempotencyKey: string,
) {
	return {
		idempotency_key: idempotencyKey,
		type: "contract_acknowledged" as const,
		participant_agent_id: participantAgentId,
		delivery_id: deliveryId,
		revision_id: fixture.revisionId,
		contract_version: 2,
		artifact: fixture.contractV2,
	};
}

function readyInput(
	participantAgentId: string,
	deliveryId: string,
	idempotencyKey: string,
	contractVersion = 1,
) {
	return {
		idempotency_key: idempotencyKey,
		type: "turn_completed" as const,
		participant_agent_id: participantAgentId,
		delivery_id: deliveryId,
		contract_version: contractVersion,
		disposition: { kind: "ready" as const, evidence: [] },
		message: null,
		revision: null,
	};
}

function verificationInput(
	participantAgentId: string,
	deliveryId: string,
	commandId: string,
	idempotencyKey: string,
	options: { verificationRound?: number; outcome?: "passed" | "failed" } = {},
) {
	const outcome = options.outcome ?? "passed";
	return {
		idempotency_key: idempotencyKey,
		type: "verification_recorded" as const,
		participant_agent_id: participantAgentId,
		delivery_id: deliveryId,
		contract_version: 1,
		verification_round: options.verificationRound ?? 1,
		evidence: {
			verification_id: randomUUID(),
			command_id: commandId,
			outcome,
			exit_code: outcome === "passed" ? 0 : 1,
			duration_ms: 25,
			summary: `${commandId} ${outcome}`,
			output_sha256: "c".repeat(64),
			artifacts: [],
			recorded_at: new Date().toISOString(),
		},
	};
}

function only(values: readonly string[], label: string): string {
	if (values.length !== 1) throw new Error(`expected exactly one ${label}`);
	return values[0]!;
}
