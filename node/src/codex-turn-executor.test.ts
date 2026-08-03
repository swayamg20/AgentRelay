import { mkdtemp, realpath, rm } from "node:fs/promises";
import type { HostSessionRef, StartTurnInput } from "@agentrelay/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { FakeCodexCapsuleClient } from "../test-support/fake-codex-capsule-client.js";
import { CodexCapsuleStore } from "./codex-capsule-store.js";
import { CodexProviderEventSource } from "./codex-provider-event-source.js";
import { CodexTurnExecutor } from "./codex-turn-executor.js";

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
		const turn = await store.prepareTurn(input);
		await store.claimTurnStart(input);
		await store.acceptTurn(input, "provider-turn-private-1");
		await store.requestCancellation(turn);
		expect(await store.claimInterrupt(turn)).toMatchObject({ kind: "send" });

		const client = new FakeCodexCapsuleClient(directory, "provider-thread-private-1");
		const providerEvents = new CodexProviderEventSource(client);
		const shutdown = new AbortController();
		const executor = new CodexTurnExecutor({
			store,
			client,
			providerEvents,
			cwd: directory,
			providerPollMs: 1,
			zeroMatchReads: 2,
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
		const turn = await store.prepareTurn(input);
		const start = await store.claimTurnStart(input);
		if (start.kind !== "send") throw new Error("Expected a new Codex turn claim");

		const client = new FakeCodexCapsuleClient(directory, "provider-thread-private-1");
		const providerTurn = client.seedTurn(start.intent, "interrupted");
		await store.acceptTurn(input, providerTurn.id);
		await store.requestCancellation(turn);
		expect(await store.claimInterrupt(turn)).toMatchObject({ kind: "send" });

		const providerEvents = new CodexProviderEventSource(client);
		const shutdown = new AbortController();
		const executor = new CodexTurnExecutor({
			store,
			client,
			providerEvents,
			cwd: directory,
			providerPollMs: 1,
			zeroMatchReads: 2,
			shutdownSignal: shutdown.signal,
		});

		await executor.run(input, turn, "provider-thread-private-1");

		const events = await store.eventsForTurn(turn, input);
		expect(events.map((event) => event.kind)).toEqual(["accepted", "usage", "cancelled"]);
		expect(client.readCalls).toBe(1);
		expect(client.interrupts).toEqual([]);
		expect(JSON.stringify(events)).not.toContain("provider-thread-private-1");
		expect(JSON.stringify(events)).not.toContain(providerTurn.id);

		shutdown.abort();
		await client.close();
		await providerEvents.close();
		await store.close();
	});
});

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
