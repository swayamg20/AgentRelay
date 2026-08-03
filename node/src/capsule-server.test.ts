import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
	AdapterInfo,
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
	readCapsuleFrames,
	readFirstCapsuleFrame,
	sendCapsuleRequest,
} from "../test-support/capsule-wire-client.js";
import type { CapsuleResponse } from "./capsule-protocol.js";
import type { CapsuleRuntime, CapsuleServerIdentity } from "./capsule-runtime.js";
import { PersistentCapsuleServer } from "./capsule-server.js";

const IDS = {
	capsule: "71000000-0000-4000-8000-000000000001",
	mission: "71000000-0000-4000-8000-000000000002",
	participant: "71000000-0000-4000-8000-000000000003",
	delivery: "71000000-0000-4000-8000-000000000004",
	owner: "71000000-0000-4000-8000-000000000005",
};
const CAPABILITY = `ar_capsule_${"a".repeat(64)}`;
const directories: string[] = [];
const servers: PersistentCapsuleServer[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("PersistentCapsuleServer", () => {
	it("routes the unchanged wire through an injected runtime", async () => {
		const runtime = new RecordingRuntime();
		const { server, identity } = await startServer(runtime);
		const input = turnInput(runtime.session);

		expect(await capsuleResultValue(identity, "probe", {})).toEqual(runtime.info);
		expect(await capsuleResultValue(identity, "ensure_session", { input: sessionInput() })).toEqual(
			runtime.session,
		);
		expect(
			await capsuleResultValue(identity, "lookup_turn", {
				delivery_id: IDS.delivery,
				execution_attempt: 1,
			}),
		).toEqual(runtime.turn);

		const started = await sendCapsuleRequest(identity, "start_turn", { input });
		expect(started.map((frame) => frame.kind)).toEqual(["event", "event", "event", "end"]);
		const recovered = await sendCapsuleRequest(identity, "recover_turn", {
			turn: runtime.turn,
			input,
		});
		expect(eventPayloads(recovered)).toEqual(eventPayloads(started));
		expect(await capsuleResultValue(identity, "cancel_turn", { turn: runtime.turn })).toEqual({});
		expect(runtime.calls).toEqual([
			"probe",
			"ensureSession",
			"lookupTurn",
			"startTurn",
			"recoverTurn",
			"cancelTurn",
		]);

		await server.close();
		expect(runtime.closeCalls).toBe(1);
		await server.close();
		expect(runtime.closeCalls).toBe(1);
	});

	it("authenticates before invoking the runtime", async () => {
		const runtime = new RecordingRuntime();
		const { identity } = await startServer(runtime);
		const frames = await sendCapsuleRequest(
			{ ...identity, capabilityToken: `ar_capsule_${"b".repeat(64)}` },
			"probe",
			{},
		);
		expect(frames).toEqual([
			expect.objectContaining({
				kind: "error",
				code: "authentication_failed",
				message: "Capsule capability authentication failed",
			}),
		]);
		expect(runtime.calls).toEqual([]);
	});

	it("redacts an unexpected runtime error and retires that runtime generation", async () => {
		const runtime = new RecordingRuntime();
		runtime.streamFailure = new Error("provider leaked /secret/path and token-123");
		const { server, identity } = await startServer(runtime);
		const frames = await sendCapsuleRequest(identity, "start_turn", {
			input: turnInput(runtime.session),
		});
		expect(frames).toEqual([
			expect.objectContaining({
				kind: "error",
				code: "internal",
				message: "Capsule runtime failed",
			}),
		]);
		expect(JSON.stringify(frames)).not.toContain("secret/path");
		expect(JSON.stringify(frames)).not.toContain("token-123");
		await server.waitUntilClosed();
		expect(runtime.closeCalls).toBe(1);
	});

	it("fails closed when a runtime stream ends before a terminal event", async () => {
		const runtime = new RecordingRuntime();
		runtime.omitTerminal = true;
		const { identity } = await startServer(runtime);
		const incomplete = await sendCapsuleRequest(identity, "start_turn", {
			input: turnInput(runtime.session),
		});
		expect(incomplete.map((frame) => frame.kind)).toEqual(["event", "error"]);
		expect(incomplete.at(-1)).toMatchObject({
			kind: "error",
			code: "internal",
			message: "Capsule runtime failed",
		});
	});

	it("removes its public socket when runtime startup fails", async () => {
		const identity = await serverIdentity();
		await expect(
			PersistentCapsuleServer.start({
				identity,
				openRuntime: async () => {
					throw new Error("runtime startup failed");
				},
			}),
		).rejects.toThrow("runtime startup failed");
		await expect(lstat(identity.socketPath)).rejects.toMatchObject({ code: "ENOENT" });

		const runtime = new RecordingRuntime();
		const server = await PersistentCapsuleServer.start({
			identity,
			openRuntime: async () => runtime,
		});
		servers.push(server);
		expect(await capsuleResultValue(identity, "probe", {})).toEqual(runtime.info);
	});

	it("opens a runtime only for the server that wins socket ownership", async () => {
		const identity = await serverIdentity();
		const runtimes: RecordingRuntime[] = [];
		const openRuntime = async () => {
			const runtime = new RecordingRuntime();
			runtimes.push(runtime);
			return runtime;
		};
		const results = await Promise.allSettled([
			PersistentCapsuleServer.start({ identity, openRuntime }),
			PersistentCapsuleServer.start({ identity, openRuntime }),
		]);
		const winners = results.flatMap((result) =>
			result.status === "fulfilled" ? [result.value] : [],
		);
		expect(winners).toHaveLength(1);
		expect(runtimes).toHaveLength(1);
		servers.push(winners[0]!);
	});

	it("detaches a disconnected stream without cancelling its turn", async () => {
		const runtime = new RecordingRuntime();
		runtime.pauseAfterAccepted = true;
		const { identity } = await startServer(runtime);
		const socket = await connectCapsule(identity.socketPath);
		const requestValue = buildCapsuleRequest(identity, "start_turn", {
			input: turnInput(runtime.session),
		});
		socket.write(`${JSON.stringify(requestValue)}\n`);
		await readFirstCapsuleFrame(socket);
		socket.destroy();

		await expect.poll(() => runtime.streamReturns).toBe(1);
		expect(runtime.cancelCalls).toBe(0);
	});

	it("accepts a complete request from a client that half-closes its write side", async () => {
		const runtime = new RecordingRuntime();
		const { identity } = await startServer(runtime);
		const socket = await connectCapsule(identity.socketPath);
		const request = buildCapsuleRequest(identity, "start_turn", {
			input: turnInput(runtime.session),
		});
		socket.end(`${JSON.stringify(request)}\n`);

		expect((await readCapsuleFrames(socket)).map((frame) => frame.kind)).toEqual([
			"event",
			"event",
			"event",
			"end",
		]);
	});

	it("uses runtime shutdown to release and fence an admitted operation", async () => {
		const runtime = new RecordingRuntime();
		runtime.ensureSessionGate = deferred();
		runtime.ensureSessionFinished = deferred();
		runtime.closeReleasesEnsureSession = true;
		const { server, identity } = await startServer(runtime);
		const pending = sendCapsuleRequest(identity, "ensure_session", { input: sessionInput() });
		await expect.poll(() => runtime.calls).toContain("ensureSession");

		const closing = server.close();
		await expect.poll(() => runtime.closeCalls).toBe(1);
		await closing;
		await pending;
		expect(runtime.closeCalls).toBe(1);
	});

	it("retires a runtime generation requested by detached background work", async () => {
		const runtime = new RecordingRuntime();
		const identity = await serverIdentity();
		let retire!: () => void;
		const server = await PersistentCapsuleServer.start({
			identity,
			openRuntime: async (lifecycle) => {
				retire = lifecycle.retire;
				return runtime;
			},
		});
		servers.push(server);

		retire();
		await server.waitUntilClosed();

		expect(runtime.closeCalls).toBe(1);
		await expect(connectCapsule(identity.socketPath)).rejects.toBeDefined();
	});

	it("attempts complete teardown once even when runtime close fails", async () => {
		const runtime = new RecordingRuntime();
		runtime.closeFailure = new Error("runtime close failed");
		const { server, identity } = await startServer(runtime);

		const first = server.close();
		const second = server.close();
		await expect(first).rejects.toThrow("Capsule server shutdown failed");
		await expect(second).rejects.toThrow("Capsule server shutdown failed");
		await server.waitUntilClosed();
		expect(runtime.closeCalls).toBe(1);
		await expect(connectCapsule(identity.socketPath)).rejects.toBeDefined();
	});
});

class RecordingRuntime implements CapsuleRuntime {
	readonly info: AdapterInfo = {
		name: "recording-runtime",
		version: "1.0.0",
		capabilities: { cancellation: true, recovery: true, usage: "unavailable" },
	};
	readonly session: HostSessionRef = { ...sessionInput(), sessionId: "session-local-1" };
	readonly turn: HostTurnRef = {
		turnId: "turn-local-1",
		sessionId: this.session.sessionId,
		missionId: IDS.mission,
		deliveryId: IDS.delivery,
		executionAttempt: 1,
		contractVersion: 1,
	};
	readonly calls: string[] = [];
	closeCalls = 0;
	cancelCalls = 0;
	streamReturns = 0;
	streamFailure: Error | null = null;
	closeFailure: Error | null = null;
	ensureSessionGate: Deferred<void> | null = null;
	ensureSessionFinished: Deferred<void> | null = null;
	closeReleasesEnsureSession = false;
	omitTerminal = false;
	pauseAfterAccepted = false;

	async probe() {
		this.calls.push("probe");
		return this.info;
	}

	async ensureSession(_input: SessionInput) {
		this.calls.push("ensureSession");
		try {
			await this.ensureSessionGate?.promise;
			return this.session;
		} finally {
			this.ensureSessionFinished?.resolve();
		}
	}

	async lookupTurn(_deliveryId: string, _executionAttempt: number) {
		this.calls.push("lookupTurn");
		return this.turn;
	}

	startTurn(_input: StartTurnInput): AsyncIterable<HostEvent> {
		this.calls.push("startTurn");
		return this.events();
	}

	recoverTurn(_ref: HostTurnRef, _input: StartTurnInput): AsyncIterable<HostEvent> {
		this.calls.push("recoverTurn");
		return this.events();
	}

	async cancelTurn(_ref: HostTurnRef) {
		this.calls.push("cancelTurn");
		this.cancelCalls += 1;
	}

	async close() {
		this.closeCalls += 1;
		if (this.closeReleasesEnsureSession) {
			this.ensureSessionGate?.resolve();
			await this.ensureSessionFinished?.promise;
		}
		if (this.closeFailure !== null) throw this.closeFailure;
	}

	private async *events(): AsyncIterable<HostEvent> {
		try {
			if (this.streamFailure !== null) throw this.streamFailure;
			yield { kind: "accepted", turn: this.turn, sequence: 1 };
			if (this.pauseAfterAccepted) await delay(20);
			if (this.omitTerminal) return;
			yield {
				kind: "usage",
				turn: this.turn,
				sequence: 2,
				usage: { available: false, reason: "unsupported" },
			};
			yield {
				kind: "completed",
				turn: this.turn,
				sequence: 3,
				disposition: { kind: "reply", message_type: "progress", message: "Done" },
			};
		} finally {
			this.streamReturns += 1;
		}
	}
}

async function startServer(runtime: RecordingRuntime) {
	const identity = await serverIdentity();
	const server = await PersistentCapsuleServer.start({
		identity,
		openRuntime: async () => runtime,
	});
	servers.push(server);
	return { server, identity };
}

async function serverIdentity(): Promise<CapsuleServerIdentity> {
	const directory = await realpath(await mkdtemp("/tmp/agentrelay-capsule-server-"));
	directories.push(directory);
	return {
		capsuleId: IDS.capsule,
		capabilityToken: CAPABILITY,
		socketPath: join(directory, "c.sock"),
	};
}

function sessionInput(): SessionInput {
	return {
		missionId: IDS.mission,
		participantId: IDS.participant,
		workspaceAlias: "backend-primary",
	};
}

function turnInput(session: HostSessionRef): StartTurnInput {
	return {
		session,
		missionId: IDS.mission,
		deliveryId: IDS.delivery,
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
