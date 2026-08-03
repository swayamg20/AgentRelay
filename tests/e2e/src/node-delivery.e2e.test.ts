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
	PersistentFakeCapsuleAdapter,
	createFileJournalStorage,
	createNodeRelayClient,
	nodeConfigSchema,
	nodeJournalStateSchema,
	readCapsuleLaunchDescriptor,
	syncDirectory,
	writeNodeConfig,
} from "agentrelay-node";
import { request } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT, TestRelay } from "./harness.js";

const execFile = promisify(execFileCallback);
const NODE_BIN_PATH = join(REPO_ROOT, "node", "dist", "bin", "agentrelay-node.js");

describe("foreground Node delivery", () => {
	let relay: TestRelay;
	let temporaryRoot: string;

	beforeAll(async () => {
		temporaryRoot = await mkdtemp(join(tmpdir(), "agentrelay-node-e2e-"));
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
				const acceptedState = await waitForJournalPhase(journalPath, missionId, "host_accepted");
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
				max_turns: 4,
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
		env: { ...process.env, AGENTRELAY_NODE_LOG_LEVEL: "fatal" },
		stdio: ["ignore", "ignore", "pipe"],
	});
	const tracked: TrackedNodeProcess = {
		child,
		stderr: "",
		exited: new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code, signal) => resolve({ code, signal }));
		}),
	};
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
				`\nstderr:\n${processHandle.stderr}`,
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
): Promise<{ readonly state: NodeJournalState; readonly deliveryId: string }> {
	let found: { readonly state: NodeJournalState; readonly deliveryId: string } | null = null;
	await waitFor(async () => {
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
	}, timeoutMs);
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
					`signal=${String(processHandle.child.signalCode)})\nstderr:\n${processHandle.stderr}`,
			);
		}
		if (await predicate()) return;
		await delay(25);
	}
	throw new Error("Timed out waiting for asynchronous test condition");
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
