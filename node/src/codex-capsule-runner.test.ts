import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
	HostEvent,
	HostSessionRef,
	HostTurnRef,
	SessionInput,
	StartTurnInput,
} from "@agentrelay/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildCapsuleRequest,
	capsuleResultValue,
	connectCapsule,
	readFirstCapsuleFrame,
	sendCapsuleRequest,
} from "../test-support/capsule-wire-client.js";
import {
	FakeCodexCapsuleClient,
	type FakeCodexProviderState,
} from "../test-support/fake-codex-capsule-client.js";
import type { CapsuleResponse } from "./capsule-protocol.js";
import type { CapsuleServerIdentity } from "./capsule-runtime.js";
import { PersistentCapsuleServer } from "./capsule-server.js";
import {
	CODEX_CAPSULE_ADAPTER_INFO,
	CodexCapsuleRunner,
	type CodexRecoveryAuthority,
} from "./codex-capsule-runner.js";
import { CodexCapsuleStore } from "./codex-capsule-store.js";

const IDS = {
	capsule: "72000000-0000-4000-8000-000000000001",
	mission: "72000000-0000-4000-8000-000000000002",
	participant: "72000000-0000-4000-8000-000000000003",
	delivery: "72000000-0000-4000-8000-000000000004",
	delivery2: "72000000-0000-4000-8000-000000000005",
	owner: "72000000-0000-4000-8000-000000000006",
};
const CAPABILITY = `ar_capsule_${"c".repeat(64)}`;
const directories: string[] = [];
const servers: PersistentCapsuleServer[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("CodexCapsuleRunner", () => {
	it("executes one fresh turn through the real Capsule wire", async () => {
		const fixture = await openFixture();
		expect(await capsuleResultValue(fixture.identity, "probe", {})).toEqual(
			CODEX_CAPSULE_ADAPTER_INFO,
		);
		const session = (await capsuleResultValue(fixture.identity, "ensure_session", {
			input: sessionInput(),
		})) as HostSessionRef;
		const input = turnInput(session);
		const frames = await sendCapsuleRequest(fixture.identity, "start_turn", { input });

		expect(eventKinds(frames)).toEqual(["accepted", "usage", "completed"]);
		expect(fixture.client.turnStarts).toHaveLength(1);
		expect(fixture.client.eventConsumers).toBe(1);
		expect(fixture.client.calls.slice(0, 3)).toEqual([
			"events",
			"startThread",
			"startReadOnlyTurn",
		]);
	});

	it("coalesces duplicate wire starts onto one provider turn", async () => {
		const fixture = await openFixture();
		const session = (await capsuleResultValue(fixture.identity, "ensure_session", {
			input: sessionInput(),
		})) as HostSessionRef;
		const input = turnInput(session);
		const [first, second] = await Promise.all([
			sendCapsuleRequest(fixture.identity, "start_turn", { input }),
			sendCapsuleRequest(fixture.identity, "start_turn", { input }),
		]);

		expect(eventPayloads(first)).toEqual(eventPayloads(second));
		expect(fixture.client.turnStarts).toHaveLength(1);
		expect(fixture.client.eventConsumers).toBe(1);
	});

	it("reconciles a lost turn/start response in a fresh provider generation", async () => {
		const fixture = await createFixture();
		const firstClient = fixture.client;
		firstClient.startBehavior = "throw_after_record";
		const firstServer = await fixture.startServer();
		const session = (await capsuleResultValue(fixture.identity, "ensure_session", {
			input: sessionInput(),
		})) as HostSessionRef;
		const input = turnInput(session);
		const failed = await sendCapsuleRequest(fixture.identity, "start_turn", {
			input,
		});
		expect(failed.map((frame) => frame.kind)).toEqual(["event", "error"]);
		await firstServer.waitUntilClosed();

		const turn = await fixture.store.lookupTurn(IDS.delivery, 1);
		if (turn === null) throw new Error("Expected the durable logical turn");
		fixture.replaceClient();
		await fixture.startServer();
		const recovered = await sendCapsuleRequest(fixture.identity, "recover_turn", { turn, input });

		expect(eventKinds(recovered)).toEqual(["accepted", "usage", "completed"]);
		expect(firstClient.turnStarts).toHaveLength(1);
		expect(fixture.client.turnStarts).toHaveLength(0);
		expect(fixture.client.readCalls).toBe(1);
		expect(fixture.authority.calls).toEqual([
			"provider_generation_start",
			"provider_generation_start",
		]);
	});

	it("fails a bounded zero-match only after provider quiescence and never resends", async () => {
		const fixture = await openFixture({ readySession: true, zeroMatchReads: 2 });
		const session = fixture.session!;
		const input = turnInput(session);
		const turn = await fixture.store.prepareTurn(input);
		await fixture.store.claimTurnStart(input);

		const frames = await sendCapsuleRequest(fixture.identity, "recover_turn", {
			turn,
			input,
		});
		expect(eventKinds(frames)).toEqual(["accepted", "usage", "failed"]);
		expect(fixture.client.turnStarts).toHaveLength(0);
		expect(fixture.client.readCalls).toBe(3);
		expect(fixture.authority.calls).toEqual(["provider_generation_start"]);

		const next = turnInput(session, IDS.delivery2);
		await fixture.store.prepareTurn(next);
		expect((await fixture.store.claimTurnStart(next)).kind).toBe("send");
	});

	it("applies pre-binding cancellation after reconciliation with one interrupt", async () => {
		const fixture = await openFixture({ readySession: true });
		fixture.client.startBehavior = "in_progress";
		const input = turnInput(fixture.session!);
		const turn = await fixture.store.prepareTurn(input);
		const claim = await fixture.store.claimTurnStart(input);
		if (claim.kind !== "send") throw new Error("Expected a new Codex turn claim");
		fixture.client.seedTurn(claim.intent, "inProgress");

		const recovery = sendCapsuleRequest(fixture.identity, "recover_turn", { turn, input });
		await expect.poll(() => fixture.client.readCalls).toBeGreaterThan(0);
		await expect
			.poll(async () => (await fixture.store.inspectTurn(turn, input)).codexTurnId)
			.toBe("seeded-1");
		await capsuleResultValue(fixture.identity, "cancel_turn", { turn });
		const frames = await recovery;

		expect(eventKinds(frames)).toEqual(["accepted", "usage", "cancelled"]);
		expect(fixture.client.interrupts).toEqual([{ threadId: "thread-1", turnId: "seeded-1" }]);
	});

	it("resumes the durable session before cancelling an unresolved turn after restart", async () => {
		const fixture = await openFixture({ readySession: true });
		const input = turnInput(fixture.session!);
		const turn = await fixture.store.prepareTurn(input);
		const claim = await fixture.store.claimTurnStart(input);
		if (claim.kind !== "send") throw new Error("Expected a new Codex turn claim");
		fixture.client.seedTurn(claim.intent, "inProgress");

		await capsuleResultValue(fixture.identity, "cancel_turn", { turn });
		await expect
			.poll(async () => eventKindsFromStore(fixture.store, turn, input))
			.toEqual(["accepted", "usage", "cancelled"]);

		expect(fixture.client.calls).toContain("resumeThread");
		expect(fixture.client.interrupts).toEqual([{ threadId: "thread-1", turnId: "seeded-1" }]);
	});

	it("retires after an uncertain interrupt and fails it in a proven fresh provider generation", async () => {
		const fixture = await createFixture({ readySession: true });
		const firstClient = fixture.client;
		const firstServer = await fixture.startServer();
		const input = turnInput(fixture.session!);
		const turn = await fixture.store.prepareTurn(input);
		const start = await fixture.store.claimTurnStart(input);
		if (start.kind !== "send") throw new Error("Expected a new Codex turn claim");
		const providerTurn = firstClient.seedTurn(start.intent, "inProgress");
		await fixture.store.acceptTurn(input, providerTurn.id);
		await fixture.store.requestCancellation(turn);
		firstClient.interruptFailure = new Error(
			"Fake lost the interrupt response with provider-turn-private-secret",
		);
		const failed = await sendCapsuleRequest(fixture.identity, "recover_turn", { turn, input });
		expect(failed.map((frame) => frame.kind)).toEqual(["event", "error"]);
		expect(failed.at(-1)).toMatchObject({
			kind: "error",
			code: "internal",
			message: "Capsule runtime failed",
		});
		expect(JSON.stringify(failed)).not.toContain("provider-turn-private-secret");
		await firstServer.waitUntilClosed();

		fixture.replaceClient();
		await fixture.startServer();
		const recovered = await sendCapsuleRequest(fixture.identity, "recover_turn", { turn, input });

		expect(eventKinds(recovered)).toEqual(["accepted", "usage", "failed"]);
		expect(recovered.at(-2)).toMatchObject({
			kind: "event",
			event: {
				kind: "failed",
				failure: {
					class: "transient",
					message: "Codex cancellation outcome could not be recovered after provider shutdown",
				},
			},
		});
		expect(firstClient.interrupts).toEqual([{ threadId: "thread-1", turnId: providerTurn.id }]);
		expect(fixture.client.interrupts).toEqual([]);
		expect(fixture.client.readCalls).toBe(1);
		expect(JSON.stringify(recovered)).not.toContain(providerTurn.id);
		expect(fixture.authority.calls).toEqual([
			"provider_generation_start",
			"provider_generation_start",
		]);
	});

	it("retires when a detached cancel request loses its interrupt response", async () => {
		const fixture = await createFixture({ readySession: true });
		const firstClient = fixture.client;
		firstClient.startBehavior = "in_progress";
		const interruptGate = deferred();
		firstClient.interruptBarrier = interruptGate.promise;
		firstClient.interruptFailure = new Error("Fake lost the detached interrupt response");
		const firstServer = await fixture.startServer();
		const input = turnInput(fixture.session!);

		const startSocket = await connectCapsule(fixture.identity.socketPath);
		startSocket.write(
			`${JSON.stringify(buildCapsuleRequest(fixture.identity, "start_turn", { input }))}\n`,
		);
		const accepted = await readFirstCapsuleFrame(startSocket);
		expect(accepted).toMatchObject({ kind: "event", event: { kind: "accepted" } });
		startSocket.destroy();

		const turn = await fixture.store.lookupTurn(IDS.delivery, 1);
		if (turn === null) throw new Error("Expected the durable logical turn");
		const cancelSocket = await connectCapsule(fixture.identity.socketPath);
		cancelSocket.on("error", () => undefined);
		cancelSocket.write(
			`${JSON.stringify(buildCapsuleRequest(fixture.identity, "cancel_turn", { turn }))}\n`,
		);
		await expect.poll(() => firstClient.interrupts).toHaveLength(1);
		cancelSocket.destroy();
		interruptGate.resolve();
		await firstServer.waitUntilClosed();

		fixture.replaceClient();
		await fixture.startServer();
		const recovered = await sendCapsuleRequest(fixture.identity, "recover_turn", { turn, input });
		expect(eventKinds(recovered)).toEqual(["accepted", "usage", "failed"]);
		expect(firstClient.interrupts).toHaveLength(1);
		expect(fixture.client.interrupts).toEqual([]);
		expect(fixture.client.readCalls).toBe(1);
		expect(fixture.authority.calls).toEqual([
			"provider_generation_start",
			"provider_generation_start",
		]);
	});

	it("replaces an unresolved empty session only behind a quiescence proof", async () => {
		const fixture = await createFixture();
		await fixture.store.claimSessionStart();
		await fixture.startServer();
		const session = await capsuleResultValue(fixture.identity, "ensure_session", {
			input: sessionInput(),
		});

		expect(session).toMatchObject({ sessionId: expect.stringMatching(/^capsule-session-/) });
		expect(fixture.client.calls).toContain("startThread");
		expect(fixture.client.calls).not.toContain("resumeThread");
		expect(fixture.authority.calls).toEqual(["provider_generation_start"]);
	});

	it("retires when detached session startup fails after crossing its durable barrier", async () => {
		const fixture = await createFixture();
		const firstClient = fixture.client;
		const startGate = deferred();
		firstClient.threadStartBarrier = startGate.promise;
		firstClient.threadStartFailure = new Error("Fake lost the detached thread/start response");
		const firstServer = await fixture.startServer();
		const socket = await connectCapsule(fixture.identity.socketPath);
		socket.on("error", () => undefined);
		socket.write(
			`${JSON.stringify(
				buildCapsuleRequest(fixture.identity, "ensure_session", { input: sessionInput() }),
			)}\n`,
		);
		await expect.poll(() => firstClient.calls).toContain("startThread");
		socket.destroy();
		startGate.resolve();
		await firstServer.waitUntilClosed();

		fixture.replaceClient();
		await fixture.startServer();
		const session = await capsuleResultValue(fixture.identity, "ensure_session", {
			input: sessionInput(),
		});
		expect(session).toMatchObject({ sessionId: expect.stringMatching(/^capsule-session-/) });
		expect(firstClient.calls.filter((call) => call === "startThread")).toHaveLength(1);
		expect(fixture.client.calls.filter((call) => call === "startThread")).toHaveLength(1);
		expect(fixture.authority.calls).toEqual([
			"provider_generation_start",
			"provider_generation_start",
		]);
	});

	it("does not create a provider client before generation quiescence is proven", async () => {
		const fixture = await createFixture();
		fixture.authority.failure = new Error("previous provider may still be live");

		await expect(fixture.startServer()).rejects.toThrow("previous provider may still be live");
		expect(fixture.clientFactoryCalls).toBe(0);
		expect(fixture.client.calls).toEqual([]);
	});

	it("fences same-generation admission synchronously after a provider failure", async () => {
		const directory = await realpath(await mkdtemp("/tmp/agentrelay-codex-retirement-"));
		directories.push(directory);
		const store = await CodexCapsuleStore.open(join(directory, "state"), {
			capsuleId: IDS.capsule,
			session: sessionInput(),
		});
		const client = new FakeCodexCapsuleClient(directory);
		client.threadStartFailure = new Error("provider thread/start failed");
		let retireCalls = 0;
		const runner = await CodexCapsuleRunner.open({
			store,
			cwd: directory,
			clientFactory: async () => client,
			recoveryAuthority: new RecordingRecoveryAuthority(),
			retireGeneration: () => {
				retireCalls += 1;
			},
			eventPollMs: 1,
			providerPollMs: 1,
			zeroMatchReads: 2,
		});

		await expect(runner.ensureSession(sessionInput())).rejects.toThrow(
			"provider thread/start failed",
		);
		await expect(runner.ensureSession(sessionInput())).rejects.toThrow(
			"Codex Capsule runner is closed",
		);
		expect(client.calls.filter((call) => call === "startThread")).toHaveLength(1);
		expect(retireCalls).toBe(1);
		await runner.close();
	});

	it("retires the generation when a detached turn driver later fails", async () => {
		const fixture = await createFixture();
		fixture.client.startBehavior = "in_progress";
		const server = await fixture.startServer();
		const session = (await capsuleResultValue(fixture.identity, "ensure_session", {
			input: sessionInput(),
		})) as HostSessionRef;
		const socket = await connectCapsule(fixture.identity.socketPath);
		const request = buildCapsuleRequest(fixture.identity, "start_turn", {
			input: turnInput(session),
		});
		socket.write(`${JSON.stringify(request)}\n`);
		expect((await readFirstCapsuleFrame(socket)).kind).toBe("event");
		socket.destroy();

		fixture.client.failEvents(new Error("provider transport failed after detach"));
		await server.waitUntilClosed();

		expect(fixture.client.closeCalls).toBe(1);
		await expect(connectCapsule(fixture.identity.socketPath)).rejects.toBeDefined();
	});
});

interface FixtureOptions {
	readonly readySession?: boolean;
	readonly zeroMatchReads?: number;
}

async function openFixture(options: FixtureOptions = {}) {
	const fixture = await createFixture(options);
	await fixture.startServer();
	return fixture;
}

async function createFixture(options: FixtureOptions = {}) {
	const directory = await realpath(await mkdtemp("/tmp/agentrelay-codex-runner-"));
	directories.push(directory);
	const identity: CapsuleServerIdentity = {
		capsuleId: IDS.capsule,
		capabilityToken: CAPABILITY,
		socketPath: join(directory, "c.sock"),
	};
	const store = await CodexCapsuleStore.open(join(directory, "state"), {
		capsuleId: IDS.capsule,
		session: sessionInput(),
	});
	let session: HostSessionRef | undefined;
	if (options.readySession) {
		await store.claimSessionStart();
		session = await store.acceptSession("thread-1");
	}
	const providerState: FakeCodexProviderState = { turns: [] };
	let client = new FakeCodexCapsuleClient(directory, "thread-1", providerState);
	let clientFactoryCalls = 0;
	const authority = new RecordingRecoveryAuthority();
	const startServer = async () => {
		const server = await PersistentCapsuleServer.start({
			identity,
			openRuntime: ({ retire }) =>
				CodexCapsuleRunner.open({
					store,
					cwd: directory,
					clientFactory: async () => {
						clientFactoryCalls += 1;
						return client;
					},
					recoveryAuthority: authority,
					retireGeneration: retire,
					eventPollMs: 1,
					providerPollMs: 1,
					zeroMatchReads: options.zeroMatchReads ?? 2,
				}),
		});
		servers.push(server);
		return server;
	};
	return {
		identity,
		store,
		authority,
		session,
		startServer,
		get client() {
			return client;
		},
		get clientFactoryCalls() {
			return clientFactoryCalls;
		},
		replaceClient() {
			client = new FakeCodexCapsuleClient(directory, "thread-1", providerState);
		},
	};
}

class RecordingRecoveryAuthority implements CodexRecoveryAuthority {
	readonly calls: Array<"provider_generation_start"> = [];
	failure: Error | null = null;

	async assertPreviousProviderProcessQuiescent(reason: "provider_generation_start"): Promise<void> {
		this.calls.push(reason);
		if (this.failure !== null) throw this.failure;
	}
}

function sessionInput(): SessionInput {
	return {
		missionId: IDS.mission,
		participantId: IDS.participant,
		workspaceAlias: "backend-primary",
	};
}

function turnInput(session: HostSessionRef, deliveryId = IDS.delivery): StartTurnInput {
	return {
		session,
		missionId: IDS.mission,
		deliveryId,
		executionAttempt: 1,
		contractVersion: 1,
		missionSequence: 2,
		objective: {
			text: "Build compatible backend and client changes.",
			authorPrincipalId: IDS.owner,
			provenance: "mission_manifest",
		},
		assignment: {
			text: "Analyze the backend contract.",
			authorPrincipalId: IDS.owner,
			provenance: "mission_manifest",
		},
		acceptanceCriteria: [
			{
				text: "Return one compatible recommendation.",
				authorPrincipalId: IDS.owner,
				provenance: "mission_manifest",
			},
		],
		peerMessages: [],
		artifacts: [],
	};
}

function eventPayloads(frames: readonly CapsuleResponse[]): HostEvent[] {
	return frames.flatMap((frame) => (frame.kind === "event" ? [frame.event] : []));
}

function eventKinds(frames: readonly CapsuleResponse[]): HostEvent["kind"][] {
	return eventPayloads(frames).map((event) => event.kind);
}

async function eventKindsFromStore(
	store: CodexCapsuleStore,
	turn: HostTurnRef,
	input: StartTurnInput,
): Promise<HostEvent["kind"][]> {
	return (await store.eventsForTurn(turn, input)).map((event) => event.kind);
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
