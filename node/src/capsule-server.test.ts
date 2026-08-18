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
import type {
	CapsuleRuntime,
	CapsuleRuntimeActivation,
	CapsuleRuntimeController,
	CapsuleServerIdentity,
} from "./capsule-runtime.js";
import { PersistentCapsuleServer } from "./capsule-server.js";
import type { RuntimeAuthorityEvidence, RuntimeAuthorityGrant } from "./runtime-authority.js";
import { runtimeAuthorityRequest } from "./runtime-authority.js";
import { authorityGrant, authorityLimits } from "./runtime-authority.test-support.js";

const IDS = {
	capsule: "71000000-0000-4000-8000-000000000001",
	mission: "71000000-0000-4000-8000-000000000002",
	participant: "71000000-0000-4000-8000-000000000003",
	delivery: "71000000-0000-4000-8000-000000000004",
	owner: "71000000-0000-4000-8000-000000000005",
};
const CAPABILITY = `ar_capsule_${"a".repeat(64)}`;
const SERVER_AUTHORITY = authorityGrant({
	agent_id: IDS.participant,
	mission_id: IDS.mission,
	delivery_id: IDS.delivery,
	workspace_alias: "backend-primary",
	lease_expires_at: "2099-01-01T00:01:00.000Z",
	hard_expires_at: "2099-01-01T00:05:00.000Z",
});
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

	it("denies state-changing runtime calls until authority is installed", async () => {
		const runtime = new RecordingRuntime();
		const { identity } = await startServer(runtime, { installAuthority: false });
		expect(await capsuleResultValue(identity, "probe", {})).toEqual(runtime.info);
		expect(
			await capsuleResultValue(identity, "lookup_turn", {
				delivery_id: IDS.delivery,
				execution_attempt: 1,
			}),
		).toEqual(runtime.turn);

		const frames = await sendCapsuleRequest(identity, "ensure_session", {
			input: sessionInput(),
		});

		expect(frames).toEqual([
			expect.objectContaining({
				kind: "error",
				code: "authority_denied",
				message: "Runtime authority is not installed",
			}),
		]);
		expect(runtime.calls).toEqual(["probe", "lookupTurn"]);
	});

	it("keeps the controller passive until the first authorized runtime operation", async () => {
		const runtime = new RecordingRuntime();
		const { identity, controller } = await startServer(runtime, { installAuthority: false });

		expect(await capsuleResultValue(identity, "probe", {})).toEqual(runtime.info);
		expect(
			await capsuleResultValue(identity, "lookup_turn", {
				delivery_id: IDS.delivery,
				execution_attempt: 1,
			}),
		).toEqual(runtime.turn);
		await capsuleResultValue(identity, "install_authority", {
			grant: SERVER_AUTHORITY,
			current_lease: currentLease(SERVER_AUTHORITY),
		});
		expect(controller.activations).toHaveLength(0);

		await capsuleResultValue(identity, "ensure_session", { input: sessionInput() });
		await capsuleResultValue(identity, "ensure_session", { input: sessionInput() });

		expect(controller.activations).toHaveLength(1);
		expect(controller.activations[0]).toMatchObject({ grant: SERVER_AUTHORITY });
		expect(controller.activations[0]?.signal.aborted).toBe(false);
	});

	it("fails closed when authority is revoked during runtime activation", async () => {
		const runtime = new RecordingRuntime();
		const { server, identity, controller } = await startServer(runtime);
		controller.activationGate = deferred();
		controller.activationStarted = deferred();

		const pendingSession = sendCapsuleRequest(identity, "ensure_session", {
			input: sessionInput(),
		});
		await controller.activationStarted.promise;
		await capsuleResultValue(identity, "revoke_authority", {
			mission_id: IDS.mission,
			grant_id: SERVER_AUTHORITY.grant_id,
			reason: "revoked",
		});
		controller.activationGate.resolve();
		await pendingSession.catch(() => []);
		await server.waitUntilClosed();

		expect(controller.activations).toHaveLength(1);
		expect(controller.activations[0]?.signal.aborted).toBe(true);
		expect(runtime.calls).not.toContain("ensureSession");
		expect(runtime.closeCalls).toBe(1);
	});

	it("preserves activation teardown failure ahead of authority denial", async () => {
		const runtime = new RecordingRuntime();
		const teardownFailure = new Error("runtime teardown was not proven");
		runtime.closeFailure = teardownFailure;
		const { server, identity, controller } = await startServer(runtime);
		controller.activationGate = deferred();
		controller.activationStarted = deferred();

		const pendingSession = sendCapsuleRequest(identity, "ensure_session", {
			input: sessionInput(),
		});
		await controller.activationStarted.promise;
		await capsuleResultValue(identity, "revoke_authority", {
			mission_id: IDS.mission,
			grant_id: SERVER_AUTHORITY.grant_id,
			reason: "revoked",
		});
		controller.activationGate.resolve();

		await expect(pendingSession).resolves.toEqual([
			expect.objectContaining({
				kind: "error",
				code: "internal",
				message: "Capsule runtime failed",
			}),
		]);
		await server.waitUntilClosed();
		const closeFailure = await server.close().catch((error: unknown) => error);
		expect(closeFailure).toBeInstanceOf(AggregateError);
		expect((closeFailure as AggregateError).errors).toContain(teardownFailure);
		expect(runtime.closeCalls).toBe(1);
	});

	it("accepts an exact grant replay and retires on a changed fence", async () => {
		const runtime = new RecordingRuntime();
		const { server, identity } = await startServer(runtime);

		expect(
			await capsuleResultValue(identity, "install_authority", {
				grant: SERVER_AUTHORITY,
				current_lease: currentLease(SERVER_AUTHORITY),
			}),
		).toEqual({});
		const changedGrant = { ...SERVER_AUTHORITY, fencing_token: "9007199254740994" };
		const changed = await sendCapsuleRequest(identity, "install_authority", {
			grant: changedGrant,
			current_lease: currentLease(changedGrant),
		});
		expect(changed).toEqual([
			expect.objectContaining({
				kind: "error",
				code: "authority_denied",
				message: "Runtime authority denied: stale_fence",
			}),
		]);
		await server.waitUntilClosed();
		expect(runtime.closeCalls).toBe(1);
	});

	it("retires on any changed body under an installed grant id", async () => {
		const runtime = new RecordingRuntime();
		const { server, identity } = await startServer(runtime);

		const changed = await sendCapsuleRequest(identity, "install_authority", {
			grant: { ...SERVER_AUTHORITY, policy_grant_sha256: "c".repeat(64) },
			current_lease: currentLease(SERVER_AUTHORITY),
		});
		expect(changed).toEqual([
			expect.objectContaining({
				kind: "error",
				code: "authority_denied",
				message: "Runtime authority denied: policy_changed",
			}),
		]);
		await server.waitUntilClosed();
	});

	it("retires after rejecting an already-expired first install", async () => {
		const runtime = new RecordingRuntime();
		const { server, identity } = await startServer(runtime, { installAuthority: false });
		const now = Date.now();
		const expired = authorityGrant({
			agent_id: IDS.participant,
			mission_id: IDS.mission,
			delivery_id: IDS.delivery,
			workspace_alias: "backend-primary",
			lease_expires_at: new Date(now - 2_000).toISOString(),
			hard_expires_at: new Date(now - 1_000).toISOString(),
		});

		const frames = await sendCapsuleRequest(identity, "install_authority", {
			grant: expired,
			current_lease: currentLease(expired),
		});
		expect(frames).toEqual([
			expect.objectContaining({
				kind: "error",
				code: "authority_denied",
				message: "Runtime authority denied: expired",
			}),
		]);
		await server.waitUntilClosed();
		expect(runtime.closeCalls).toBe(1);
	});

	it("atomically restores an original grant with its newer verified lease", async () => {
		const runtime = new RecordingRuntime();
		const { identity } = await startServer(runtime, { installAuthority: false });
		const now = Date.now();
		const original = authorityGrant({
			agent_id: IDS.participant,
			mission_id: IDS.mission,
			delivery_id: IDS.delivery,
			workspace_alias: "backend-primary",
			lease_expires_at: new Date(now - 1_000).toISOString(),
			hard_expires_at: new Date(now + 5_000).toISOString(),
		});
		const current = {
			...currentLease(original),
			lease_expires_at: new Date(now + 2_000).toISOString(),
		};

		expect(
			await capsuleResultValue(identity, "install_authority", {
				grant: original,
				current_lease: current,
			}),
		).toEqual({});
		expect(await capsuleResultValue(identity, "ensure_session", { input: sessionInput() })).toEqual(
			runtime.session,
		);
	});

	it("does not reset the one-shot turn budget on exact install replay", async () => {
		const runtime = new RecordingRuntime();
		const limits = authorityLimits({ turn_ms: 200 });
		const authority = authorityGrant({
			agent_id: IDS.participant,
			mission_id: IDS.mission,
			delivery_id: IDS.delivery,
			workspace_alias: "backend-primary",
			lease_expires_at: "2099-01-01T00:01:00.000Z",
			hard_expires_at: "2099-01-01T00:05:00.000Z",
			limit_sources: {
				product: limits,
				local: limits,
				mission: limits,
				runtime: limits,
			},
		});
		const { server, identity } = await startServer(runtime, { authority });
		await sendCapsuleRequest(identity, "start_turn", { input: turnInput(runtime.session) });
		await delay(120);
		await capsuleResultValue(identity, "install_authority", {
			grant: authority,
			current_lease: currentLease(authority),
		});

		await Promise.race([
			server.waitUntilClosed(),
			delay(130).then(() => {
				throw new Error("Exact grant replay reset the Capsule turn budget");
			}),
		]);
	});

	it("records redacted assert decisions and retires after revocation", async () => {
		const runtime = new RecordingRuntime();
		const evidence: RuntimeAuthorityEvidence[] = [];
		const { server, identity } = await startServer(runtime, { evidence });
		const allowed = runtimeAuthorityRequest(
			SERVER_AUTHORITY,
			{ action: "outbound_publish", resource: "relay" },
			{ output_bytes: 12 },
		);

		expect(await capsuleResultValue(identity, "assert_authority", { request: allowed })).toEqual(
			{},
		);
		const denied = await sendCapsuleRequest(identity, "assert_authority", {
			request: { ...allowed, workspace_alias: "wrong-workspace" },
		});
		expect(denied).toEqual([expect.objectContaining({ kind: "error", code: "authority_denied" })]);
		expect(evidence.map(({ decision, code }) => ({ decision, code }))).toEqual([
			{ decision: "allow", code: "allowed" },
			{ decision: "deny", code: "wrong_workspace" },
		]);
		expect(JSON.stringify(evidence)).not.toContain("wrong-workspace");

		expect(
			await capsuleResultValue(identity, "revoke_authority", {
				mission_id: IDS.mission,
				grant_id: SERVER_AUTHORITY.grant_id,
				reason: "revoked",
			}),
		).toEqual({});
		await server.waitUntilClosed();
	});

	it("renews only the installed lease without resetting the turn budget", async () => {
		const runtime = new RecordingRuntime();
		const { identity } = await startServer(runtime);

		expect(
			await capsuleResultValue(identity, "renew_authority", {
				mission_id: IDS.mission,
				renewal: {
					grant_id: SERVER_AUTHORITY.grant_id,
					lease_id: SERVER_AUTHORITY.lease_id,
					fencing_token: SERVER_AUTHORITY.fencing_token,
					lease_expires_at: "2099-01-01T00:02:00.000Z",
				},
			}),
		).toEqual({});
	});

	it("gates streamed output against the effective grant before publishing it", async () => {
		const runtime = new RecordingRuntime();
		const evidence: RuntimeAuthorityEvidence[] = [];
		const limits = authorityLimits({ output_bytes: 3 });
		const authority = authorityGrant({
			agent_id: IDS.participant,
			mission_id: IDS.mission,
			delivery_id: IDS.delivery,
			workspace_alias: "backend-primary",
			lease_expires_at: "2099-01-01T00:01:00.000Z",
			hard_expires_at: "2099-01-01T00:05:00.000Z",
			limit_sources: {
				product: limits,
				local: limits,
				mission: limits,
				runtime: limits,
			},
		});
		const { server, identity } = await startServer(runtime, { authority, evidence });

		const frames = await sendCapsuleRequest(identity, "start_turn", {
			input: turnInput(runtime.session),
		});
		expect(frames.map((frame) => frame.kind)).toEqual(["event", "event", "error"]);
		expect(eventPayloads(frames).map((event) => event.kind)).toEqual(["accepted", "usage"]);
		expect(frames.at(-1)).toMatchObject({ kind: "error", code: "authority_denied" });
		expect(evidence).toContainEqual(
			expect.objectContaining({
				action: "outbound_publish",
				decision: "deny",
				code: "budget_exceeded",
			}),
		);
		expect(JSON.stringify(evidence)).not.toContain("Done");
		await server.waitUntilClosed();
	});

	it("retires the detached runtime when its installed authority expires", async () => {
		const runtime = new RecordingRuntime();
		const now = Date.now();
		const authority = authorityGrant({
			agent_id: IDS.participant,
			mission_id: IDS.mission,
			delivery_id: IDS.delivery,
			workspace_alias: "backend-primary",
			lease_expires_at: new Date(now + 80).toISOString(),
			hard_expires_at: new Date(now + 2_000).toISOString(),
		});
		const { server } = await startServer(runtime, { authority });

		await server.waitUntilClosed();
		expect(runtime.closeCalls).toBe(1);
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

	it("removes its public socket when controller startup fails", async () => {
		const identity = await serverIdentity();
		await expect(
			PersistentCapsuleServer.start({
				identity,
				openController: async () => {
					throw new Error("controller startup failed");
				},
			}),
		).rejects.toThrow("controller startup failed");
		await expect(lstat(identity.socketPath)).rejects.toMatchObject({ code: "ENOENT" });

		const runtime = new RecordingRuntime();
		const server = await PersistentCapsuleServer.start({
			identity,
			openController: async () => new RecordingController(runtime),
		});
		servers.push(server);
		expect(await capsuleResultValue(identity, "probe", {})).toEqual(runtime.info);
	});

	it("opens a passive controller only for the server that wins socket ownership", async () => {
		const identity = await serverIdentity();
		const controllers: RecordingController[] = [];
		const openController = async () => {
			const runtime = new RecordingRuntime();
			const controller = new RecordingController(runtime);
			controllers.push(controller);
			return controller;
		};
		const results = await Promise.allSettled([
			PersistentCapsuleServer.start({ identity, openController }),
			PersistentCapsuleServer.start({ identity, openController }),
		]);
		const winners = results.flatMap((result) =>
			result.status === "fulfilled" ? [result.value] : [],
		);
		expect(winners).toHaveLength(1);
		expect(controllers).toHaveLength(1);
		expect(controllers[0]?.activations).toHaveLength(0);
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
			openController: async (lifecycle) => {
				retire = lifecycle.retire;
				return new RecordingController(runtime);
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

class RecordingController implements CapsuleRuntimeController {
	readonly activations: CapsuleRuntimeActivation[] = [];
	readonly #runtime: RecordingRuntime;
	activationGate: Deferred<void> | null = null;
	activationStarted: Deferred<void> | null = null;
	#closing: Promise<void> | null = null;

	constructor(runtime: RecordingRuntime) {
		this.#runtime = runtime;
	}

	probe() {
		return this.#runtime.probe();
	}

	lookupTurn(deliveryId: string, executionAttempt: number) {
		return this.#runtime.lookupTurn(deliveryId, executionAttempt);
	}

	async activate(authority: CapsuleRuntimeActivation): Promise<CapsuleRuntime> {
		this.activations.push(authority);
		this.activationStarted?.resolve();
		await this.activationGate?.promise;
		return this.#runtime;
	}

	close(): Promise<void> {
		this.#closing ??= this.#runtime.close();
		return this.#closing;
	}
}

async function startServer(
	runtime: RecordingRuntime,
	options: {
		readonly installAuthority?: boolean;
		readonly authority?: RuntimeAuthorityGrant;
		readonly evidence?: RuntimeAuthorityEvidence[];
	} = {},
) {
	const identity = await serverIdentity();
	const controller = new RecordingController(runtime);
	const server = await PersistentCapsuleServer.start({
		identity,
		authorityEvidenceSink:
			options.evidence === undefined
				? undefined
				: { record: (item) => options.evidence?.push(item) },
		openController: async () => controller,
	});
	servers.push(server);
	if (options.installAuthority !== false) {
		await capsuleResultValue(identity, "install_authority", {
			grant: options.authority ?? SERVER_AUTHORITY,
			current_lease: currentLease(options.authority ?? SERVER_AUTHORITY),
		});
	}
	return { server, identity, controller };
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

function currentLease(grant: RuntimeAuthorityGrant) {
	return {
		grant_id: grant.grant_id,
		lease_id: grant.lease_id,
		fencing_token: grant.fencing_token,
		lease_expires_at: grant.lease_expires_at,
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
