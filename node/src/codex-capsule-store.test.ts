import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostSessionRef, StartTurnInput } from "@agentrelay/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { CapsuleOperationError } from "./capsule-operation-error.js";
import { CODEX_CAPSULE_STATE_FILE, CodexCapsuleStore } from "./codex-capsule-store.js";
import { MAX_PRIVATE_STATE_FILE_BYTES } from "./private-state-file.js";

const IDS = {
	capsule: "70000000-0000-4000-8000-000000000001",
	mission: "70000000-0000-4000-8000-000000000002",
	participant: "70000000-0000-4000-8000-000000000003",
	delivery: "70000000-0000-4000-8000-000000000004",
	delivery2: "70000000-0000-4000-8000-000000000005",
	owner: "70000000-0000-4000-8000-000000000006",
};

const directories: string[] = [];

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
		).toMatchObject({ schema_version: 2 });
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
