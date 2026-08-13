import { type ChildProcess, execFile as execFileCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	realpath,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
	type DeliveryCompleteResult,
	type HostEvent,
	hostEventSchema,
	missionCreationResultSchema,
	nodeEnrollmentResultSchema,
	startTurnInputSchema,
} from "@agentrelay/protocol";
import { FakeAgentHostAdapter } from "@agentrelay/protocol/testing";
import {
	CAPSULE_STATE_FILE,
	type CapsuleLaunchDescriptor,
	DeliveryProcessor,
	ForegroundNode,
	NodeJournal,
	type NodeJournalState,
	type NodeRelayClient,
	PersistentFakeCapsuleAdapter,
	createFileJournalStorage,
	createNodeRelayClient,
	nodeConfigSchema,
	nodeJournalStateSchema,
	readCapsuleLaunchDescriptor,
	syncDirectory,
	writeNodeConfig,
} from "agentrelay-node";
import { request, fetch as undiciFetch } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT, TestRelay } from "./harness.js";

const execFile = promisify(execFileCallback);
const NODE_BIN_PATH = join(REPO_ROOT, "node", "dist", "bin", "agentrelay-node.js");

describe("foreground Node delivery", () => {
	let relay: TestRelay;
	let temporaryRoot: string;

	beforeAll(async () => {
		temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "agentrelay-node-e2e-")));
		relay = await TestRelay.boot({ port: 18083 });
	}, 30_000);

	afterAll(async () => {
		await relay?.stop();
		await rm(temporaryRoot, { recursive: true, force: true });
	});

	it("acknowledges one real Relay delivery and suppresses duplicates after runner reconstruction", async () => {
		const backend = await relay.createAgent({
			handle: "node-backend@e2e",
			email: "node-backend@example.com",
			name: "Node Backend",
			role: "backend",
		});
		const client = await relay.createAgent({
			handle: "node-client@e2e",
			email: "node-client@example.com",
			name: "Node Client",
			role: "client",
		});
		const backendNode = await enrollNode(relay.baseUrl, backend.api_key, "backend-machine");
		const clientNode = await enrollNode(relay.baseUrl, client.api_key, "client-machine");
		const backendRepo = await createRepository(
			join(temporaryRoot, "backend"),
			"https://github.com/acme/node-backend.git",
		);
		const clientRepo = await createRepository(
			join(temporaryRoot, "client"),
			"https://github.com/acme/node-client.git",
		);

		const backendConfig = nodeConfigSchema.parse(
			localConfig(relay.baseUrl, backend.agent_id, backendNode, "backend", backendRepo),
		);
		const clientConfig = nodeConfigSchema.parse(
			localConfig(relay.baseUrl, client.agent_id, clientNode, "client", clientRepo),
		);
		const backendJournalPath = join(temporaryRoot, "backend-state", "journal.json");
		const clientJournalPath = join(temporaryRoot, "client-state", "journal.json");
		const backendJournal = await NodeJournal.open(createFileJournalStorage(backendJournalPath));
		const clientJournal = await NodeJournal.open(createFileJournalStorage(clientJournalPath));
		const backendAdapter = new FakeAgentHostAdapter();
		backendAdapter.queueOutcome({
			kind: "completed",
			disposition: {
				kind: "reply",
				message_type: "progress",
				message: "Backend fake runtime completed its bounded turn.",
			},
		});
		const clientAdapter = new FakeAgentHostAdapter();
		clientAdapter.queueOutcome({
			kind: "completed",
			disposition: {
				kind: "reply",
				message_type: "progress",
				message: "Client fake runtime recovered its bounded turn.",
			},
		});
		const backendRelayClient = createNodeRelayClient({
			relayUrl: relay.baseUrl,
			credential: backendNode.credential.token,
		});
		const clientRelayClient = createNodeRelayClient({
			relayUrl: relay.baseUrl,
			credential: clientNode.credential.token,
		});
		const backendDaemon = new ForegroundNode({
			config: backendConfig,
			client: backendRelayClient,
			journal: backendJournal,
			adapter: backendAdapter,
		});
		const clientDaemon = new ForegroundNode({
			config: clientConfig,
			client: clientRelayClient,
			journal: clientJournal,
			adapter: clientAdapter,
		});
		await backendDaemon.initialize();
		await clientDaemon.initialize();

		const missionId = randomUUID();
		await createMission(relay.baseUrl, backend.api_key, {
			missionId,
			backendAgentId: backend.agent_id,
			clientAgentId: client.agent_id,
			backendCommit: backendRepo.commit,
			clientCommit: clientRepo.commit,
			backendUrl: backendRepo.url,
			clientUrl: clientRepo.url,
		});

		expect((await backendDaemon.runCycle()).acceptedMissions).toBe(1);
		expect((await clientDaemon.runCycle()).acceptedMissions).toBe(1);
		const completedCycle = await backendDaemon.runCycle();
		expect(completedCycle.processedDeliveryId).not.toBeNull();
		const completedDeliveryId = completedCycle.processedDeliveryId!;
		expect(backendJournal.snapshot().deliveries[completedDeliveryId]?.phase).toBe("acknowledged");
		expect(backendAdapter.counters.turnsCreated).toBe(1);

		await backendDaemon.runCycle();
		const reopenedJournal = await NodeJournal.open(createFileJournalStorage(backendJournalPath));
		const restartedDaemon = new ForegroundNode({
			config: backendConfig,
			client: backendRelayClient,
			journal: reopenedJournal,
			adapter: backendAdapter,
		});
		await restartedDaemon.runCycle();

		expect(reopenedJournal.snapshot().deliveries[completedDeliveryId]?.phase).toBe("acknowledged");
		expect(backendAdapter.counters.turnsCreated).toBe(1);

		const clientPage = await clientRelayClient.pollDeliveries(clientJournal.snapshot().cursor);
		await clientJournal.ingestCursorPage(clientPage.items, clientPage.next_cursor);
		const clientDeliveryId = clientPage.items[0]?.delivery.delivery_id;
		expect(clientDeliveryId).toBeDefined();
		let crashAfterAcceptance = true;
		const crashingProcessor = new DeliveryProcessor({
			config: clientConfig,
			client: clientRelayClient,
			journal: clientJournal,
			adapter: clientAdapter,
			onCheckpoint(checkpoint) {
				if (crashAfterAcceptance && checkpoint === "host_accepted") {
					crashAfterAcceptance = false;
					throw new Error("injected e2e crash after host acceptance");
				}
			},
		});
		await expect(crashingProcessor.process(clientDeliveryId!)).rejects.toThrow(
			"injected e2e crash",
		);
		await new DeliveryProcessor({
			config: clientConfig,
			client: clientRelayClient,
			journal: clientJournal,
			adapter: clientAdapter,
		}).process(clientDeliveryId!);

		expect(clientAdapter.counters.turnsCreated).toBe(1);
		expect(clientAdapter.counters.recoverTurnCalls).toBe(1);
		expect(clientJournal.snapshot().deliveries[clientDeliveryId!]?.phase).toBe("acknowledged");
		const assignment = await backendRelayClient.getAssignment(missionId);
		expect(assignment.coordinator_state.turn_count).toBe(2);
		expect(assignment.coordinator_state.messages).toHaveLength(2);
	}, 30_000);

	it("replays a committed completion after Relay and Node restarts without duplicating work", async () => {
		const fixture = await createDurableReplayFixture(relay, temporaryRoot, "completion-replay");
		const {
			backend,
			backendNode,
			backendConfig,
			backendJournalPath,
			backendAdapter,
			backendRelayClient,
		} = fixture;
		backendAdapter.queueOutcome({
			kind: "completed",
			disposition: {
				kind: "reply",
				message_type: "progress",
				message: "Replay survived both process boundaries.",
			},
		});
		const missionId = await acceptReplayMission(relay, fixture, 1);

		// The delivery exists only in Postgres when the Relay process exits.
		const discovery = await restartAndDiscoverStoredDelivery(relay, fixture);
		const { deliveryId, journal: journalAfterNodeRestart, persistedCursor } = discovery;

		let failAfterClaim = true;
		await expect(
			new DeliveryProcessor({
				config: backendConfig,
				client: backendRelayClient,
				journal: journalAfterNodeRestart,
				adapter: backendAdapter,
				onCheckpoint(checkpoint) {
					if (failAfterClaim && checkpoint === "claimed") {
						failAfterClaim = false;
						throw new Error("injected disconnect after durable claim");
					}
				},
			}).process(deliveryId),
		).rejects.toThrow("injected disconnect after durable claim");
		expect(backendAdapter.counters.turnsCreated).toBe(0);

		await relay.restart();
		const journalAfterClaimRestart = await NodeJournal.open(
			createFileJournalStorage(backendJournalPath),
		);
		const cursorAfterClaim = await backendRelayClient.pollDeliveries(persistedCursor);
		expect(cursorAfterClaim.items).toHaveLength(0);
		const recoveredAfterClaim = await backendRelayClient.recoverDeliveries();
		expect(recoveredAfterClaim.items.map((item) => item.delivery.delivery_id)).toContain(
			deliveryId,
		);
		await journalAfterClaimRestart.ingestRecoverable(recoveredAfterClaim.items);

		let completionResponseLost = true;
		const lossyClient = createNodeRelayClient({
			relayUrl: relay.baseUrl,
			credential: backendNode.credential.token,
			maxAttempts: 1,
			fetch: async (input, init) => {
				const response = await undiciFetch(input, init);
				if (
					completionResponseLost &&
					String(input).endsWith(`/deliveries/${deliveryId}/complete`) &&
					response.ok
				) {
					completionResponseLost = false;
					await response.arrayBuffer();
					throw new Error("injected loss after committed completion");
				}
				return response;
			},
		});
		await expect(
			new DeliveryProcessor({
				config: backendConfig,
				client: lossyClient,
				journal: journalAfterClaimRestart,
				adapter: backendAdapter,
			}).process(deliveryId),
		).rejects.toThrow("injected loss after committed completion");
		expect(backendAdapter.counters.turnsCreated).toBe(1);
		const pendingCompletion = journalAfterClaimRestart.snapshot().deliveries[deliveryId]?.operation;
		if (pendingCompletion?.kind !== "complete") {
			throw new Error("Node did not preserve its ambiguous completion intent");
		}

		await relay.restart();
		const journalAfterCompletionRestart = await NodeJournal.open(
			createFileJournalStorage(backendJournalPath),
		);
		const replayedCompletions: DeliveryCompleteResult[] = [];
		const recordingClient: NodeRelayClient = {
			...backendRelayClient,
			complete: async (id, input) => {
				const result = await backendRelayClient.complete(id, input);
				replayedCompletions.push(result);
				return result;
			},
		};
		await new DeliveryProcessor({
			config: backendConfig,
			client: recordingClient,
			journal: journalAfterCompletionRestart,
			adapter: backendAdapter,
		}).process(deliveryId);
		const replayedCompletion = replayedCompletions[0];
		if (replayedCompletion === undefined)
			throw new Error("Node did not replay its completion intent");
		expect(replayedCompletion.replayed).toBe(true);
		expect(journalAfterCompletionRestart.snapshot().deliveries[deliveryId]?.phase).toBe(
			"acknowledged",
		);
		expect(backendAdapter.counters.turnsCreated).toBe(1);

		const secondReplay = await backendRelayClient.complete(deliveryId, pendingCompletion.input);
		expect(secondReplay).toEqual(replayedCompletion);
		await expect(
			backendRelayClient.complete(deliveryId, {
				...pendingCompletion.input,
				idempotency_key: `late:${randomUUID()}`,
			}),
		).rejects.toMatchObject({ status: 409, code: "invalid_transition" });

		const assignment = await backendRelayClient.getAssignment(missionId);
		expect(assignment.coordinator_state).toMatchObject({ status: "failed", turn_count: 1 });
		expect(assignment.coordinator_state.messages).toHaveLength(1);
		const auditResponse = (await getJson(
			`${relay.baseUrl}/agents/me/audit?action=delivery.complete&limit=100`,
			backend.api_key,
		)) as { events?: { action: string; resource_id: string }[] };
		if (!Array.isArray(auditResponse.events)) throw new Error("Audit response is missing events");
		expect(
			auditResponse.events.filter(
				(event) => event.action === "delivery.complete" && event.resource_id === deliveryId,
			),
		).toHaveLength(1);
	}, 60_000);

	it("recovers a retry behind the cursor and rejects its stale lease fence", async () => {
		const fixture = await createDurableReplayFixture(relay, temporaryRoot, "retry-replay");
		fixture.backendAdapter.queueOutcome({
			kind: "failed",
			failure: { class: "transient", message: "injected transient host failure" },
		});
		fixture.backendAdapter.queueOutcome({
			kind: "completed",
			disposition: {
				kind: "reply",
				message_type: "progress",
				message: "Retry recovered from the durable ledger.",
			},
		});
		const missionId = await acceptReplayMission(relay, fixture, 1);
		const discovery = await restartAndDiscoverStoredDelivery(relay, fixture);
		const firstLeases: { lease_id: string; fencing_token: string }[] = [];
		await new DeliveryProcessor({
			config: fixture.backendConfig,
			client: fixture.backendRelayClient,
			journal: discovery.journal,
			adapter: fixture.backendAdapter,
			onCheckpoint(checkpoint, deliveryId) {
				if (checkpoint !== "relay_executing") return;
				const lease = discovery.journal.snapshot().deliveries[deliveryId]?.item.delivery.lease;
				if (lease !== null && lease !== undefined) {
					firstLeases.push({
						lease_id: lease.lease_id,
						fencing_token: lease.fencing_token,
					});
				}
			},
		}).process(discovery.deliveryId);
		const released = discovery.journal.snapshot().deliveries[discovery.deliveryId];
		if (released === undefined) throw new Error("Released delivery disappeared from the journal");
		expect(released.item.delivery).toMatchObject({ status: "stored", attempt_count: 1 });
		expect(released.host_attempt_history).toHaveLength(1);
		expect(fixture.backendAdapter.counters.turnsCreated).toBe(1);

		await relay.restart();
		const retryJournal = await NodeJournal.open(
			createFileJournalStorage(fixture.backendJournalPath),
		);
		expect(
			(await fixture.backendRelayClient.pollDeliveries(discovery.persistedCursor)).items,
		).toHaveLength(0);
		const retryDelay = Date.parse(released.item.delivery.available_at) - Date.now() + 100;
		if (retryDelay > 0) await delay(retryDelay);
		const recoveredRetry = await fixture.backendRelayClient.recoverDeliveries();
		expect(recoveredRetry.items.map((item) => item.delivery.delivery_id)).toContain(
			discovery.deliveryId,
		);
		await retryJournal.ingestRecoverable(recoveredRetry.items);

		let disconnectOnSecondStart = true;
		const secondLeases: { lease_id: string; fencing_token: string }[] = [];
		await expect(
			new DeliveryProcessor({
				config: fixture.backendConfig,
				client: fixture.backendRelayClient,
				journal: retryJournal,
				adapter: fixture.backendAdapter,
				onCheckpoint(checkpoint, deliveryId) {
					if (!disconnectOnSecondStart || checkpoint !== "relay_executing") return;
					disconnectOnSecondStart = false;
					const lease = retryJournal.snapshot().deliveries[deliveryId]?.item.delivery.lease;
					if (lease !== null && lease !== undefined) {
						secondLeases.push({
							lease_id: lease.lease_id,
							fencing_token: lease.fencing_token,
						});
					}
					throw new Error("injected disconnect after retry start");
				},
			}).process(discovery.deliveryId, undefined, new Date(recoveredRetry.as_of)),
		).rejects.toThrow("injected disconnect after retry start");
		const staleLease = firstLeases[0];
		const currentLease = secondLeases[0];
		if (staleLease === undefined || currentLease === undefined) {
			throw new Error("Test did not capture both Relay lease authorities");
		}
		expect(currentLease).not.toEqual(staleLease);
		await expect(
			fixture.backendRelayClient.complete(discovery.deliveryId, {
				idempotency_key: `stale:${randomUUID()}`,
				...staleLease,
				result: {
					type: "turn_completed",
					disposition: {
						kind: "reply",
						message_type: "progress",
						message: "This stale result must not be committed.",
					},
				},
			}),
		).rejects.toMatchObject({ status: 409, code: "state_changed" });

		await relay.restart();
		const finalJournal = await NodeJournal.open(
			createFileJournalStorage(fixture.backendJournalPath),
		);
		const recoveredExecuting = await fixture.backendRelayClient.recoverDeliveries();
		expect(recoveredExecuting.items.map((item) => item.delivery.delivery_id)).toContain(
			discovery.deliveryId,
		);
		await finalJournal.ingestRecoverable(recoveredExecuting.items);
		await new DeliveryProcessor({
			config: fixture.backendConfig,
			client: fixture.backendRelayClient,
			journal: finalJournal,
			adapter: fixture.backendAdapter,
		}).process(discovery.deliveryId);
		expect(finalJournal.snapshot().deliveries[discovery.deliveryId]).toMatchObject({
			phase: "acknowledged",
			execution_attempt: 2,
		});
		expect(fixture.backendAdapter.counters.turnsCreated).toBe(2);
		const assignment = await fixture.backendRelayClient.getAssignment(missionId);
		expect(assignment.coordinator_state).toMatchObject({ status: "failed", turn_count: 1 });
		expect(assignment.coordinator_state.messages).toHaveLength(1);
	}, 60_000);

	it.skipIf(process.platform === "win32")(
		"replays exactly once after operator-assisted Node recovery while its detached capsule survives",
		async () => {
			const backend = await relay.createAgent({
				handle: "capsule-backend@e2e",
				email: "capsule-backend@example.com",
				name: "Capsule Backend",
				role: "backend",
			});
			const client = await relay.createAgent({
				handle: "capsule-client@e2e",
				email: "capsule-client@example.com",
				name: "Capsule Client",
				role: "client",
			});
			const backendNode = await enrollNode(relay.baseUrl, backend.api_key, "capsule-machine");
			const clientNode = await enrollNode(relay.baseUrl, client.api_key, "capsule-peer-machine");
			const backendRepo = await createRepository(
				join(temporaryRoot, "capsule-backend"),
				"https://github.com/acme/capsule-backend.git",
			);
			const clientRepo = await createRepository(
				join(temporaryRoot, "capsule-client"),
				"https://github.com/acme/capsule-client.git",
			);
			const backendHome = join(temporaryRoot, "capsule-backend-home");
			const backendConfigPath = join(backendHome, "config.json");
			await writeNodeConfig(
				backendConfigPath,
				localConfig(relay.baseUrl, backend.agent_id, backendNode, "backend", backendRepo),
			);
			const backendRelayClient = createNodeRelayClient({
				relayUrl: relay.baseUrl,
				credential: backendNode.credential.token,
			});
			const clientConfig = nodeConfigSchema.parse(
				localConfig(relay.baseUrl, client.agent_id, clientNode, "client", clientRepo),
			);
			const clientDaemon = new ForegroundNode({
				config: clientConfig,
				client: createNodeRelayClient({
					relayUrl: relay.baseUrl,
					credential: clientNode.credential.token,
				}),
				journal: await NodeJournal.open(
					createFileJournalStorage(join(temporaryRoot, "capsule-client-state", "journal.json")),
				),
				adapter: new FakeAgentHostAdapter(),
			});
			await clientDaemon.initialize();

			const completionDelayMs = 10_000;
			const capsuleRoot = join(backendHome, "state", "capsules");
			const missionId = randomUUID();
			const capsuleDirectory = join(capsuleRoot, missionId);
			const staleLockPath = join(backendHome, "run.lock");
			let runningNode: TrackedNodeProcess | null = startNodeProcess(
				backendConfigPath,
				completionDelayMs,
			);
			let capsuleDescriptor: CapsuleLaunchDescriptor | null = null;
			let socketIdentity: FileIdentity | null = null;
			let noLaunchAdapter: PersistentFakeCapsuleAdapter | null = null;
			try {
				await waitFor(
					async () => (await backendRelayClient.listWorkspaces()).workspaces.length === 1,
					15_000,
					runningNode,
				);
				await createMission(relay.baseUrl, backend.api_key, {
					missionId,
					backendAgentId: backend.agent_id,
					clientAgentId: client.agent_id,
					backendCommit: backendRepo.commit,
					clientCommit: clientRepo.commit,
					backendUrl: backendRepo.url,
					clientUrl: clientRepo.url,
				});
				expect((await clientDaemon.runCycle()).acceptedMissions).toBe(1);

				const journalPath = join(backendHome, "state", "journal.json");
				const acceptedState = await waitForJournalPhase(
					journalPath,
					missionId,
					"host_accepted",
					15_000,
					runningNode,
				);
				const acceptedEntry = acceptedState.state.deliveries[acceptedState.deliveryId]!;
				const acceptedEvent = acceptedEntry.host_events[0];
				if (acceptedEvent?.kind !== "accepted") {
					throw new Error("Expected the killed Node to journal capsule acceptance");
				}

				const killedPid = runningNode.child.pid;
				if (killedPid === undefined) throw new Error("Started Node process has no PID");
				capsuleDescriptor = await readCapsuleLaunchDescriptor(capsuleDirectory);
				socketIdentity = await privateSocketIdentity(capsuleDescriptor.socket_path);
				const lockIdentity = await nodeLockIdentity(staleLockPath, killedPid);
				const killed = await stopNodeProcess(runningNode, "SIGKILL");
				expect(killed).toEqual({ code: null, signal: "SIGKILL" });
				runningNode = null;
				const stateAtCrash = nodeJournalStateSchema.parse(
					JSON.parse(await readFile(journalPath, "utf8")),
				);
				expect(stateAtCrash.deliveries[acceptedState.deliveryId]?.phase).toBe("host_accepted");

				const capsuleState = JSON.parse(
					await readFile(join(capsuleDirectory, CAPSULE_STATE_FILE), "utf8"),
				) as {
					turns?: Record<
						string,
						{ input?: unknown; events?: unknown; completion_due_at?: unknown }
					>;
				};
				const executionKey = `${acceptedEvent.turn.deliveryId}:${acceptedEvent.turn.executionAttempt}`;
				const persistedTurn = capsuleState.turns?.[executionKey];
				if (persistedTurn === undefined) throw new Error("Capsule turn state was not persisted");
				const persistedEvents = hostEventSchema.array().parse(persistedTurn.events);
				expect(persistedEvents).toEqual([acceptedEvent]);
				expect(persistedTurn.completion_due_at).toEqual(expect.any(String));
				const persistedInput = startTurnInputSchema.parse(persistedTurn.input);
				expect(persistedInput).toMatchObject({
					missionId,
					deliveryId: acceptedState.deliveryId,
					executionAttempt: acceptedEvent.turn.executionAttempt,
					session: acceptedEntry.host_session,
				});
				noLaunchAdapter = await PersistentFakeCapsuleAdapter.open({
					rootDirectory: capsuleRoot,
					launcher: {
						start: async () => {
							throw new Error("Existing-capsule recovery must not launch a replacement process");
						},
					},
					outcome: capsuleDescriptor.runtime.outcome,
					completionDelayMs: capsuleDescriptor.runtime.completion_delay_ms,
				});
				const capsuleEvents = await collect(
					noLaunchAdapter.recoverTurn(acceptedEvent.turn, persistedInput),
				);
				expect(capsuleEvents.map((event) => event.kind)).toEqual([
					"accepted",
					"usage",
					"completed",
				]);
				expect(capsuleEvents[0]).toEqual(acceptedEvent);
				expect(capsuleEvents.map((event) => event.turn)).toEqual(
					capsuleEvents.map(() => acceptedEvent.turn),
				);

				runningNode = startNodeProcess(backendConfigPath, completionDelayMs, true);
				await expectNodeExit(runningNode, 1, "Stale-lock restart");
				expect(runningNode.stderr).toContain(
					`Stale AgentRelay Node lock found for non-running PID ${killedPid}`,
				);
				expect(runningNode.stderr).toContain(staleLockPath);
				runningNode = null;

				await reclaimKilledNodeLock(staleLockPath, killedPid, lockIdentity);
				runningNode = startNodeProcess(backendConfigPath, completionDelayMs, true);
				await expectNodeExit(runningNode, 0, "Operator-assisted restart");
				runningNode = null;
				const survivingSession = await noLaunchAdapter.ensureSession(capsuleDescriptor.session);
				expect(survivingSession.sessionId).toBe(acceptedEvent.turn.sessionId);
				expect(await privateSocketIdentity(capsuleDescriptor.socket_path)).toEqual(socketIdentity);

				const recoveredState = nodeJournalStateSchema.parse(
					JSON.parse(await readFile(journalPath, "utf8")),
				);
				const recoveredEntry = recoveredState.deliveries[acceptedState.deliveryId]!;
				expect(recoveredEntry.phase).toBe("acknowledged");
				expect(recoveredEntry.host_events).toEqual(capsuleEvents);

				const assignment = await backendRelayClient.getAssignment(missionId);
				expect(assignment.coordinator_state.turn_count).toBe(1);
				expect(assignment.coordinator_state.messages).toHaveLength(1);
				expect(assignment.coordinator_state.messages[0]?.body).toBe(
					"Persistent fake capsule processed this delivery.",
				);
				const auditResponse = (await getJson(
					`${relay.baseUrl}/agents/me/audit?action=delivery.complete&limit=100`,
					backend.api_key,
				)) as { events?: { action: string; resource_id: string }[] };
				if (!Array.isArray(auditResponse.events))
					throw new Error("Audit response is missing events");
				const completionAudits = auditResponse.events.filter(
					(event) =>
						event.action === "delivery.complete" && event.resource_id === acceptedState.deliveryId,
				);
				expect(completionAudits).toHaveLength(1);
			} finally {
				try {
					if (runningNode !== null) await stopNodeProcess(runningNode, "SIGKILL");
				} finally {
					await stopCapsule(noLaunchAdapter, capsuleDirectory, capsuleDescriptor, socketIdentity);
				}
			}
		},
		60_000,
	);
});

interface LocalRepository {
	readonly path: string;
	readonly url: string;
	readonly commit: string;
}

async function createDurableReplayFixture(relay: TestRelay, root: string, prefix: string) {
	const backend = await relay.createAgent({
		handle: `${prefix}-backend@e2e`,
		email: `${prefix}-backend@example.com`,
		name: `${prefix} backend`,
		role: "backend",
	});
	const client = await relay.createAgent({
		handle: `${prefix}-client@e2e`,
		email: `${prefix}-client@example.com`,
		name: `${prefix} client`,
		role: "client",
	});
	const backendNode = await enrollNode(relay.baseUrl, backend.api_key, `${prefix}-backend-node`);
	const clientNode = await enrollNode(relay.baseUrl, client.api_key, `${prefix}-client-node`);
	const backendRepo = await createRepository(
		join(root, `${prefix}-backend`),
		`https://github.com/acme/${prefix}-backend.git`,
	);
	const clientRepo = await createRepository(
		join(root, `${prefix}-client`),
		`https://github.com/acme/${prefix}-client.git`,
	);
	const backendConfig = nodeConfigSchema.parse(
		localConfig(relay.baseUrl, backend.agent_id, backendNode, "backend", backendRepo),
	);
	const clientConfig = nodeConfigSchema.parse(
		localConfig(relay.baseUrl, client.agent_id, clientNode, "client", clientRepo),
	);
	const backendJournalPath = join(root, `${prefix}-backend-state`, "journal.json");
	const backendJournal = await NodeJournal.open(createFileJournalStorage(backendJournalPath));
	const backendAdapter = new FakeAgentHostAdapter();
	const backendRelayClient = createNodeRelayClient({
		relayUrl: relay.baseUrl,
		credential: backendNode.credential.token,
	});
	const backendDaemon = new ForegroundNode({
		config: backendConfig,
		client: backendRelayClient,
		journal: backendJournal,
		adapter: backendAdapter,
	});
	const clientDaemon = new ForegroundNode({
		config: clientConfig,
		client: createNodeRelayClient({
			relayUrl: relay.baseUrl,
			credential: clientNode.credential.token,
		}),
		journal: await NodeJournal.open(
			createFileJournalStorage(join(root, `${prefix}-client-state`, "journal.json")),
		),
		adapter: new FakeAgentHostAdapter(),
	});
	await backendDaemon.initialize();
	await clientDaemon.initialize();
	return {
		backend,
		client,
		backendNode,
		backendRepo,
		clientRepo,
		backendConfig,
		backendJournalPath,
		backendAdapter,
		backendRelayClient,
		backendDaemon,
		clientDaemon,
	};
}

type DurableReplayFixture = Awaited<ReturnType<typeof createDurableReplayFixture>>;

async function acceptReplayMission(
	relay: TestRelay,
	fixture: DurableReplayFixture,
	maxTurns: number,
): Promise<string> {
	const missionId = randomUUID();
	await createMission(relay.baseUrl, fixture.backend.api_key, {
		missionId,
		backendAgentId: fixture.backend.agent_id,
		clientAgentId: fixture.client.agent_id,
		backendCommit: fixture.backendRepo.commit,
		clientCommit: fixture.clientRepo.commit,
		backendUrl: fixture.backendRepo.url,
		clientUrl: fixture.clientRepo.url,
		maxTurns,
	});
	expect((await fixture.backendDaemon.runCycle()).acceptedMissions).toBe(1);
	expect((await fixture.clientDaemon.runCycle()).acceptedMissions).toBe(1);
	return missionId;
}

async function restartAndDiscoverStoredDelivery(
	relay: TestRelay,
	fixture: DurableReplayFixture,
): Promise<{
	readonly deliveryId: string;
	readonly journal: NodeJournal;
	readonly persistedCursor: string;
}> {
	await relay.restart();
	const journal = await NodeJournal.open(createFileJournalStorage(fixture.backendJournalPath));
	expect((await fixture.backendRelayClient.recoverDeliveries()).items).toHaveLength(0);
	const cursorPage = await fixture.backendRelayClient.pollDeliveries(journal.snapshot().cursor);
	expect(cursorPage.items).toHaveLength(1);
	const item = cursorPage.items[0]!;
	await journal.ingestCursorPage(cursorPage.items, cursorPage.next_cursor);
	const persistedCursor = journal.snapshot().cursor;
	if (persistedCursor === null) throw new Error("Stored delivery did not advance the Node cursor");
	expect(persistedCursor).toBe(item.delivery.cursor);
	return { deliveryId: item.delivery.delivery_id, journal, persistedCursor };
}

async function createRepository(path: string, url: string): Promise<LocalRepository> {
	await mkdir(path, { recursive: true });
	const canonicalPath = await realpath(path);
	await execFile("git", ["init", "--initial-branch=main"], { cwd: canonicalPath });
	await execFile("git", ["config", "user.email", "agentrelay-e2e@example.com"], {
		cwd: canonicalPath,
	});
	await execFile("git", ["config", "user.name", "AgentRelay E2E"], { cwd: canonicalPath });
	await writeFile(join(canonicalPath, "README.md"), "# Node fixture\n", "utf8");
	await execFile("git", ["add", "README.md"], { cwd: canonicalPath });
	await execFile("git", ["commit", "-m", "fixture"], { cwd: canonicalPath });
	await execFile("git", ["remote", "add", "origin", url], { cwd: canonicalPath });
	const { stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd: canonicalPath });
	return { path: canonicalPath, url, commit: stdout.trim() };
}

function localConfig(
	relayUrl: string,
	agentId: string,
	enrolled: ReturnType<typeof nodeEnrollmentResultSchema.parse>,
	alias: string,
	repository: LocalRepository,
) {
	return {
		schema_version: 1,
		relay_url: relayUrl,
		node: {
			node_id: enrolled.node.node_id,
			agent_id: agentId,
			credential_id: enrolled.credential.id,
			token: enrolled.credential.token,
		},
		workspaces: {
			[alias]: {
				path: repository.path,
				repository_url: repository.url,
				allowed_base_refs: ["refs/heads/main"],
				policy_profile: "bounded-code",
			},
		},
		policy_profiles: {
			"bounded-code": {
				max_turn_seconds: 300,
				max_reported_tokens: 10_000,
				network_access: "denied",
				verification_commands: {
					test: { argv: ["git", "status", "--porcelain"], timeout_seconds: 30, environment: [] },
				},
			},
		},
	};
}

async function enrollNode(baseUrl: string, agentKey: string, name: string) {
	const response = await postJson(`${baseUrl}/agents/me/nodes`, agentKey, {
		name,
		capabilities: ["fake-runtime"],
	});
	return nodeEnrollmentResultSchema.parse(response);
}

async function createMission(
	baseUrl: string,
	agentKey: string,
	input: {
		missionId: string;
		backendAgentId: string;
		clientAgentId: string;
		backendCommit: string;
		clientCommit: string;
		backendUrl: string;
		clientUrl: string;
		maxTurns?: number;
	},
) {
	const now = new Date();
	const contract = {
		artifact_id: randomUUID(),
		type: "api_contract",
		version: 1,
		sha256: "a".repeat(64),
		media_type: "application/json",
		byte_size: 2,
	};
	const response = await postJson(`${baseUrl}/agents/me/missions`, agentKey, {
		mission_context: {
			manifest: {
				schema_version: 1,
				mission_id: input.missionId,
				objective: "Prove one durable backend-to-client delivery.",
				public_acceptance_criteria: ["The backend Node publishes one correlated result."],
				participants: [
					{
						agent_id: input.backendAgentId,
						role: "backend",
						workspace_alias: "backend",
						repository_url: input.backendUrl,
						expected_base_commit: input.backendCommit,
						initial_assignment: "Publish one bounded progress result.",
						requested_local_policy_profile: "bounded-code",
					},
					{
						agent_id: input.clientAgentId,
						role: "client",
						workspace_alias: "client",
						repository_url: input.clientUrl,
						expected_base_commit: input.clientCommit,
						initial_assignment: "Receive the backend result.",
						requested_local_policy_profile: "bounded-code",
					},
				],
				shared_contract: contract,
				max_turns: input.maxTurns ?? 4,
				max_wall_time_seconds: 3_600,
				token_budget: 100_000,
				expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
				allowed_artifact_types: ["api_contract"],
				created_at: now.toISOString(),
			},
			created_by: { principal_id: input.backendAgentId, kind: "agent" },
		},
		required_verification_commands: {
			[input.backendAgentId]: ["test"],
			[input.clientAgentId]: ["test"],
		},
	});
	return missionCreationResultSchema.parse(response);
}

async function postJson(url: string, bearer: string, payload: unknown): Promise<unknown> {
	const { statusCode, body } = await request(url, {
		method: "POST",
		headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
	const text = await body.text();
	if (statusCode < 200 || statusCode >= 300) {
		throw new Error(`HTTP ${statusCode}: ${text}`);
	}
	return JSON.parse(text);
}

interface NodeExit {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
}

interface TrackedNodeProcess {
	readonly child: ChildProcess;
	readonly exited: Promise<NodeExit>;
	stdout: string;
	stderr: string;
}

function startNodeProcess(
	configPath: string,
	completionDelayMs: number,
	once = false,
): TrackedNodeProcess {
	const args = [
		NODE_BIN_PATH,
		"run-capsule",
		"--config",
		configPath,
		"--poll-ms",
		"50",
		"--fake-outcome",
		"reply",
		"--completion-delay-ms",
		String(completionDelayMs),
	];
	if (once) args.push("--once");
	const child = spawn(process.execPath, args, {
		cwd: REPO_ROOT,
		env: { ...process.env, AGENTRELAY_NODE_LOG_LEVEL: "error" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const tracked: TrackedNodeProcess = {
		child,
		stdout: "",
		stderr: "",
		exited: new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code, signal) => resolve({ code, signal }));
		}),
	};
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		tracked.stdout += chunk;
	});
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		tracked.stderr += chunk;
	});
	return tracked;
}

async function stopNodeProcess(
	processHandle: TrackedNodeProcess,
	signal: NodeJS.Signals,
): Promise<NodeExit> {
	if (processHandle.child.exitCode === null && processHandle.child.signalCode === null) {
		processHandle.child.kill(signal);
	}
	return withTimeout(processHandle.exited, 5_000, "Node process did not exit after signal");
}

async function expectNodeExit(
	processHandle: TrackedNodeProcess,
	expectedCode: number,
	context: string,
): Promise<NodeExit> {
	const exit = await withTimeout(processHandle.exited, 15_000, `${context}: Node did not exit`);
	if (exit.code !== expectedCode) {
		throw new Error(
			`${context}: Node exited with code ${String(exit.code)} and signal ${String(exit.signal)}` +
				`\nstdout:\n${processHandle.stdout}\nstderr:\n${processHandle.stderr}`,
		);
	}
	return exit;
}

interface FileIdentity {
	readonly dev: number;
	readonly ino: number;
}

async function collect(events: AsyncIterable<HostEvent>): Promise<readonly HostEvent[]> {
	const collected: HostEvent[] = [];
	for await (const event of events) collected.push(event);
	return collected;
}

async function waitForJournalPhase(
	path: string,
	missionId: string,
	phase: string,
	timeoutMs = 15_000,
	processHandle?: TrackedNodeProcess,
): Promise<{ readonly state: NodeJournalState; readonly deliveryId: string }> {
	let found: { readonly state: NodeJournalState; readonly deliveryId: string } | null = null;
	await waitFor(
		async () => {
			try {
				const state = nodeJournalStateSchema.parse(JSON.parse(await readFile(path, "utf8")));
				const match = Object.entries(state.deliveries).find(
					([, entry]) => entry.item.delivery.mission_id === missionId && entry.phase === phase,
				);
				if (match === undefined) return false;
				found = { state, deliveryId: match[0] };
				return true;
			} catch (error) {
				if (errorCode(error) === "ENOENT") return false;
				throw error;
			}
		},
		timeoutMs,
		processHandle,
	);
	if (found === null) throw new Error(`Mission ${missionId} never reached journal phase ${phase}`);
	return found;
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 15_000,
	processHandle?: TrackedNodeProcess,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (
			processHandle !== undefined &&
			(processHandle.child.exitCode !== null || processHandle.child.signalCode !== null)
		) {
			throw new Error(
				`Node exited before the test condition (code=${String(processHandle.child.exitCode)}, ` +
					`signal=${String(processHandle.child.signalCode)})\nstdout:\n${processHandle.stdout}` +
					`\nstderr:\n${processHandle.stderr}`,
			);
		}
		if (await predicate()) return;
		await delay(25);
	}
	throw new Error(
		`Timed out waiting for asynchronous test condition${
			processHandle === undefined
				? ""
				: `\nstdout:\n${processHandle.stdout}\nstderr:\n${processHandle.stderr}`
		}`,
	);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timeout);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}

async function getJson(url: string, bearer: string): Promise<unknown> {
	const { statusCode, body } = await request(url, {
		method: "GET",
		headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },
	});
	const text = await body.text();
	if (statusCode < 200 || statusCode >= 300) throw new Error(`HTTP ${statusCode}: ${text}`);
	return JSON.parse(text);
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}

async function nodeLockIdentity(path: string, expectedPid: number): Promise<FileIdentity> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stats = await handle.stat();
		if (!stats.isFile() || (stats.mode & 0o777) !== 0o600) {
			throw new Error("Node lock is not a private regular file");
		}
		const decoded = JSON.parse(await handle.readFile("utf8")) as { pid?: unknown };
		if (decoded.pid !== expectedPid) {
			throw new Error(`Node lock does not belong to expected PID ${expectedPid}`);
		}
		return { dev: stats.dev, ino: stats.ino };
	} finally {
		await handle.close();
	}
}

async function reclaimKilledNodeLock(
	path: string,
	killedPid: number,
	expectedIdentity: FileIdentity,
): Promise<void> {
	try {
		process.kill(killedPid, 0);
		throw new Error(`Refusing to reclaim a lock while PID ${killedPid} is alive`);
	} catch (error) {
		if (errorCode(error) !== "ESRCH") throw error;
	}
	const current = await nodeLockIdentity(path, killedPid);
	if (current.dev !== expectedIdentity.dev || current.ino !== expectedIdentity.ino) {
		throw new Error("Refusing to reclaim a Node lock that changed after validation");
	}
	await unlink(path);
	await syncDirectory(dirname(path));
}

async function stopCapsule(
	adapter: PersistentFakeCapsuleAdapter | null,
	capsuleDirectory: string,
	descriptor: CapsuleLaunchDescriptor | null,
	socketIdentity: FileIdentity | null,
): Promise<void> {
	let shutdownError: unknown;
	try {
		await adapter?.terminateAll();
	} catch (error) {
		shutdownError = error;
	}

	const socketPath = descriptor?.socket_path ?? null;
	const stopped = async () =>
		(await capsuleProcessIds(capsuleDirectory)).length === 0 &&
		(socketPath === null || (await lstatIfPresent(socketPath)) === null);
	if (!(await waitUntil(stopped, 2_000))) {
		for (const signal of ["SIGTERM", "SIGKILL"] as const) {
			for (const pid of await capsuleProcessIds(capsuleDirectory)) {
				try {
					process.kill(pid, signal);
				} catch (error) {
					if (errorCode(error) !== "ESRCH") throw error;
				}
			}
			if (
				await waitUntil(async () => (await capsuleProcessIds(capsuleDirectory)).length === 0, 2_000)
			)
				break;
		}
	}
	if ((await capsuleProcessIds(capsuleDirectory)).length > 0) {
		throw new Error(`Capsule processes did not exit for ${capsuleDirectory}`);
	}
	if (socketPath !== null && (await lstatIfPresent(socketPath)) !== null) {
		if (socketIdentity === null) {
			throw new Error(`Capsule socket identity was not captured: ${socketPath}`);
		}
		await removeMatchingSocket(socketPath, socketIdentity);
	}
	if (!(await waitUntil(stopped, 1_000))) {
		throw new Error(`Capsule cleanup did not finish for ${capsuleDirectory}`);
	}
	if (shutdownError !== undefined) {
		throw new Error("Capsule shutdown request failed", { cause: shutdownError });
	}
}

async function capsuleProcessIds(capsuleDirectory: string): Promise<readonly number[]> {
	const { stdout } = await execFile("ps", ["-ww", "-Ao", "pid=,command="], {
		maxBuffer: 1_048_576,
	});
	const suffix = `agentrelay-capsule.js serve --directory ${capsuleDirectory}`;
	const pids: number[] = [];
	for (const line of stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(.+)$/.exec(line);
		if (match !== null && match[2]!.endsWith(suffix)) pids.push(Number(match[1]));
	}
	return pids;
}

async function privateSocketIdentity(path: string): Promise<FileIdentity> {
	const stats = await lstat(path);
	if (!stats.isSocket() || (stats.mode & 0o777) !== 0o600) {
		throw new Error(`Capsule socket is not private: ${path}`);
	}
	return { dev: stats.dev, ino: stats.ino };
}

async function removeMatchingSocket(path: string, expected: FileIdentity): Promise<void> {
	const current = await lstatIfPresent(path);
	if (current === null) return;
	if (current.dev !== expected.dev || current.ino !== expected.ino || !current.isSocket()) {
		throw new Error(`Refusing to remove a capsule socket that changed during cleanup: ${path}`);
	}
	await unlink(path);
	await syncDirectory(dirname(path));
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await delay(25);
	}
	return false;
}

async function lstatIfPresent(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	}
}
