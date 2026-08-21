import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostSessionRef, StartTurnInput } from "@agentrelay/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { CapsuleOperationError } from "./capsule-operation-error.js";
import type { CapsuleRuntimeActivation } from "./capsule-runtime.js";
import {
	CODEX_PATCH_MAX_CALLS_PER_TURN,
	CODEX_PATCH_MAX_RETAINED_RAW_BYTES_PER_TURN,
} from "./codex-capsule-state.js";
import { CODEX_CAPSULE_STATE_FILE, CodexCapsuleStore } from "./codex-capsule-store.js";
import { CODEX_DYNAMIC_PATCH_TOOL_CONTRACT } from "./codex-dynamic-patch-tool-contract.js";
import {
	type CodexPatchToolCall,
	codexPatchKey,
	codexPatchSha256,
	codexPatchTransactionId,
} from "./codex-workspace-patch-contract.js";
import { codexPatchAuthorityRecord } from "./codex-workspace-patch-transaction.js";
import { MAX_PRIVATE_STATE_FILE_BYTES } from "./private-state-file.js";
import { authorityGrant } from "./runtime-authority.test-support.js";

const IDS = {
	capsule: "70000000-0000-4000-8000-000000000001",
	mission: "70000000-0000-4000-8000-000000000002",
	participant: "70000000-0000-4000-8000-000000000003",
	delivery: "70000000-0000-4000-8000-000000000004",
	delivery2: "70000000-0000-4000-8000-000000000005",
	owner: "70000000-0000-4000-8000-000000000006",
};

const directories: string[] = [];

const PATCH_AUTHORITY = codexPatchAuthorityRecord(testAuthority());

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("CodexCapsuleStore", () => {
	it("returns the stable local session before opening a provider session barrier", async () => {
		const { store } = await openStore();
		const input = {
			missionId: IDS.mission,
			participantId: IDS.participant,
			workspaceAlias: "backend-primary",
		};

		const session = await store.ensureSession(input);

		expect(session).toEqual({ ...input, sessionId: expect.stringMatching(/^capsule-session-/) });
		expect(await store.ensureSession(input)).toEqual(session);
		expect(await store.claimSessionStart()).toEqual({ kind: "send" });
		await expect(
			store.ensureSession({ ...input, workspaceAlias: "other-workspace" }),
		).rejects.toMatchObject<CapsuleOperationError>({ code: "scope_mismatch" });
	});

	it("persists an at-most-once session start barrier and stable local session identity", async () => {
		const { directory, store } = await openStore();
		expect(
			JSON.parse(await readFile(join(directory, CODEX_CAPSULE_STATE_FILE), "utf8")),
		).toMatchObject({ schema_version: 4 });
		expect(await store.claimSessionStart()).toEqual({ kind: "send" });
		await store.close();

		const reopened = await reopenStore(directory);
		expect(await reopened.claimSessionStart()).toEqual({ kind: "reconcile" });
		const session = await reopened.acceptSession("provider-thread-private-1");
		expect(session.sessionId).toMatch(/^capsule-session-/);
		await reopened.close();

		const recovered = await reopenStore(directory);
		expect(await recovered.claimSessionStart()).toEqual({
			kind: "ready",
			session,
			threadId: "provider-thread-private-1",
		});
		const persisted = JSON.parse(
			await readFile(join(directory, CODEX_CAPSULE_STATE_FILE), "utf8"),
		) as Record<string, unknown>;
		expect(persisted).toMatchObject({ session: { host_session_id: session.sessionId } });
		expect((await stat(join(directory, CODEX_CAPSULE_STATE_FILE))).mode & 0o777).toBe(0o600);
	});

	it("journals exact provider intent before start and reconciles instead of resending", async () => {
		const { directory, store, session } = await readyStore();
		const input = turnInput(session);
		await store.prepareTurn(input);
		const firstClaim = await store.claimTurnStart(input);
		expect(firstClaim).toMatchObject({
			kind: "send",
			intent: { clientUserMessageId: `${IDS.delivery}:1` },
		});
		if (firstClaim.kind !== "send") throw new Error("Expected one provider start claim");
		expect(firstClaim.intent.text).toContain("MISSION_DATA_JSON_BEGIN");
		await store.close();

		const reopened = await reopenStore(directory);
		const secondClaim = await reopened.claimTurnStart(input);
		expect(secondClaim).toMatchObject({
			kind: "reconcile",
			intent: {
				clientUserMessageId: firstClaim.intent.clientUserMessageId,
				textSha256: firstClaim.intent.textSha256,
			},
		});
		const turn = await reopened.acceptTurn(input, "provider-turn-private-1");
		expect(turn.turnId).not.toBe("provider-turn-private-1");
		expect(await reopened.lookupTurn(IDS.delivery, 1)).toEqual(turn);
		expect(await reopened.eventsForTurn(turn, input)).toEqual([
			{ kind: "accepted", turn, sequence: 1 },
		]);
	});

	it("binds prompt v2 to the exact nullable dynamic patch contract", async () => {
		const { directory, store, session } = await readyStore();
		const input = turnInput(session);
		const turn = await store.prepareTurn(input, CODEX_DYNAMIC_PATCH_TOOL_CONTRACT);
		const claim = await store.claimTurnStart(input);
		expect(claim).toMatchObject({
			kind: "send",
			intent: {
				promptVersion: 2,
				toolContract: CODEX_DYNAMIC_PATCH_TOOL_CONTRACT,
			},
		});
		expect(await store.prepareTurn(input, CODEX_DYNAMIC_PATCH_TOOL_CONTRACT)).toEqual(turn);
		await expect(store.prepareTurn(input)).rejects.toMatchObject<CapsuleOperationError>({
			code: "correlation_conflict",
		});
		const persisted = JSON.parse(
			await readFile(join(directory, CODEX_CAPSULE_STATE_FILE), "utf8"),
		) as { turns: Record<string, { provider_intent: Record<string, unknown> }> };
		expect(persisted.turns[`${IDS.delivery}:1`]!.provider_intent).toMatchObject({
			prompt_version: 2,
			tool_contract: CODEX_DYNAMIC_PATCH_TOOL_CONTRACT,
		});
	});

	it("does not admit a patch for a read-only provider intent", async () => {
		const { store, session } = await readyStore();
		const input = turnInput(session);
		const turn = await store.prepareTurn(input);
		await store.claimTurnStart(input);

		await expect(
			store.claimPatchCall(patchRequest("not-enabled", "patch")),
		).rejects.toMatchObject<CapsuleOperationError>({ code: "correlation_conflict" });
		expect(await store.inspectTurn(turn, input)).toMatchObject({
			phase: "start_maybe_sent",
			codexTurnId: null,
		});
	});

	it("persists the exact patch request before work and scrubs raw input only after its receipt", async () => {
		const { directory, store, session } = await readyStore();
		const input = turnInput(session);
		const turn = await store.prepareTurn(input, CODEX_DYNAMIC_PATCH_TOOL_CONTRACT);
		await store.claimTurnStart(input);
		const request = patchRequest("call-1", "first patch");

		const first = await store.claimPatchCall(request);
		expect(first).toMatchObject({ kind: "pending", replayed: false });
		if (first.kind !== "pending") throw new Error("Expected a pending patch call");
		expect(first.call.hostTurn).toEqual(turn);
		expect(await store.inspectTurn(turn, input)).toMatchObject({
			phase: "accepted",
			codexTurnId: request.providerTurnId,
		});
		await store.close();

		const reopened = await reopenStore(directory);
		expect(await reopened.claimPatchCall(request)).toEqual({
			kind: "pending",
			call: first.call,
			replayed: true,
		});
		await expect(
			reopened.claimPatchCall({ ...request, patch: "changed patch" }),
		).rejects.toMatchObject<CapsuleOperationError>({ code: "correlation_conflict" });

		const receipt = { outcome: "applied" as const, result: appliedResult(first.call) };
		expect(await reopened.recordPatchCallReceipt(first.call, PATCH_AUTHORITY, receipt)).toEqual(
			receipt,
		);
		expect(await reopened.claimPatchCall(request)).toEqual({
			kind: "terminal",
			receipt,
			replayed: true,
		});
		const attestation = await reopened.patchCallsForTurn(turn, PATCH_AUTHORITY);
		expect(attestation).toEqual({
			threadId: request.providerThreadId,
			providerTurnId: request.providerTurnId,
			toolContract: CODEX_DYNAMIC_PATCH_TOOL_CONTRACT,
			calls: [
				{
					providerThreadId: request.providerThreadId,
					providerTurnId: request.providerTurnId,
					callId: request.callId,
					transactionId: codexPatchTransactionId(codexPatchKey(first.call)),
					patchSha256: codexPatchSha256(request.patch),
					patchBytes: Buffer.byteLength(request.patch, "utf8"),
					receipt,
				},
			],
		});
		expect(JSON.stringify(attestation)).not.toContain(request.patch);
		expect(Object.isFrozen(attestation.calls)).toBe(true);
		const persisted = JSON.parse(
			await readFile(join(directory, CODEX_CAPSULE_STATE_FILE), "utf8"),
		) as { turns: Record<string, { patch_calls: Record<string, unknown> }> };
		const record = Object.values(persisted.turns[`${IDS.delivery}:1`]!.patch_calls)[0] as {
			patch: string | null;
			receipt: unknown;
		};
		expect(record).toMatchObject({ patch: null, receipt });
		expect(JSON.stringify(record)).not.toContain("first patch");
	});

	it("durably orders cancellation against patch admission", async () => {
		const { store, session } = await readyStore();
		const input = turnInput(session);
		const turn = await store.prepareTurn(input, CODEX_DYNAMIC_PATCH_TOOL_CONTRACT);
		await store.claimTurnStart(input);
		await store.requestCancellation(turn);

		expect(await store.claimPatchCall(patchRequest("cancelled-call", "never apply"))).toEqual({
			kind: "terminal",
			receipt: { outcome: "rejected", source: "capsule_policy" },
			replayed: false,
		});
		expect(await store.inspectTurn(turn, input)).toMatchObject({
			phase: "cancelling",
			codexTurnId: "provider-turn-private-1",
			cancellationRequested: true,
		});
		expect(await store.claimInterrupt(turn)).toMatchObject({
			kind: "send",
			codexTurnId: "provider-turn-private-1",
		});
	});

	it("rejects successor authority on every patch request and receipt path", async () => {
		const { store, session } = await readyStore();
		const input = turnInput(session);
		const turn = await store.prepareTurn(input, CODEX_DYNAMIC_PATCH_TOOL_CONTRACT);
		await store.claimTurnStart(input);
		const request = patchRequest("authority-bound", "patch");
		const claim = await store.claimPatchCall(request);
		if (claim.kind !== "pending") throw new Error("Expected pending request");
		const successorAuthority = codexPatchAuthorityRecord(
			testAuthority({
				grant_id: "70000000-0000-4000-8000-000000000007",
				lease_id: "70000000-0000-4000-8000-000000000008",
				fencing_token: "9007199254740994",
			}),
		);
		const successorRequest = { ...request, authority: successorAuthority };

		await expect(
			store.inspectPatchCall(successorRequest),
		).rejects.toMatchObject<CapsuleOperationError>({ code: "correlation_conflict" });
		await expect(
			store.claimPatchCall(successorRequest),
		).rejects.toMatchObject<CapsuleOperationError>({ code: "correlation_conflict" });
		await expect(
			store.pendingPatchCalls(successorAuthority),
		).rejects.toMatchObject<CapsuleOperationError>({ code: "correlation_conflict" });
		await expect(
			store.patchCallsForTurn(turn, successorAuthority),
		).rejects.toMatchObject<CapsuleOperationError>({ code: "scope_mismatch" });
		await expect(
			store.recordPatchCallReceipt(claim.call, successorAuthority, {
				outcome: "applied",
				result: appliedResult(claim.call),
			}),
		).rejects.toMatchObject<CapsuleOperationError>({ code: "correlation_conflict" });
		expect(await store.pendingPatchCalls(PATCH_AUTHORITY)).toEqual([claim.call]);
	});

	it("bounds patch call records and aggregate retained raw bytes per Host turn", async () => {
		const first = await readyStore();
		const firstInput = turnInput(first.session);
		const firstTurn = await first.store.prepareTurn(firstInput, CODEX_DYNAMIC_PATCH_TOOL_CONTRACT);
		await first.store.claimTurnStart(firstInput);
		await first.store.requestCancellation(firstTurn);
		for (let index = 0; index < CODEX_PATCH_MAX_CALLS_PER_TURN; index += 1) {
			expect(
				await first.store.claimPatchCall(patchRequest(`bounded-${index}`, `patch-${index}`)),
			).toMatchObject({
				kind: "terminal",
				receipt: { outcome: "rejected", source: "capsule_policy" },
			});
		}
		await expect(
			first.store.claimPatchCall(patchRequest("bounded-overflow", "overflow")),
		).rejects.toMatchObject<CapsuleOperationError>({ code: "correlation_conflict" });

		const second = await readyStore();
		const secondInput = turnInput(second.session);
		await acceptPreparedPatchTurn(second.store, secondInput);
		const retained = "a".repeat(Math.floor(CODEX_PATCH_MAX_RETAINED_RAW_BYTES_PER_TURN * 0.6));
		const overflow = "b".repeat(Math.floor(CODEX_PATCH_MAX_RETAINED_RAW_BYTES_PER_TURN * 0.6));
		expect(await second.store.claimPatchCall(patchRequest("retained", retained))).toMatchObject({
			kind: "pending",
		});
		expect(await second.store.claimPatchCall(patchRequest("aggregate-overflow", overflow))).toEqual(
			{
				kind: "terminal",
				receipt: { outcome: "rejected", source: "capsule_policy" },
				replayed: false,
			},
		);
		expect(await second.store.pendingPatchCalls(PATCH_AUTHORITY)).toHaveLength(1);
	});

	it("publishes a stable logical turn before provider binding and cancels before send", async () => {
		const { store, session } = await readyStore();
		const input = turnInput(session);
		const turn = await store.prepareTurn(input);
		expect(await store.lookupTurn(IDS.delivery, 1)).toEqual(turn);
		expect(await store.eventsForTurn(turn, input)).toEqual([
			{ kind: "accepted", turn, sequence: 1 },
		]);

		await store.requestCancellation(turn);
		expect((await store.eventsForTurn(turn, input)).map((event) => event.kind)).toEqual([
			"accepted",
			"usage",
			"cancelled",
		]);
		expect(await store.claimTurnStart(input)).toMatchObject({
			kind: "accepted",
			turn,
			terminal: true,
		});
	});

	it("carries pre-binding cancellation through reconciliation to one interrupt", async () => {
		const { store, session } = await readyStore();
		const input = turnInput(session);
		const turn = await store.prepareTurn(input);
		await store.claimTurnStart(input);
		await store.requestCancellation(turn);
		expect(await store.claimInterrupt(turn)).toEqual({ kind: "awaiting_provider" });
		expect((await store.claimTurnStart(input)).kind).toBe("reconcile");

		await store.acceptTurn(input, "provider-turn-private-1");
		expect(await store.claimInterrupt(turn)).toEqual({
			kind: "send",
			threadId: "provider-thread-private-1",
			codexTurnId: "provider-turn-private-1",
		});
		expect(await store.claimInterrupt(turn)).toEqual({ kind: "reconcile" });
	});

	it("durably abandons a proven zero-match without reopening the execution attempt", async () => {
		const { store, session } = await readyStore();
		const input = turnInput(session);
		const turn = await store.prepareTurn(input);
		await store.claimTurnStart(input);
		const events = await store.recordUnmatchedStartAfterQuiescence(turn, input);
		expect(events.map((event) => event.kind)).toEqual(["accepted", "usage", "failed"]);
		expect(await store.claimTurnStart(input)).toMatchObject({ kind: "accepted", terminal: true });

		const next = turnInput(session, IDS.delivery2);
		await store.prepareTurn(next);
		expect((await store.claimTurnStart(next)).kind).toBe("send");
	});

	it("rejects changed duplicate input and a second active execution", async () => {
		const { store, session } = await readyStore();
		const input = turnInput(session);
		await store.prepareTurn(input);
		await expect(
			store.prepareTurn({ ...input, assignment: { ...input.assignment, text: "Changed" } }),
		).rejects.toMatchObject<CapsuleOperationError>({ code: "correlation_conflict" });
		await expect(
			store.prepareTurn(turnInput(session, IDS.delivery2)),
		).rejects.toMatchObject<CapsuleOperationError>({ code: "correlation_conflict" });
	});

	it("persists bounded terminal replay and permits the next execution", async () => {
		const { directory, store, session } = await readyStore();
		const input = turnInput(session);
		const turn = await acceptPreparedTurn(store, input);
		const usage = {
			available: true as const,
			scope: "turn_cumulative" as const,
			inputTokens: 40,
			outputTokens: 8,
		};
		const outcome = {
			kind: "completed" as const,
			disposition: { kind: "reply" as const, message_type: "progress" as const, message: "Done" },
		};
		const events = await store.recordTerminal(turn, usage, outcome);
		expect(events.map((event) => event.kind)).toEqual(["accepted", "usage", "completed"]);
		expect(await store.recordTerminal(turn, usage, outcome)).toEqual(events);
		await expect(
			store.recordTerminal(turn, usage, {
				kind: "completed",
				disposition: { kind: "reply", message_type: "progress", message: "Different" },
			}),
		).rejects.toMatchObject<CapsuleOperationError>({ code: "correlation_conflict" });
		await store.close();

		const reopened = await reopenStore(directory);
		expect(await reopened.eventsForTurn(turn, input)).toEqual(events);
		await reopened.prepareTurn(turnInput(session, IDS.delivery2));
		expect((await reopened.claimTurnStart(turnInput(session, IDS.delivery2))).kind).toBe("send");
	});

	it("never invents cancellation before the provider reaches a terminal state", async () => {
		const { directory, store, session } = await readyStore();
		const input = turnInput(session);
		const turn = await acceptPreparedTurn(store, input);
		await store.requestCancellation(turn);
		expect(await store.claimInterrupt(turn)).toEqual({
			kind: "send",
			threadId: "provider-thread-private-1",
			codexTurnId: "provider-turn-private-1",
		});
		expect(await store.eventsForTurn(turn, input)).toHaveLength(1);
		await store.close();

		const reopened = await reopenStore(directory);
		expect(await reopened.claimInterrupt(turn)).toEqual({ kind: "reconcile" });
		const events = await reopened.recordTerminal(
			turn,
			{ available: false, reason: "not_reported" },
			{ kind: "cancelled" },
		);
		expect(events.map((event) => event.kind)).toEqual(["accepted", "usage", "cancelled"]);
	});

	it("fails an uncertain interrupt after quiescence without exposing provider references", async () => {
		const { directory, store, session } = await readyStore();
		const input = turnInput(session);
		const turn = await acceptPreparedTurn(store, input);
		await store.requestCancellation(turn);
		expect(await store.claimInterrupt(turn)).toMatchObject({ kind: "send" });
		await store.close();

		const reopened = await reopenStore(directory);
		const events = await reopened.recordUncertainInterruptAfterQuiescence(turn, input);
		expect(events).toEqual([
			{ kind: "accepted", turn, sequence: 1 },
			{
				kind: "usage",
				turn,
				sequence: 2,
				usage: { available: false, reason: "not_reported" },
			},
			{
				kind: "failed",
				turn,
				sequence: 3,
				failure: {
					class: "transient",
					message: "Codex cancellation outcome could not be recovered after provider shutdown",
				},
			},
		]);
		expect(JSON.stringify(events)).not.toContain("provider-thread-private-1");
		expect(JSON.stringify(events)).not.toContain("provider-turn-private-1");
		expect(await reopened.recordUncertainInterruptAfterQuiescence(turn, input)).toEqual(events);
		expect(await reopened.claimInterrupt(turn)).toEqual({ kind: "terminal" });
	});

	it("rejects a cancelled terminal without durable local cancellation", async () => {
		const { store, session } = await readyStore();
		const input = turnInput(session);
		const turn = await acceptPreparedTurn(store, input);
		await expect(
			store.recordTerminal(
				turn,
				{ available: false, reason: "not_reported" },
				{ kind: "cancelled" },
			),
		).rejects.toMatchObject<CapsuleOperationError>({ code: "correlation_conflict" });
	});

	it("rejects non-private state files", async () => {
		const { directory, store } = await openStore();
		await store.close();
		await chmod(join(directory, CODEX_CAPSULE_STATE_FILE), 0o644);
		await expect(reopenStore(directory)).rejects.toThrow(/mode 0600/);
	});

	it("fails closed on the prior Capsule state version instead of reinterpreting it", async () => {
		const { directory, store } = await openStore();
		await store.close();
		const path = join(directory, CODEX_CAPSULE_STATE_FILE);
		const state = JSON.parse(await readFile(path, "utf8")) as { schema_version: number };
		state.schema_version = 3;
		await writeFile(path, JSON.stringify(state), { mode: 0o600 });

		await expect(reopenStore(directory)).rejects.toThrow();
	});

	it("does not advance memory when a durable barrier write fails", async () => {
		const { directory, store } = await openStore();
		await chmod(directory, 0o500);
		await expect(store.claimSessionStart()).rejects.toThrow(/mode 0700/);
		await chmod(directory, 0o700);
		expect(await store.claimSessionStart()).toEqual({ kind: "send" });
	});

	it("rejects an oversized durable state file before parsing it", async () => {
		const { directory, store } = await openStore();
		await store.close();
		await writeFile(
			join(directory, CODEX_CAPSULE_STATE_FILE),
			`{"padding":"${"x".repeat(MAX_PRIVATE_STATE_FILE_BYTES)}"}`,
			{ mode: 0o600 },
		);
		await expect(reopenStore(directory)).rejects.toThrow(/exceeds the byte limit/);
	});

	it("revalidates the complete durable Host event stream on reopen", async () => {
		const { directory, store, session } = await readyStore();
		const input = turnInput(session);
		await acceptPreparedTurn(store, input);
		await store.close();
		const path = join(directory, CODEX_CAPSULE_STATE_FILE);
		const state = JSON.parse(await readFile(path, "utf8")) as {
			turns: Record<string, { events: Array<{ sequence: number }> }>;
		};
		state.turns[`${IDS.delivery}:1`]!.events[0]!.sequence = 2;
		await writeFile(path, JSON.stringify(state), { mode: 0o600 });
		await expect(reopenStore(directory)).rejects.toThrow(/Invalid host event stream: sequence/);
	});
});

async function openStore() {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "agentrelay-codex-store-")));
	directories.push(directory);
	return {
		directory,
		store: await CodexCapsuleStore.open(directory, {
			capsuleId: IDS.capsule,
			session: {
				missionId: IDS.mission,
				participantId: IDS.participant,
				workspaceAlias: "backend-primary",
			},
		}),
	};
}

async function reopenStore(directory: string) {
	return CodexCapsuleStore.open(directory, {
		capsuleId: IDS.capsule,
		session: {
			missionId: IDS.mission,
			participantId: IDS.participant,
			workspaceAlias: "backend-primary",
		},
	});
}

async function readyStore() {
	const opened = await openStore();
	await opened.store.claimSessionStart();
	const session = await opened.store.acceptSession("provider-thread-private-1");
	return { ...opened, session };
}

async function acceptPreparedTurn(store: CodexCapsuleStore, input: StartTurnInput) {
	await store.prepareTurn(input);
	await store.claimTurnStart(input);
	return store.acceptTurn(input, "provider-turn-private-1");
}

async function acceptPreparedPatchTurn(store: CodexCapsuleStore, input: StartTurnInput) {
	await store.prepareTurn(input, CODEX_DYNAMIC_PATCH_TOOL_CONTRACT);
	await store.claimTurnStart(input);
	return store.acceptTurn(input, "provider-turn-private-1");
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
			text: "Build the compatible backend and Android changes.",
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
				text: "Return one compatible contract recommendation.",
				authorPrincipalId: IDS.owner,
				provenance: "mission_manifest",
			},
		],
		peerMessages: [],
		artifacts: [],
	};
}

function patchRequest(callId: string, patch: string) {
	return {
		providerThreadId: "provider-thread-private-1",
		providerTurnId: "provider-turn-private-1",
		callId,
		patch,
		authority: PATCH_AUTHORITY,
	};
}

function testAuthority(
	overrides: Partial<Parameters<typeof authorityGrant>[0]> = {},
): CapsuleRuntimeActivation {
	const base = authorityGrant();
	return {
		grant: authorityGrant({
			mission_id: IDS.mission,
			delivery_id: IDS.delivery,
			workspace_alias: "backend-primary",
			capabilities: [...base.capabilities, { action: "workspace_write", resource: "workspace" }],
			...overrides,
		}),
		signal: new AbortController().signal,
		performWorkspaceRead: async (effect) => effect(),
		performWorkspaceWrite: async (effect) => effect(),
	};
}

function appliedResult(call: CodexPatchToolCall) {
	return {
		transactionId: codexPatchTransactionId(codexPatchKey(call)),
		patchSha256: codexPatchSha256(call.patch),
		planSha256: "a".repeat(64),
		filesChanged: 1,
	};
}
