import {
	type AgentHostAdapter,
	type Delivery,
	type DeliveryClaimInput,
	type DeliveryClaimResult,
	type DeliveryCompleteInput,
	type DeliveryCompleteResult,
	type DeliveryReleaseInput,
	type DeliveryReleaseResult,
	type DeliveryRenewInput,
	type DeliveryRenewResult,
	type DeliveryStartInput,
	type DeliveryStartResult,
	type HostEvent,
	MAX_HOST_PEER_MESSAGES,
	type MissionDeliveryItem,
	type MissionParticipantAcceptanceInput,
	type MissionParticipantAcceptanceResult,
	type MissionStatus,
	type NodeMissionAssignment,
	type NodeMissionAssignmentList,
	type NodeSelfResult,
	type RecoverableMissionDeliveryPage,
	type StartTurnInput,
	type StoredMissionDeliveryCursorPage,
	type WorkspaceBindingList,
	type WorkspaceRegistrationInput,
	type WorkspaceRegistrationResult,
	createMissionCoordinatorState,
	nodeMissionAssignmentSchema,
	reduceMissionCoordinatorEvent,
} from "@agentrelay/protocol";
import { FakeAgentHostAdapter, type FakeTurnOutcome } from "@agentrelay/protocol/testing";
import { describe, expect, it, vi } from "vitest";
import type { NodeConfig } from "./config.js";
import { type DeliveryCheckpoint, DeliveryProcessor } from "./delivery-processor.js";
import { type JournalStorage, NodeJournal, type NodeJournalState } from "./journal.js";
import { resolvePolicyProfile } from "./policy.js";
import type { NodeRelayClient } from "./relay-client.js";
import { RelayHttpError } from "./relay-client.js";

const IDS = {
	mission: "20000000-0000-4000-8000-000000000001",
	owner: "20000000-0000-4000-8000-000000000002",
	agent: "20000000-0000-4000-8000-000000000003",
	peer: "20000000-0000-4000-8000-000000000004",
	node: "20000000-0000-4000-8000-000000000005",
	credential: "20000000-0000-4000-8000-000000000006",
	binding: "20000000-0000-4000-8000-000000000007",
	delivery: "20000000-0000-4000-8000-000000000008",
	event: "20000000-0000-4000-8000-000000000009",
	artifact: "20000000-0000-4000-8000-000000000010",
	settlement: "20000000-0000-4000-8000-000000000011",
} as const;

const TIMES = {
	created: "2026-08-02T00:00:00.000Z",
	claimed: "2026-08-02T00:01:00.000Z",
	started: "2026-08-02T00:02:00.000Z",
	renewed: "2026-08-02T00:03:00.000Z",
	expires: "2026-08-02T00:20:00.000Z",
	completed: "2026-08-02T00:04:00.000Z",
} as const;

describe("DeliveryProcessor", () => {
	it("claims, starts, invokes one host turn, and acknowledges the result", async () => {
		const harness = await createHarness();
		await harness.processor.process(IDS.delivery);

		const entry = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(entry.phase).toBe("acknowledged");
		expect(entry.item.delivery.status).toBe("acknowledged");
		expect(harness.adapter.counters.turnsCreated).toBe(1);
		expect(harness.client.claimInputs).toHaveLength(1);
		expect(harness.client.completeInputs).toHaveLength(1);
		expect(harness.client.completeInputs[0]?.result).toEqual({
			type: "turn_completed",
			disposition: {
				kind: "reply",
				message_type: "progress",
				message: "fake result",
			},
		});
	});

	it("renews the executing lease while runtime setup is still in progress", async () => {
		const harness = await createHarness();
		harness.client.renewalExpiresAt = "2026-08-02T00:03:00.300Z";
		let enterProbe!: () => void;
		let releaseProbe!: () => void;
		const probeEntered = new Promise<void>((resolve) => {
			enterProbe = resolve;
		});
		const probeGate = new Promise<void>((resolve) => {
			releaseProbe = resolve;
		});
		const adapter: AgentHostAdapter = {
			...adapterDelegates(harness.adapter),
			async probe() {
				enterProbe();
				await probeGate;
				return harness.adapter.probe();
			},
		};
		const processor = processorFor({ ...harness, adapter });

		const processing = processor.process(IDS.delivery);
		await probeEntered;

		expect(harness.client.startInputs).toHaveLength(1);
		expect(harness.client.renewInputs).toHaveLength(2);
		await vi.waitFor(() => expect(harness.client.renewInputs.length).toBeGreaterThan(2));
		releaseProbe();
		await processing;

		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("recovers an accepted host turn after runner reconstruction without duplicating it", async () => {
		let crash = true;
		const harness = await createHarness({
			onCheckpoint(checkpoint) {
				if (crash && checkpoint === "host_accepted") {
					crash = false;
					throw new Error("injected crash after host acceptance");
				}
			},
		});

		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow("injected crash");
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("host_accepted");

		const restarted = processorFor(harness);
		await restarted.process(IDS.delivery);
		expect(harness.adapter.counters.turnsCreated).toBe(1);
		expect(harness.adapter.counters.startTurnCalls).toBe(1);
		expect(harness.adapter.counters.recoverTurnCalls).toBe(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("recovers with the journaled start input after the Relay assignment advances", async () => {
		let crash = true;
		const harness = await createHarness({
			mission: assignment({ peerMessageCount: 1 }),
			onCheckpoint(checkpoint) {
				if (crash && checkpoint === "host_accepted") {
					crash = false;
					throw new Error("injected crash after host acceptance");
				}
			},
		});
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow("injected crash");
		const originalInput = harness.journal.snapshot().deliveries[IDS.delivery]!.start_turn_input!;
		expect(originalInput.peerMessages.map((message) => message.messageId)).toEqual([
			peerMessageId(1),
		]);

		harness.client.mission = assignment({ peerMessageCount: 2 });
		expect(harness.client.mission.coordinator_state.messages).toHaveLength(2);
		let recoveredInput: StartTurnInput | undefined;
		const adapter: AgentHostAdapter = {
			...adapterDelegates(harness.adapter),
			recoverTurn(ref, expectedInput) {
				recoveredInput = structuredClone(expectedInput);
				return harness.adapter.recoverTurn(ref, expectedInput);
			},
		};
		const restarted = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter,
			now: () => new Date(TIMES.renewed),
			preflight: successfulPreflight,
		});

		await restarted.process(IDS.delivery);

		expect(recoveredInput).toEqual(originalInput);
		expect(recoveredInput?.peerMessages).toHaveLength(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("fails closed when a recovered Mission session changes host identity", async () => {
		let crash = true;
		const harness = await createHarness({
			onCheckpoint(checkpoint) {
				if (crash && checkpoint === "host_accepted") {
					crash = false;
					throw new Error("injected crash after host acceptance");
				}
			},
		});
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow("injected crash");
		const changedSessionAdapter: AgentHostAdapter = {
			...adapterDelegates(harness.adapter),
			async ensureSession(input) {
				const session = await harness.adapter.ensureSession(input);
				return { ...session, sessionId: `${session.sessionId}-different` };
			},
		};

		const restarted = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter: changedSessionAdapter,
			now: () => new Date(TIMES.renewed),
			preflight: successfulPreflight,
		});
		await expect(restarted.process(IDS.delivery)).rejects.toThrow(
			"Host session identity changed during durable Mission recovery",
		);

		expect(harness.adapter.counters.recoverTurnCalls).toBe(0);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("host_accepted");
	});

	it("accepts an identical duplicate event within one live host stream", async () => {
		const harness = await createHarness();
		const processor = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter: duplicateAcceptedEvent(harness.adapter),
			now: () => new Date(TIMES.renewed),
			preflight: successfulPreflight,
		});

		await processor.process(IDS.delivery);

		expect(harness.adapter.counters.turnsCreated).toBe(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("passes the newest bounded peer-message tail without poisoning delivery retries", async () => {
		const messageCount = MAX_HOST_PEER_MESSAGES + 2;
		const harness = await createHarness({
			mission: assignment({ peerMessageCount: messageCount }),
		});
		const capturedInputs: StartTurnInput[] = [];
		const adapter: AgentHostAdapter = {
			...adapterDelegates(harness.adapter),
			startTurn(input) {
				capturedInputs.push(structuredClone(input));
				return harness.adapter.startTurn(input);
			},
		};
		const processor = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter,
			now: () => new Date(TIMES.renewed),
			preflight: successfulPreflight,
		});

		await processor.process(IDS.delivery);
		await processor.process(IDS.delivery);

		const selected = capturedInputs[0]?.peerMessages;
		expect(selected).toHaveLength(MAX_HOST_PEER_MESSAGES);
		expect(selected?.map((message) => message.messageId)).toEqual(
			Array.from({ length: MAX_HOST_PEER_MESSAGES }, (_, index) => peerMessageId(index + 3)),
		);
		expect(selected?.[0]).toEqual({
			messageId: peerMessageId(3),
			authorAgentId: IDS.peer,
			kind: "proposal",
			body: "peer message 3",
		});
		expect(selected?.at(-1)).toEqual({
			messageId: peerMessageId(messageCount),
			authorAgentId: IDS.peer,
			kind: "proposal",
			body: `peer message ${messageCount}`,
		});
		expect(harness.adapter.counters.startTurnCalls).toBe(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("replays the exact completion intent after an ambiguous response", async () => {
		const harness = await createHarness();
		harness.client.failFirstCompletion = true;
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow("response lost");

		const pending = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(pending.phase).toBe("complete_intent");
		expect(pending.operation?.kind).toBe("complete");
		await processorFor(harness).process(IDS.delivery);

		expect(harness.client.completeInputs).toHaveLength(2);
		expect(harness.client.completeInputs[1]).toEqual(harness.client.completeInputs[0]);
		expect(harness.adapter.counters.turnsCreated).toBe(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("replays the exact start intent before any later lease mutation", async () => {
		const harness = await createHarness();
		harness.client.loseNextStartResponse = true;

		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow(
			"start committed but response lost",
		);
		const pending = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(pending.phase).toBe("start_intent");
		expect(pending.operation?.kind).toBe("start");

		await processorFor(harness).process(IDS.delivery);

		expect(harness.client.startInputs).toHaveLength(2);
		expect(harness.client.startInputs[1]).toEqual(harness.client.startInputs[0]);
		expect(harness.adapter.counters.turnsCreated).toBe(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("replays an ambiguous renewal before a later policy release", async () => {
		const harness = await createHarness();
		harness.client.loseNextRenewResponse = true;

		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow(
			"renew committed but response lost",
		);
		const pending = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(pending.operation?.kind).toBe("renew");

		const denyingProcessor = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter: harness.adapter,
			now: () => new Date(TIMES.renewed),
			preflight: async () => {
				const { WorkspacePreflightError } = await import("./workspace.js");
				throw new WorkspacePreflightError("workspace_dirty", "workspace is dirty");
			},
		});
		await denyingProcessor.process(IDS.delivery);

		expect(harness.client.renewInputs.length).toBeGreaterThanOrEqual(3);
		expect(harness.client.renewInputs[1]).toEqual(harness.client.renewInputs[0]);
		expect(harness.client.releaseInputs.at(-1)?.classification).toBe("policy_denied");
		expect(harness.adapter.counters.startTurnCalls).toBe(0);
	});

	it("fails closed before host invocation when local workspace policy rejects", async () => {
		const harness = await createHarness({
			preflight: async () => {
				const { WorkspacePreflightError } = await import("./workspace.js");
				throw new WorkspacePreflightError("workspace_dirty", "workspace is dirty");
			},
		});
		await harness.processor.process(IDS.delivery);

		expect(harness.adapter.counters.startTurnCalls).toBe(0);
		expect(harness.client.releaseInputs[0]?.classification).toBe("policy_denied");
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("dead_lettered");
	});

	it("cancels a recovered host turn before a local preflight release", async () => {
		let crash = true;
		const harness = await createHarness({
			outcome: { kind: "pending" },
			onCheckpoint(checkpoint) {
				if (crash && checkpoint === "host_accepted") {
					crash = false;
					throw new Error("injected crash with a pending host turn");
				}
			},
		});
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow(
			"injected crash with a pending host turn",
		);

		const denyingProcessor = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter: harness.adapter,
			now: () => new Date(TIMES.renewed),
			preflight: async () => {
				const { WorkspacePreflightError } = await import("./workspace.js");
				throw new WorkspacePreflightError("workspace_dirty", "workspace is dirty");
			},
		});
		await denyingProcessor.process(IDS.delivery);

		expect(harness.adapter.counters.turnsCancelled).toBe(1);
		expect(harness.adapter.eventsFor(IDS.delivery, 1).at(-1)?.kind).toBe("cancelled");
		expect(harness.client.releaseInputs.at(-1)?.classification).toBe("policy_denied");
	});

	it("cancels a recovered host turn when Mission authority is revoked", async () => {
		let crash = true;
		const harness = await createHarness({
			outcome: { kind: "pending" },
			onCheckpoint(checkpoint) {
				if (crash && checkpoint === "host_accepted") {
					crash = false;
					throw new Error("injected crash before Mission revocation");
				}
			},
		});
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow(
			"injected crash before Mission revocation",
		);
		harness.client.mission = {
			...harness.client.mission,
			coordinator_state: {
				...harness.client.mission.coordinator_state,
				status: "cancelled",
			},
		};

		await processorFor(harness).process(IDS.delivery);

		expect(harness.adapter.counters.turnsCancelled).toBe(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("authority_lost");
	});

	it("cancels a recovered host turn when a fresh executable lease cannot be established", async () => {
		let crash = true;
		const harness = await createHarness({
			outcome: { kind: "pending" },
			onCheckpoint(checkpoint) {
				if (crash && checkpoint === "host_accepted") {
					crash = false;
					throw new Error("injected crash before lease rejection");
				}
			},
		});
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow(
			"injected crash before lease rejection",
		);
		harness.client.failNextRenewWithAuthorityLoss = true;
		harness.client.failNextClaimWithAuthorityLoss = true;

		await processorFor(harness).process(IDS.delivery);

		expect(harness.adapter.counters.turnsCancelled).toBe(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("authority_lost");
	});

	it("fails closed before preflight or host invocation when the accepted policy grant drifts", async () => {
		const original = localConfig();
		const changedConfig: NodeConfig = {
			...original,
			policy_profiles: {
				...original.policy_profiles,
				coding: {
					...original.policy_profiles.coding!,
					max_turn_seconds: 301,
				},
			},
		};
		const preflight = vi.fn(successfulPreflight);
		const harness = await createHarness({ config: changedConfig, preflight });

		await harness.processor.process(IDS.delivery);

		expect(preflight).not.toHaveBeenCalled();
		expect(harness.adapter.counters.startTurnCalls).toBe(0);
		expect(harness.client.releaseInputs[0]?.classification).toBe("policy_denied");
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("dead_lettered");
	});

	it("rejects prototype-named workspace aliases before preflight or host invocation", async () => {
		for (const workspaceAlias of ["toString", "constructor"]) {
			const preflight = vi.fn(successfulPreflight);
			const harness = await createHarness({
				mission: assignment({ workspaceAlias }),
				preflight,
			});

			await harness.processor.process(IDS.delivery);

			expect(preflight).not.toHaveBeenCalled();
			expect(harness.adapter.counters.startTurnCalls).toBe(0);
			expect(harness.client.releaseInputs[0]?.classification).toBe("policy_denied");
			expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("dead_lettered");
		}
	});

	it("keeps a transient release retryable without claiming before its backoff expires", async () => {
		let localNow = new Date("2026-08-02T00:20:00.000Z");
		const harness = await createHarness({ now: () => localNow });
		await harness.processor.claim(IDS.delivery);
		harness.client.transientRelease = true;

		await harness.processor.release(IDS.delivery, "transient", "dependency unavailable");

		const released = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(released.phase).toBe("ingested");
		expect(released.item.delivery.status).toBe("stored");
		await harness.processor.process(IDS.delivery, undefined, new Date("2026-08-02T00:09:00.000Z"));
		expect(harness.client.claimInputs).toHaveLength(1);

		localNow = new Date("2026-08-02T00:03:00.000Z");
		await harness.processor.process(IDS.delivery, undefined, new Date("2026-08-02T00:11:00.000Z"));
		expect(harness.client.claimInputs).toHaveLength(2);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("keeps a server-deferred retry runnable instead of marking authority lost", async () => {
		const harness = await createHarness();
		harness.client.rejectNextClaimUntil = "2026-08-02T00:10:00.000Z";

		await harness.processor.process(IDS.delivery, undefined, new Date("2026-08-02T00:20:00.000Z"));

		const deferred = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(deferred.phase).toBe("ingested");
		expect(deferred.operation).toBeNull();
		expect(deferred.item.delivery.available_at).toBe("2026-08-02T00:10:00.000Z");

		await harness.processor.process(IDS.delivery, undefined, new Date("2026-08-02T00:11:00.000Z"));
		expect(harness.client.claimInputs).toHaveLength(2);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("reclaims an expired executing lease with a new fence and recovers the same host turn", async () => {
		let crash = true;
		const harness = await createHarness({
			onCheckpoint(checkpoint) {
				if (crash && checkpoint === "host_accepted") {
					crash = false;
					throw new Error("injected crash before completion");
				}
			},
		});
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow("injected crash");
		harness.client.failNextRenewWithAuthorityLoss = true;

		await processorFor(harness).process(IDS.delivery);

		expect(harness.client.claimInputs).toHaveLength(2);
		expect(harness.client.completeInputs.at(-1)?.fencing_token).toBe("2");
		expect(harness.adapter.counters.turnsCreated).toBe(1);
		expect(harness.adapter.counters.recoverTurnCalls).toBe(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("replays an ambiguous re-claim before renewing the replacement lease", async () => {
		let crash = true;
		const harness = await createHarness({
			onCheckpoint(checkpoint) {
				if (crash && checkpoint === "host_accepted") {
					crash = false;
					throw new Error("injected crash before re-claim");
				}
			},
		});
		await expect(harness.processor.process(IDS.delivery)).rejects.toThrow(
			"injected crash before re-claim",
		);
		harness.client.failNextRenewWithAuthorityLoss = true;
		harness.client.loseNextClaimResponse = true;

		await expect(processorFor(harness).process(IDS.delivery)).rejects.toThrow(
			"claim committed but response lost",
		);
		const pending = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(pending.phase).toBe("claim_intent");
		expect(pending.operation?.kind).toBe("claim");
		const pendingInput = structuredClone(pending.operation?.input);

		await processorFor(harness).process(IDS.delivery);

		expect(harness.client.claimInputs).toHaveLength(3);
		expect(harness.client.claimInputs[2]).toEqual(pendingInput);
		expect(harness.client.completeInputs.at(-1)?.fencing_token).toBe("2");
		expect(harness.adapter.counters.turnsCreated).toBe(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("preserves a transient host failure as a Relay-backed retry", async () => {
		const harness = await createHarness({
			outcome: {
				kind: "failed",
				failure: { class: "transient", message: "host temporarily unavailable" },
			},
		});
		harness.client.transientRelease = true;
		harness.adapter.queueOutcome({
			kind: "completed",
			disposition: { kind: "reply", message_type: "progress", message: "retry succeeded" },
		});

		await harness.processor.process(IDS.delivery);

		expect(harness.client.releaseInputs.at(-1)?.classification).toBe("transient");
		const released = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(released.phase).toBe("ingested");
		expect(released.execution_attempt).toBe(2);
		expect(released.start_turn_input).toBeNull();
		expect(released.host_attempt_history).toHaveLength(1);
		expect(released.host_attempt_history[0]?.start_input_sha256).toMatch(/^[a-f0-9]{64}$/);

		await processorFor(harness).process(
			IDS.delivery,
			undefined,
			new Date("2026-08-02T00:11:00.000Z"),
		);

		expect(harness.adapter.counters.turnsCreated).toBe(2);
		const completed = harness.journal.snapshot().deliveries[IDS.delivery]!;
		expect(completed.phase).toBe("acknowledged");
		expect(completed.start_turn_input?.executionAttempt).toBe(2);
	});

	it("recovers after release authority is lost instead of replaying a poison intent forever", async () => {
		const harness = await createHarness({
			preflight: async () => {
				const { WorkspacePreflightError } = await import("./workspace.js");
				throw new WorkspacePreflightError("workspace_dirty", "workspace is dirty");
			},
		});
		harness.client.failNextReleaseWithAuthorityLoss = true;

		await harness.processor.process(IDS.delivery);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("lease_lost");
		await harness.processor.process(IDS.delivery);

		expect(harness.client.claimInputs).toHaveLength(2);
		expect(harness.client.releaseInputs).toHaveLength(2);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("dead_lettered");
	});

	it("reclaims stale start authority without starving the queue", async () => {
		const harness = await createHarness();
		harness.client.failNextStartWithAuthorityLoss = true;

		await harness.processor.process(IDS.delivery);

		expect(harness.client.claimInputs).toHaveLength(2);
		expect(harness.adapter.counters.turnsCreated).toBe(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("acknowledged");
	});

	it("settles a recovered adapter cancellation through transient Relay release", async () => {
		const harness = await createHarness({ outcome: { kind: "pending" } });
		const crashing = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter: harness.adapter,
			now: () => new Date(TIMES.renewed),
			preflight: successfulPreflight,
			onCheckpoint: async (checkpoint, deliveryId) => {
				if (checkpoint !== "host_accepted") return;
				const executionAttempt =
					harness.journal.snapshot().deliveries[deliveryId]!.execution_attempt;
				const turn = await harness.adapter.lookupTurn(deliveryId, executionAttempt);
				if (turn === null) throw new Error("expected accepted fake turn");
				await harness.adapter.cancelTurn(turn);
				throw new Error("restart after external cancellation");
			},
		});
		await expect(crashing.process(IDS.delivery)).rejects.toThrow(
			"restart after external cancellation",
		);
		harness.client.transientRelease = true;

		await processorFor(harness).process(IDS.delivery);

		expect(harness.client.releaseInputs.at(-1)?.classification).toBe("transient");
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("ingested");
	});

	it("cancels a pending host turn and returns when shutdown is requested", async () => {
		const controller = new AbortController();
		const harness = await createHarness({
			outcome: { kind: "pending" },
			onCheckpoint(checkpoint) {
				if (checkpoint === "host_accepted") controller.abort();
			},
		});

		await harness.processor.process(IDS.delivery, controller.signal);

		expect(harness.adapter.counters.cancelTurnCalls).toBe(1);
		expect(harness.adapter.counters.turnsCancelled).toBe(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("host_accepted");
	});

	it("does not start a host turn when shutdown arrives during adapter setup", async () => {
		const controller = new AbortController();
		const harness = await createHarness();
		const adapter = abortAfterProbe(harness.adapter, controller);
		const processor = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter,
			now: () => new Date(TIMES.renewed),
			preflight: successfulPreflight,
		});

		await processor.process(IDS.delivery, controller.signal);

		expect(harness.adapter.counters.startTurnCalls).toBe(0);
	});

	it("persists an in-flight claim response but starts no later Relay or host request", async () => {
		const controller = new AbortController();
		const harness = await createHarness();
		harness.client.afterClaimResponse = () => controller.abort();

		await expect(harness.processor.process(IDS.delivery, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});

		expect(harness.journal.snapshot().deliveries[IDS.delivery]).toMatchObject({
			phase: "claimed",
			item: { delivery: { status: "leased" } },
		});
		expect(harness.client.assignmentCalls).toBe(0);
		expect(harness.client.renewInputs).toHaveLength(0);
		expect(harness.client.startInputs).toHaveLength(0);
		expect(harness.adapter.counters.startTurnCalls).toBe(0);
	});

	it("starts no preflight or lease request after an in-flight assignment lookup finishes", async () => {
		const controller = new AbortController();
		const harness = await createHarness();
		const preflight = vi.fn(successfulPreflight);
		harness.client.afterAssignmentResponse = () => controller.abort();
		const processor = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter: harness.adapter,
			now: () => new Date(TIMES.renewed),
			preflight,
		});

		await expect(processor.process(IDS.delivery, controller.signal)).rejects.toMatchObject({
			name: "AbortError",
		});

		expect(harness.client.assignmentCalls).toBe(1);
		expect(preflight).not.toHaveBeenCalled();
		expect(harness.client.renewInputs).toHaveLength(0);
		expect(harness.client.startInputs).toHaveLength(0);
		expect(harness.adapter.counters.startTurnCalls).toBe(0);
	});

	it("escapes a stalled host iterator when lease renewal fails", async () => {
		const harness = await createHarness({ outcome: { kind: "pending" } });
		harness.client.renewalExpiresAt = "2026-08-02T00:03:00.300Z";
		harness.client.failRenewAtCall = 3;
		const processor = new DeliveryProcessor({
			config: harness.config,
			client: harness.client,
			journal: harness.journal,
			adapter: stallHostStream(harness.adapter),
			now: () => new Date(TIMES.renewed),
			preflight: successfulPreflight,
		});

		await expect(processor.process(IDS.delivery)).rejects.toThrow("renew transport down");

		expect(harness.adapter.counters.cancelTurnCalls).toBe(1);
		expect(harness.journal.snapshot().deliveries[IDS.delivery]?.phase).toBe("host_accepted");
	});
});

interface HarnessOptions {
	readonly onCheckpoint?: (checkpoint: DeliveryCheckpoint) => void | Promise<void>;
	readonly preflight?: typeof successfulPreflight;
	readonly now?: () => Date;
	readonly outcome?: FakeTurnOutcome;
	readonly config?: NodeConfig;
	readonly mission?: NodeMissionAssignment;
}

async function createHarness(options: HarnessOptions = {}) {
	const storage = new MemoryStorage();
	const journal = await NodeJournal.open(storage);
	await journal.ingestCursorPage([storedItem()], "1", new Date(TIMES.created));
	const client = new FakeRelayClient(options.mission ?? assignment());
	const adapter = new FakeAgentHostAdapter();
	adapter.queueOutcome(
		options.outcome ?? {
			kind: "completed",
			disposition: { kind: "reply", message_type: "progress", message: "fake result" },
		},
	);
	const harness = { config: options.config ?? localConfig(), client, adapter, journal, storage };
	return {
		...harness,
		processor: new DeliveryProcessor({
			...harness,
			now: options.now ?? (() => new Date(TIMES.renewed)),
			preflight: options.preflight ?? successfulPreflight,
			onCheckpoint: options.onCheckpoint
				? (checkpoint) => options.onCheckpoint?.(checkpoint)
				: undefined,
		}),
	};
}

function processorFor(harness: Awaited<ReturnType<typeof createHarness>>): DeliveryProcessor {
	return new DeliveryProcessor({
		config: harness.config,
		client: harness.client,
		journal: harness.journal,
		adapter: harness.adapter,
		now: () => new Date(TIMES.renewed),
		preflight: successfulPreflight,
	});
}

function duplicateAcceptedEvent(delegate: AgentHostAdapter): AgentHostAdapter {
	return {
		probe: () => delegate.probe(),
		ensureSession: (input) => delegate.ensureSession(input),
		lookupTurn: (deliveryId, executionAttempt) => delegate.lookupTurn(deliveryId, executionAttempt),
		startTurn: (input) => duplicateAccepted(delegate.startTurn(input)),
		recoverTurn: (ref, expectedInput) => delegate.recoverTurn(ref, expectedInput),
		cancelTurn: (ref) => delegate.cancelTurn(ref),
	};
}

function abortAfterProbe(
	delegate: AgentHostAdapter,
	controller: AbortController,
): AgentHostAdapter {
	return {
		...adapterDelegates(delegate),
		async probe() {
			const result = await delegate.probe();
			controller.abort();
			return result;
		},
	};
}

function stallHostStream(delegate: AgentHostAdapter): AgentHostAdapter {
	return {
		...adapterDelegates(delegate),
		startTurn: (input) => stallAfterReplay(delegate.startTurn(input)),
		recoverTurn: (ref, expectedInput) => stallAfterReplay(delegate.recoverTurn(ref, expectedInput)),
	};
}

function adapterDelegates(delegate: AgentHostAdapter): AgentHostAdapter {
	return {
		probe: () => delegate.probe(),
		ensureSession: (input) => delegate.ensureSession(input),
		lookupTurn: (deliveryId, executionAttempt) => delegate.lookupTurn(deliveryId, executionAttempt),
		startTurn: (input) => delegate.startTurn(input),
		recoverTurn: (ref, expectedInput) => delegate.recoverTurn(ref, expectedInput),
		cancelTurn: (ref) => delegate.cancelTurn(ref),
	};
}

async function* stallAfterReplay(stream: AsyncIterable<HostEvent>): AsyncIterable<HostEvent> {
	for await (const event of stream) yield event;
	await new Promise<never>(() => undefined);
}

async function* duplicateAccepted(stream: AsyncIterable<HostEvent>): AsyncIterable<HostEvent> {
	for await (const event of stream) {
		yield event;
		if (event.kind === "accepted") yield structuredClone(event);
	}
}

async function successfulPreflight() {
	return {
		root: "/tmp/agentrelay-backend",
		repository_url: "https://github.com/acme/backend.git",
		head_commit: "1".repeat(40),
		reachable_from_ref: "refs/heads/main",
		clean: true as const,
	};
}

class MemoryStorage implements JournalStorage {
	state: NodeJournalState | null = null;
	async load(): Promise<unknown | null> {
		return structuredClone(this.state);
	}
	async save(state: NodeJournalState): Promise<void> {
		this.state = structuredClone(state);
	}
}

class FakeRelayClient implements NodeRelayClient {
	readonly claimInputs: DeliveryClaimInput[] = [];
	readonly startInputs: DeliveryStartInput[] = [];
	readonly renewInputs: DeliveryRenewInput[] = [];
	readonly completeInputs: DeliveryCompleteInput[] = [];
	readonly releaseInputs: DeliveryReleaseInput[] = [];
	failFirstCompletion = false;
	transientRelease = false;
	failNextClaimWithAuthorityLoss = false;
	failNextRenewWithAuthorityLoss = false;
	failNextReleaseWithAuthorityLoss = false;
	failNextStartWithAuthorityLoss = false;
	loseNextClaimResponse = false;
	loseNextStartResponse = false;
	loseNextRenewResponse = false;
	rejectNextClaimUntil: string | null = null;
	renewalExpiresAt: string = TIMES.expires;
	failRenewAtCall: number | null = null;
	afterClaimResponse: (() => void) | null = null;
	afterAssignmentResponse: (() => void) | null = null;
	assignmentCalls = 0;
	activeStatus: "leased" | "executing" = "leased";
	#claimResults = new Map<string, DeliveryClaimResult>();
	#startResults = new Map<string, DeliveryStartResult>();
	#renewResults = new Map<string, DeliveryRenewResult>();

	constructor(public mission: NodeMissionAssignment) {}

	async getAssignment(): Promise<NodeMissionAssignment> {
		this.assignmentCalls += 1;
		const result = structuredClone(this.mission);
		this.afterAssignmentResponse?.();
		return result;
	}

	async claim(_deliveryId: string, input: DeliveryClaimInput): Promise<DeliveryClaimResult> {
		this.claimInputs.push(structuredClone(input));
		if (this.failNextClaimWithAuthorityLoss) {
			this.failNextClaimWithAuthorityLoss = false;
			throw authorityLostError();
		}
		if (this.rejectNextClaimUntil !== null) {
			const availableAt = this.rejectNextClaimUntil;
			this.rejectNextClaimUntil = null;
			throw new RelayHttpError(409, "state_changed", "retry is not available", "req_test", {
				available_at: availableAt,
			});
		}
		const replayed = this.#claimResults.get(input.idempotency_key);
		if (replayed !== undefined) return { ...structuredClone(replayed), replayed: true };
		const attempt = this.#claimResults.size + 1;
		this.activeStatus = "leased";
		const result: DeliveryClaimResult = {
			outcome: "claimed",
			item: { ...storedItem(), delivery: leasedDelivery(attempt) },
			receipt: {} as DeliveryClaimResult["receipt"],
			replayed: false,
		};
		this.#claimResults.set(input.idempotency_key, structuredClone(result));
		if (this.loseNextClaimResponse) {
			this.loseNextClaimResponse = false;
			throw new Error("claim committed but response lost");
		}
		this.afterClaimResponse?.();
		return result;
	}

	async start(_deliveryId: string, input: DeliveryStartInput): Promise<DeliveryStartResult> {
		this.startInputs.push(structuredClone(input));
		if (this.failNextStartWithAuthorityLoss) {
			this.failNextStartWithAuthorityLoss = false;
			throw authorityLostError();
		}
		const replayed = this.#startResults.get(input.idempotency_key);
		if (replayed !== undefined) return { ...structuredClone(replayed), replayed: true };
		this.activeStatus = "executing";
		const result: DeliveryStartResult = {
			delivery: executingDelivery(Number(input.fencing_token)),
			receipt: {} as never,
			replayed: false,
		};
		this.#startResults.set(input.idempotency_key, structuredClone(result));
		if (this.loseNextStartResponse) {
			this.loseNextStartResponse = false;
			throw new Error("start committed but response lost");
		}
		return result;
	}

	async renew(_deliveryId: string, input: DeliveryRenewInput): Promise<DeliveryRenewResult> {
		this.renewInputs.push(structuredClone(input));
		if (this.failRenewAtCall === this.renewInputs.length) {
			throw new Error("renew transport down");
		}
		if (this.failNextRenewWithAuthorityLoss) {
			this.failNextRenewWithAuthorityLoss = false;
			throw authorityLostError();
		}
		const replayed = this.#renewResults.get(input.idempotency_key);
		if (replayed !== undefined) return { ...structuredClone(replayed), replayed: true };
		const result: DeliveryRenewResult = {
			delivery: renewedDelivery(
				Number(input.fencing_token),
				this.activeStatus,
				this.renewalExpiresAt,
			),
			receipt: {
				recorded_at: TIMES.renewed,
				lease_expires_at: this.renewalExpiresAt,
			} as never,
			replayed: false,
		};
		this.#renewResults.set(input.idempotency_key, structuredClone(result));
		if (this.loseNextRenewResponse) {
			this.loseNextRenewResponse = false;
			throw new Error("renew committed but response lost");
		}
		return result;
	}

	async complete(
		_deliveryId: string,
		input: DeliveryCompleteInput,
	): Promise<DeliveryCompleteResult> {
		this.completeInputs.push(structuredClone(input));
		if (this.failFirstCompletion && this.completeInputs.length === 1) {
			throw new Error("completion committed but response lost");
		}
		return {
			delivery: acknowledgedDelivery(Number(input.fencing_token)),
			receipt: {} as never,
			events: [{}] as never,
			derived_delivery_ids: [],
			replayed: this.completeInputs.length > 1,
		};
	}

	async release(_deliveryId: string, input: DeliveryReleaseInput): Promise<DeliveryReleaseResult> {
		this.releaseInputs.push(structuredClone(input));
		if (this.failNextReleaseWithAuthorityLoss) {
			this.failNextReleaseWithAuthorityLoss = false;
			throw authorityLostError();
		}
		const attempt = Number(input.fencing_token);
		return {
			delivery: this.transientRelease
				? storedAfterTransientRelease(attempt)
				: deadLetteredDelivery(attempt),
			receipt: {} as never,
			replayed: false,
		};
	}

	async me(): Promise<NodeSelfResult> {
		throw new Error("not used");
	}
	async registerWorkspace(
		_input: WorkspaceRegistrationInput,
	): Promise<WorkspaceRegistrationResult> {
		throw new Error("not used");
	}
	async listWorkspaces(): Promise<WorkspaceBindingList> {
		throw new Error("not used");
	}
	async listAssignments(
		_status?: MissionStatus,
		_afterCursor?: string | null,
		_limit?: number,
	): Promise<NodeMissionAssignmentList> {
		throw new Error("not used");
	}
	async acceptAssignment(
		_missionId: string,
		_input: MissionParticipantAcceptanceInput,
	): Promise<MissionParticipantAcceptanceResult> {
		throw new Error("not used");
	}
	async pollDeliveries(): Promise<StoredMissionDeliveryCursorPage> {
		throw new Error("not used");
	}
	async recoverDeliveries(): Promise<RecoverableMissionDeliveryPage> {
		throw new Error("not used");
	}
}

function localConfig(): NodeConfig {
	return {
		schema_version: 1,
		relay_url: "https://relay.example.com",
		node: {
			node_id: IDS.node,
			agent_id: IDS.agent,
			credential_id: IDS.credential,
			token: `ar_node_test_${"a".repeat(32)}`,
		},
		workspaces: {
			backend: {
				path: "/tmp/agentrelay-backend",
				repository_url: "https://github.com/acme/backend.git",
				allowed_base_refs: ["refs/heads/main"],
				policy_profile: "coding",
			},
		},
		policy_profiles: {
			coding: {
				max_turn_seconds: 300,
				max_reported_tokens: 10_000,
				network_access: "denied",
				verification_commands: {},
			},
		},
	};
}

function assignment(
	options: { readonly workspaceAlias?: string; readonly peerMessageCount?: number } = {},
): NodeMissionAssignment {
	const config = localConfig();
	const acceptedPolicy = resolvePolicyProfile(config.policy_profiles, "coding");
	const contract = {
		artifact_id: IDS.artifact,
		type: "api_contract",
		version: 1 as const,
		sha256: "a".repeat(64),
		media_type: "application/json",
		byte_size: 2,
	};
	const coordinatorConfig = {
		mission_context: {
			manifest: {
				schema_version: 1 as const,
				mission_id: IDS.mission,
				objective: "Ship a compatible backend and client.",
				public_acceptance_criteria: ["Both repositories pass."],
				participants: [
					{
						agent_id: IDS.agent,
						role: "backend",
						workspace_alias: options.workspaceAlias ?? "backend",
						repository_url: "https://github.com/acme/backend.git",
						expected_base_commit: "1".repeat(40),
						initial_assignment: "Implement the backend.",
						requested_local_policy_profile: "coding",
					},
					{
						agent_id: IDS.peer,
						role: "client",
						workspace_alias: "client",
						repository_url: "https://github.com/acme/client.git",
						expected_base_commit: "2".repeat(40),
						initial_assignment: "Implement the client.",
						requested_local_policy_profile: "coding",
					},
				],
				shared_contract: contract,
				max_turns: 10,
				max_wall_time_seconds: 3_600,
				token_budget: 100_000,
				expires_at: "2026-08-03T00:00:00.000Z",
				allowed_artifact_types: ["api_contract"],
				created_at: TIMES.created,
			},
			created_by: { principal_id: IDS.owner, kind: "owner" as const },
		},
		required_verification_commands: {
			[IDS.agent]: ["test"],
			[IDS.peer]: ["test"],
		},
	};
	let state = createMissionCoordinatorState(coordinatorConfig);
	state = reduceMissionCoordinatorEvent(state, storedItem().event);
	state = {
		...state,
		messages: Array.from({ length: options.peerMessageCount ?? 0 }, (_, index) =>
			peerMessage(index + 1),
		),
	};
	return nodeMissionAssignmentSchema.parse({
		mission_id: IDS.mission,
		coordinator_config: coordinatorConfig,
		coordinator_state: state,
		participant_agent_id: IDS.agent,
		workspace_binding_id: IDS.binding,
		acceptance_status: "accepted",
		acceptance_receipt: {
			mission_id: IDS.mission,
			participant_agent_id: IDS.agent,
			idempotency_key: "accept:local",
			contract,
			local_policy_grant: acceptedPolicy.grant,
			accepted_at: TIMES.created,
		},
	});
}

function peerMessage(index: number) {
	return {
		message_id: peerMessageId(index),
		mission_id: IDS.mission,
		sequence_no: index,
		author_agent_id: IDS.peer,
		type: "proposal" as const,
		body: `peer message ${index}`,
		artifacts: [],
		contract_version: 1,
		idempotency_key: `peer:${index}`,
		causal_parent_message_id: index === 1 ? null : peerMessageId(index - 1),
		created_at: new Date(Date.parse(TIMES.created) + index * 1_000).toISOString(),
	};
}

function peerMessageId(index: number): string {
	return `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function storedItem(): MissionDeliveryItem {
	return {
		delivery: baseDelivery(),
		event: {
			type: "participants_accepted",
			event_id: IDS.event,
			idempotency_key: "participants:accepted",
			mission_id: IDS.mission,
			sequence_no: 1,
			created_at: TIMES.created,
			participant_agent_ids: [IDS.agent, IDS.peer],
			contract: {
				artifact_id: IDS.artifact,
				type: "api_contract",
				version: 1,
				sha256: "a".repeat(64),
				media_type: "application/json",
				byte_size: 2,
			},
		},
		actor_agent_id: IDS.owner,
		source_delivery_id: null,
		causal_parent_event_id: null,
	};
}

function baseDelivery(): Delivery {
	return {
		delivery_id: IDS.delivery,
		node_id: IDS.node,
		mission_id: IDS.mission,
		mission_event_id: IDS.event,
		kind: "turn",
		cursor: "1",
		status: "stored",
		attempt_count: 0,
		max_attempts: 3,
		last_fencing_token: "0",
		contract_version: 1,
		verification_round: null,
		lease: null,
		logical_settlement: null,
		idempotency_key: "delivery:1",
		causal_parent_delivery_id: null,
		available_at: TIMES.created,
		created_at: TIMES.created,
		updated_at: TIMES.created,
		acknowledged_at: null,
		cancelled_at: null,
		cancellation_reason: null,
		dead_lettered_at: null,
	};
}

function leasedDelivery(attempt = 1): Delivery {
	return {
		...baseDelivery(),
		status: "leased",
		attempt_count: attempt,
		last_fencing_token: String(attempt),
		lease: {
			lease_id: leaseId(attempt),
			fencing_token: String(attempt),
			expires_at: TIMES.expires,
		},
		updated_at: TIMES.claimed,
	};
}

function executingDelivery(attempt = 1): Delivery {
	return { ...leasedDelivery(attempt), status: "executing", updated_at: TIMES.started };
}

function renewedDelivery(
	attempt = 1,
	status: "leased" | "executing" = "executing",
	expiresAt = TIMES.expires,
): Delivery {
	return {
		...(status === "leased" ? leasedDelivery(attempt) : executingDelivery(attempt)),
		lease: { ...leasedDelivery(attempt).lease!, expires_at: expiresAt },
		updated_at: TIMES.renewed,
	};
}

function acknowledgedDelivery(attempt = 1): Delivery {
	return {
		...renewedDelivery(attempt),
		status: "acknowledged",
		lease: null,
		logical_settlement: { settled_by_event_id: IDS.settlement, settled_at: TIMES.completed },
		updated_at: TIMES.completed,
		acknowledged_at: TIMES.completed,
	};
}

function deadLetteredDelivery(attempt = 1): Delivery {
	return {
		...renewedDelivery(attempt),
		status: "dead_lettered",
		lease: null,
		updated_at: TIMES.completed,
		dead_lettered_at: TIMES.completed,
	};
}

function storedAfterTransientRelease(attempt = 1): Delivery {
	return {
		...baseDelivery(),
		attempt_count: attempt,
		last_fencing_token: String(attempt),
		available_at: "2026-08-02T00:10:00.000Z",
		updated_at: TIMES.completed,
	};
}

function leaseId(attempt: number): string {
	return `30000000-0000-4000-8000-${String(attempt).padStart(12, "0")}`;
}

function authorityLostError(): RelayHttpError {
	return new RelayHttpError(409, "state_changed", "lease expired", "req_test", {});
}
