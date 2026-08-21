import { mkdtemp, realpath, rm } from "node:fs/promises";
import type { HostSessionRef, StartTurnInput } from "@agentrelay/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeCodexCapsuleClient } from "../test-support/fake-codex-capsule-client.js";
import type { CapsuleRuntimeActivation } from "./capsule-runtime.js";
import type { CodexTurn } from "./codex-app-server-protocol.js";
import type { CodexRunnerPatchCoordinator } from "./codex-capsule-runner-contract.js";
import { CodexCapsuleStore } from "./codex-capsule-store.js";
import { CODEX_DYNAMIC_PATCH_TOOL_CONTRACT } from "./codex-dynamic-patch-tool-contract.js";
import { CodexTerminalPatchPolicyMismatchError } from "./codex-dynamic-patch-tool.js";
import { CodexProviderEventSource } from "./codex-provider-event-source.js";
import { CodexTurnExecutor } from "./codex-turn-executor.js";
import {
	type CodexPatchToolCall,
	codexPatchKey,
	codexPatchSha256,
	codexPatchTransactionId,
} from "./codex-workspace-patch-contract.js";
import { codexPatchAuthorityRecord } from "./codex-workspace-patch-transaction.js";
import { authorityGrant } from "./runtime-authority.test-support.js";

const IDS = {
	capsule: "73000000-0000-4000-8000-000000000001",
	mission: "73000000-0000-4000-8000-000000000002",
	participant: "73000000-0000-4000-8000-000000000003",
	delivery: "73000000-0000-4000-8000-000000000004",
	owner: "73000000-0000-4000-8000-000000000005",
};

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("CodexTurnExecutor interrupt recovery", () => {
	it("fails an interrupt barrier inherited by a fresh generation without resending it", async () => {
		const directory = await realpath(await mkdtemp("/tmp/agentrelay-codex-executor-"));
		directories.push(directory);
		const store = await CodexCapsuleStore.open(directory, {
			capsuleId: IDS.capsule,
			session: sessionInput(),
		});
		await store.claimSessionStart();
		const session = await store.acceptSession("provider-thread-private-1");
		const input = turnInput(session);
		const turn = await store.prepareTurn(input, CODEX_DYNAMIC_PATCH_TOOL_CONTRACT);
		await store.claimTurnStart(input);
		await store.acceptTurn(input, "provider-turn-private-1");
		await store.requestCancellation(turn);
		expect(await store.claimInterrupt(turn)).toMatchObject({ kind: "send" });

		const client = new FakeCodexCapsuleClient(directory, "provider-thread-private-1");
		const providerEvents = new CodexProviderEventSource(client);
		const shutdown = new AbortController();
		const patchCoordinator = fakePatchCoordinator();
		const executor = new CodexTurnExecutor({
			store,
			client,
			providerEvents,
			cwd: directory,
			providerPollMs: 1,
			patchCoordinator,
			shutdownSignal: shutdown.signal,
		});

		await executor.run(input, turn, "provider-thread-private-1");

		const events = await store.eventsForTurn(turn, input);
		expect(events.map((event) => event.kind)).toEqual(["accepted", "usage", "failed"]);
		expect(events.at(-1)).toMatchObject({
			kind: "failed",
			failure: {
				class: "transient",
				message: "Codex cancellation outcome could not be recovered after provider shutdown",
			},
		});
		expect(client.interrupts).toEqual([]);
		expect(client.readCalls).toBe(1);
		expect(patchCoordinator.assertNoPatchCallsForAbandonment).toHaveBeenCalledWith(
			turn,
			"provider-thread-private-1",
			"provider-turn-private-1",
		);
		expect(JSON.stringify(events)).not.toContain("provider-thread-private-1");
		expect(JSON.stringify(events)).not.toContain("provider-turn-private-1");

		shutdown.abort();
		await client.close();
		await providerEvents.close();
		await store.close();
	});

	it("persists an exact terminal provider outcome instead of failing the recovered interrupt", async () => {
		const directory = await realpath(await mkdtemp("/tmp/agentrelay-codex-executor-"));
		directories.push(directory);
		const store = await CodexCapsuleStore.open(directory, {
			capsuleId: IDS.capsule,
			session: sessionInput(),
		});
		await store.claimSessionStart();
		const session = await store.acceptSession("provider-thread-private-1");
		const input = turnInput(session);
		const turn = await store.prepareTurn(input, CODEX_DYNAMIC_PATCH_TOOL_CONTRACT);
		const start = await store.claimTurnStart(input);
		if (start.kind !== "send") throw new Error("Expected a new Codex turn claim");

		const client = new FakeCodexCapsuleClient(directory, "provider-thread-private-1");
		const providerTurn = client.seedTurn(start.intent, "interrupted");
		await store.acceptTurn(input, providerTurn.id);
		await store.requestCancellation(turn);
		expect(await store.claimInterrupt(turn)).toMatchObject({ kind: "send" });

		const providerEvents = new CodexProviderEventSource(client);
		const shutdown = new AbortController();
		const patchCoordinator = fakePatchCoordinator();
		const executor = new CodexTurnExecutor({
			store,
			client,
			providerEvents,
			cwd: directory,
			providerPollMs: 1,
			patchCoordinator,
			shutdownSignal: shutdown.signal,
		});

		await executor.run(input, turn, "provider-thread-private-1");

		const events = await store.eventsForTurn(turn, input);
		expect(events.map((event) => event.kind)).toEqual(["accepted", "usage", "cancelled"]);
		expect(client.readCalls).toBe(1);
		expect(client.interrupts).toEqual([]);
		expect(patchCoordinator.attestTerminal).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(events)).not.toContain("provider-thread-private-1");
		expect(JSON.stringify(events)).not.toContain(providerTurn.id);

		shutdown.abort();
		await client.close();
		await providerEvents.close();
		await store.close();
	});
});

describe("CodexTurnExecutor terminal patch proof", () => {
	it("leaves a terminal provider result recoverable when attestation is unproven", async () => {
		const patchCoordinator = fakePatchCoordinator({
			attestTerminal: vi.fn(async () => {
				throw new Error("mediator inspection unavailable");
			}),
		});
		const fixture = await boundExecutorFixture("completed", patchCoordinator);

		await expect(
			fixture.executor.run(fixture.input, fixture.turn, "provider-thread-private-1"),
		).rejects.toThrow("mediator inspection unavailable");
		expect(await fixture.store.inspectTurn(fixture.turn, fixture.input)).toMatchObject({
			phase: "accepted",
			terminal: false,
		});
		expect((await fixture.store.eventsForTurn(fixture.turn, fixture.input)).map(eventKind)).toEqual(
			["accepted"],
		);
		await closeExecutorFixture(fixture);
	});

	it("durably records a definitive patch mismatch and lets it dominate cancellation", async () => {
		const patchCoordinator = fakePatchCoordinator({
			attestTerminal: vi.fn(async () => {
				throw new CodexTerminalPatchPolicyMismatchError();
			}),
		});
		const fixture = await boundExecutorFixture("inProgress", patchCoordinator);
		await fixture.store.requestCancellation(fixture.turn);

		await fixture.executor.run(fixture.input, fixture.turn, "provider-thread-private-1");

		const events = await fixture.store.eventsForTurn(fixture.turn, fixture.input);
		expect(events.map(eventKind)).toEqual(["accepted", "usage", "failed"]);
		expect(events.at(-1)).toMatchObject({
			kind: "failed",
			failure: {
				class: "policy_denied",
				message: "Codex patch outcome could not be attested",
			},
		});
		expect(fixture.client.interrupts).toHaveLength(1);
		await closeExecutorFixture(fixture);
	});

	it("does not let cancellation mask an attested fatal patch failure", async () => {
		const patchCoordinator = fakePatchCoordinator({
			attestTerminal: vi.fn(async (_ref, _threadId, turn) => ({
				...emptyAttestation(turn),
				fatalPatchFailure: true,
			})),
		});
		const fixture = await boundExecutorFixture("inProgress", patchCoordinator);
		await fixture.store.requestCancellation(fixture.turn);

		await fixture.executor.run(fixture.input, fixture.turn, "provider-thread-private-1");

		const events = await fixture.store.eventsForTurn(fixture.turn, fixture.input);
		expect(events.map(eventKind)).toEqual(["accepted", "usage", "failed"]);
		expect(events.at(-1)).toMatchObject({
			kind: "failed",
			failure: {
				class: "transient",
				message: "Codex patch tool failed before a publishable turn result",
			},
		});
		await closeExecutorFixture(fixture);
	});

	it("linearizes cancellation that commits while interrupted-turn attestation is blocked", async () => {
		const attestationStarted = deferred<void>();
		const releaseAttestation = deferred<void>();
		const patchCoordinator = fakePatchCoordinator({
			attestTerminal: vi.fn(async (_ref, _threadId, turn) => {
				attestationStarted.resolve(undefined);
				await releaseAttestation.promise;
				return emptyAttestation(turn);
			}),
		});
		const fixture = await boundExecutorFixture("interrupted", patchCoordinator);
		const running = fixture.executor.run(fixture.input, fixture.turn, "provider-thread-private-1");
		await attestationStarted.promise;
		await fixture.store.requestCancellation(fixture.turn);
		releaseAttestation.resolve(undefined);
		await running;

		expect((await fixture.store.eventsForTurn(fixture.turn, fixture.input)).map(eventKind)).toEqual(
			["accepted", "usage", "cancelled"],
		);
		await closeExecutorFixture(fixture);
	});

	it("does not let concurrent cancellation mask an interrupted capability violation", async () => {
		const attestationStarted = deferred<void>();
		const releaseAttestation = deferred<void>();
		const patchCoordinator = fakePatchCoordinator({
			attestTerminal: vi.fn(async (_ref, _threadId, turn) => {
				attestationStarted.resolve(undefined);
				await releaseAttestation.promise;
				return emptyAttestation(turn);
			}),
		});
		const fixture = await boundExecutorFixture("interrupted", patchCoordinator);
		fixture.providerState.turns[0]!.items.push({
			type: "mcpToolCall",
			id: "unexpected-capability",
		});
		const running = fixture.executor.run(fixture.input, fixture.turn, "provider-thread-private-1");
		await attestationStarted.promise;
		await fixture.store.requestCancellation(fixture.turn);
		releaseAttestation.resolve(undefined);
		await running;

		expect((await fixture.store.eventsForTurn(fixture.turn, fixture.input)).at(-1)).toMatchObject({
			kind: "failed",
			failure: { class: "policy_denied" },
		});
		await closeExecutorFixture(fixture);
	});

	it("preserves an interrupted failure when terminal persistence wins before cancellation", async () => {
		const fixture = await boundExecutorFixture("interrupted", fakePatchCoordinator());
		await fixture.executor.run(fixture.input, fixture.turn, "provider-thread-private-1");
		await fixture.store.requestCancellation(fixture.turn);

		const events = await fixture.store.eventsForTurn(fixture.turn, fixture.input);
		expect(events.map(eventKind)).toEqual(["accepted", "usage", "failed"]);
		expect(events.at(-1)).toMatchObject({
			kind: "failed",
			failure: {
				class: "transient",
				message: "Codex turn stopped without a local cancellation intent",
			},
		});
		await closeExecutorFixture(fixture);
	});

	it("does not cold-terminalize a bound in-progress turn with a durable patch receipt", async () => {
		const authority = codexPatchAuthorityRecord(testAuthority());
		let durableCalls = 0;
		const patchCoordinator = fakePatchCoordinator({
			assertNoPatchCallsForAbandonment: vi.fn(async (ref) => {
				durableCalls = (await fixture.store.patchCallsForTurn(ref, authority)).calls.length;
				throw new Error("durable patch call prevents abandonment");
			}),
		});
		const fixture = await boundExecutorFixture("inProgress", patchCoordinator);
		const claim = await fixture.store.claimPatchCall({
			providerThreadId: "provider-thread-private-1",
			providerTurnId: fixture.providerTurn.id,
			callId: "crash-after-receipt",
			patch: "diff --git a/a b/a\n",
			authority,
		});
		if (claim.kind !== "pending") throw new Error("Expected a pending patch request");
		await fixture.store.recordPatchCallReceipt(claim.call, authority, {
			outcome: "applied",
			result: appliedResult(claim.call),
		});

		await expect(
			fixture.executor.run(fixture.input, fixture.turn, "provider-thread-private-1"),
		).rejects.toThrow("durable patch call prevents abandonment");
		expect(durableCalls).toBe(1);
		expect(await fixture.store.inspectTurn(fixture.turn, fixture.input)).toMatchObject({
			phase: "accepted",
			terminal: false,
		});
		expect(fixture.client.turnStarts).toEqual([]);
		expect(fixture.client.interrupts).toEqual([]);
		expect(fixture.client.readCalls).toBe(1);
		await closeExecutorFixture(fixture);
	});

	it("does not close an uncertain interrupt when a durable patch receipt exists", async () => {
		const authority = codexPatchAuthorityRecord(testAuthority());
		const patchCoordinator = fakePatchCoordinator({
			assertNoPatchCallsForAbandonment: vi.fn(async () => {
				throw new Error("durable patch call prevents cancellation abandonment");
			}),
		});
		const fixture = await boundExecutorFixture("inProgress", patchCoordinator);
		const claim = await fixture.store.claimPatchCall({
			providerThreadId: "provider-thread-private-1",
			providerTurnId: fixture.providerTurn.id,
			callId: "crash-before-interrupt-response",
			patch: "diff --git a/a b/a\n",
			authority,
		});
		if (claim.kind !== "pending") throw new Error("Expected a pending patch request");
		await fixture.store.recordPatchCallReceipt(claim.call, authority, {
			outcome: "applied",
			result: appliedResult(claim.call),
		});
		await fixture.store.requestCancellation(fixture.turn);
		expect(await fixture.store.claimInterrupt(fixture.turn)).toMatchObject({ kind: "send" });

		await expect(
			fixture.executor.run(fixture.input, fixture.turn, "provider-thread-private-1"),
		).rejects.toThrow("durable patch call prevents cancellation abandonment");
		expect(await fixture.store.inspectTurn(fixture.turn, fixture.input)).toMatchObject({
			phase: "cancelling",
			terminal: false,
		});
		expect(fixture.client.interrupts).toEqual([]);
		expect(fixture.client.readCalls).toBe(1);
		await closeExecutorFixture(fixture);
	});
});

describe("CodexTurnExecutor cold read failures", () => {
	it("keeps unbound, bound, and uncertain-interrupt turns nonterminal", async () => {
		for (const mode of ["unbound", "bound", "interrupt"] as const) {
			const fixture = await coldReadFailureFixture(mode);
			await expect(
				fixture.executor.run(fixture.input, fixture.turn, "provider-thread-private-1"),
			).rejects.toThrow("authoritative thread read failed");
			expect(await fixture.store.inspectTurn(fixture.turn, fixture.input)).toMatchObject({
				terminal: false,
			});
			expect(
				(await fixture.store.eventsForTurn(fixture.turn, fixture.input)).map(eventKind),
			).toEqual(["accepted"]);
			await closeExecutorFixture(fixture);
		}
	});
});

function fakePatchCoordinator(
	overrides: Partial<CodexRunnerPatchCoordinator> = {},
): CodexRunnerPatchCoordinator {
	return {
		recover: vi.fn(async () => undefined),
		handle: vi.fn(async () => "fatal_rejected" as const),
		assertNoPatchCallsForAbandonment: vi.fn(async () => undefined),
		attestTerminal: vi.fn(async (_ref, _threadId, turn) => emptyAttestation(turn)),
		close: vi.fn(async () => undefined),
		...overrides,
	};
}

function emptyAttestation(turn: CodexTurn) {
	return Object.freeze({
		providerTurnId: turn.id,
		fatalPatchFailure: false,
		calls: Object.freeze([]),
	});
}

async function boundExecutorFixture(
	status: CodexTurn["status"],
	patchCoordinator: CodexRunnerPatchCoordinator,
) {
	const directory = await realpath(await mkdtemp("/tmp/agentrelay-codex-executor-"));
	directories.push(directory);
	const store = await CodexCapsuleStore.open(directory, {
		capsuleId: IDS.capsule,
		session: sessionInput(),
	});
	await store.claimSessionStart();
	const session = await store.acceptSession("provider-thread-private-1");
	const input = turnInput(session);
	const turn = await store.prepareTurn(input, CODEX_DYNAMIC_PATCH_TOOL_CONTRACT);
	const start = await store.claimTurnStart(input);
	if (start.kind !== "send") throw new Error("Expected a provider start claim");
	const providerState: { turns: CodexTurn[] } = { turns: [] };
	const client = new FakeCodexCapsuleClient(directory, "provider-thread-private-1", providerState);
	const providerTurn = client.seedTurn(start.intent, status);
	await store.acceptTurn(input, providerTurn.id);
	const providerEvents = new CodexProviderEventSource(client);
	const shutdown = new AbortController();
	const executor = new CodexTurnExecutor({
		store,
		client,
		providerEvents,
		cwd: directory,
		providerPollMs: 1,
		patchCoordinator,
		shutdownSignal: shutdown.signal,
	});
	return {
		directory,
		store,
		input,
		turn,
		client,
		providerTurn,
		providerState,
		providerEvents,
		shutdown,
		executor,
	};
}

async function coldReadFailureFixture(mode: "unbound" | "bound" | "interrupt") {
	const patchCoordinator = fakePatchCoordinator();
	const directory = await realpath(await mkdtemp("/tmp/agentrelay-codex-executor-"));
	directories.push(directory);
	const store = await CodexCapsuleStore.open(directory, {
		capsuleId: IDS.capsule,
		session: sessionInput(),
	});
	await store.claimSessionStart();
	const session = await store.acceptSession("provider-thread-private-1");
	const input = turnInput(session);
	const turn = await store.prepareTurn(input, CODEX_DYNAMIC_PATCH_TOOL_CONTRACT);
	await store.claimTurnStart(input);
	if (mode !== "unbound") {
		await store.acceptTurn(input, "provider-turn-private-1");
	}
	if (mode === "interrupt") {
		await store.requestCancellation(turn);
		expect(await store.claimInterrupt(turn)).toMatchObject({ kind: "send" });
	}
	const client = new FakeCodexCapsuleClient(directory, "provider-thread-private-1");
	vi.spyOn(client, "readThread").mockRejectedValue(new Error("authoritative thread read failed"));
	const providerEvents = new CodexProviderEventSource(client);
	const shutdown = new AbortController();
	const executor = new CodexTurnExecutor({
		store,
		client,
		providerEvents,
		cwd: directory,
		providerPollMs: 1,
		patchCoordinator,
		shutdownSignal: shutdown.signal,
	});
	return { store, input, turn, client, providerEvents, shutdown, executor };
}

async function closeExecutorFixture(fixture: {
	readonly shutdown: AbortController;
	readonly client: FakeCodexCapsuleClient;
	readonly providerEvents: CodexProviderEventSource;
	readonly store: CodexCapsuleStore;
}): Promise<void> {
	fixture.shutdown.abort();
	await fixture.client.close();
	await fixture.providerEvents.close();
	await fixture.store.close();
}

function appliedResult(call: CodexPatchToolCall) {
	return {
		transactionId: codexPatchTransactionId(codexPatchKey(call)),
		patchSha256: codexPatchSha256(call.patch),
		planSha256: "b".repeat(64),
		filesChanged: 1,
	};
}

function testAuthority(): CapsuleRuntimeActivation {
	const base = authorityGrant();
	return {
		grant: authorityGrant({
			mission_id: IDS.mission,
			delivery_id: IDS.delivery,
			workspace_alias: "backend-primary",
			capabilities: [...base.capabilities, { action: "workspace_write", resource: "workspace" }],
		}),
		signal: new AbortController().signal,
		performWorkspaceRead: async (effect) => effect(),
		performWorkspaceWrite: async (effect) => effect(),
	};
}

function eventKind(event: { readonly kind: string }): string {
	return event.kind;
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

function sessionInput() {
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
