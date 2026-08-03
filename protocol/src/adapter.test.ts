import { describe, expect, it } from "vitest";
import {
	DEFAULT_HOST_EVENT_STREAM_POLICY,
	type HostEvent,
	type HostSessionRef,
	InvalidHostEventStreamError,
	type StartTurnInput,
	acceptHostEvent,
	createHostEventStreamState,
	deriveHostMissionInputs,
	hostInputArtifactSchema,
} from "./adapter.js";
import type { TurnDisposition } from "./schemas.js";
import { FakeAgentHostAdapter } from "./testing/fake-adapter.js";

const IDS = {
	mission: "00000000-0000-4000-8000-000000000001",
	backendAgent: "00000000-0000-4000-8000-000000000002",
	androidAgent: "00000000-0000-4000-8000-000000000003",
	artifact: "00000000-0000-4000-8000-000000000004",
	message: "00000000-0000-4000-8000-000000000005",
	delivery: "00000000-0000-4000-8000-000000000006",
	owner: "00000000-0000-4000-8000-000000000010",
	otherMission: "00000000-0000-4000-8000-000000000011",
	impersonator: "00000000-0000-4000-8000-000000000012",
	unknownParticipant: "00000000-0000-4000-8000-000000000013",
} as const;

const REPLY: TurnDisposition = {
	kind: "reply",
	message_type: "progress",
	message: "implementation complete",
};

describe("FakeAgentHostAdapter", () => {
	it("repeats its default outcome without a process-wide turn limit", async () => {
		const adapter = new FakeAgentHostAdapter();
		const session = await createSession(adapter);
		adapter.setDefaultOutcome({ kind: "completed", disposition: REPLY });

		for (let index = 1; index <= 201; index += 1) {
			const deliveryId = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
			const events = await collect(adapter.startTurn({ ...createTurnInput(session), deliveryId }));
			expect(events.at(-1)).toMatchObject({ kind: "completed", disposition: REPLY });
		}

		expect(adapter.counters.turnsCreated).toBe(201);
	});

	it("uses queued outcomes before returning to the repeatable default", async () => {
		const adapter = new FakeAgentHostAdapter();
		const session = await createSession(adapter);
		adapter.setDefaultOutcome({ kind: "completed", disposition: REPLY });
		adapter.queueOutcome({
			kind: "failed",
			failure: { class: "transient", message: "one queued failure" },
		});

		const first = await collect(adapter.startTurn(createTurnInput(session)));
		const second = await collect(
			adapter.startTurn({ ...createTurnInput(session), executionAttempt: 2 }),
		);

		expect(first.at(-1)).toMatchObject({ kind: "failed" });
		expect(second.at(-1)).toMatchObject({ kind: "completed", disposition: REPLY });
	});

	it("suppresses duplicate host turns by delivery and execution attempt", async () => {
		const adapter = new FakeAgentHostAdapter();
		const session = await createSession(adapter);
		const input = createTurnInput(session);
		adapter.queueOutcome({ kind: "completed", disposition: REPLY });

		const first = await collect(adapter.startTurn(input));
		const duplicate = await collect(adapter.startTurn(input));

		expect(duplicate).toEqual(first);
		expect(first.map((event) => event.kind)).toEqual(["accepted", "usage", "completed"]);
		expect(adapter.counters.startTurnCalls).toBe(2);
		expect(adapter.counters.turnsCreated).toBe(1);
	});

	it("starts a fresh host turn when the same delivery advances execution attempt", async () => {
		const adapter = new FakeAgentHostAdapter();
		const session = await createSession(adapter);
		const firstInput = createTurnInput(session);
		const secondInput = { ...firstInput, executionAttempt: 2 };
		adapter.queueOutcome({
			kind: "failed",
			failure: { class: "transient", message: "host temporarily unavailable" },
		});
		adapter.queueOutcome({ kind: "completed", disposition: REPLY });

		const first = await collect(adapter.startTurn(firstInput));
		const second = await collect(adapter.startTurn(secondInput));
		const secondReplay = await collect(adapter.startTurn(secondInput));

		expect(first[0]?.turn).toMatchObject({ turnId: "fake-turn-1", executionAttempt: 1 });
		expect(second[0]?.turn).toMatchObject({ turnId: "fake-turn-2", executionAttempt: 2 });
		expect(secondReplay).toEqual(second);
		expect(await adapter.lookupTurn(firstInput.deliveryId, 1)).toEqual(first[0]?.turn);
		expect(await adapter.lookupTurn(firstInput.deliveryId, 2)).toEqual(second[0]?.turn);
		expect(adapter.counters.turnsCreated).toBe(2);
	});

	it("rejects changed work or provenance that reuses an accepted deliveryId", async () => {
		const adapter = new FakeAgentHostAdapter();
		const session = await createSession(adapter);
		const input = createTurnInput(session);
		adapter.queueOutcome({ kind: "completed", disposition: REPLY });
		await collect(adapter.startTurn(input));

		expect(() =>
			adapter.startTurn({
				...input,
				peerMessages: [
					{
						...input.peerMessages[0]!,
						authorAgentId: IDS.impersonator,
					},
				],
			}),
		).toThrow(/host execution reused with different turn correlation/);
		expect(() =>
			adapter.startTurn({
				...input,
				artifacts: [
					{
						...input.artifacts[0]!,
						source: {
							...input.artifacts[0]!.source,
							principal_id: IDS.impersonator,
						},
					},
				],
			}),
		).toThrow(/host execution reused with different turn correlation/);
		expect(() =>
			adapter.startTurn({
				...input,
				objective: { ...input.objective, authorPrincipalId: IDS.androidAgent },
			}),
		).toThrow(/host execution reused with different turn correlation/);
		expect(adapter.counters.startTurnCalls).toBe(4);
		expect(adapter.counters.turnsCreated).toBe(1);
		expect((await adapter.lookupTurn(input.deliveryId, input.executionAttempt))?.turnId).toBe(
			"fake-turn-1",
		);
	});

	it("rejects invalid execution attempts before creating a host turn", async () => {
		const adapter = new FakeAgentHostAdapter();
		const session = await createSession(adapter);
		const input = createTurnInput(session);

		for (const executionAttempt of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => adapter.startTurn({ ...input, executionAttempt })).toThrow();
		}

		expect(adapter.counters.turnsCreated).toBe(0);
	});

	it("snapshots accepted input so caller mutation cannot redefine a delivery", async () => {
		const adapter = new FakeAgentHostAdapter();
		const session = await createSession(adapter);
		const peerMessage = {
			messageId: IDS.message,
			authorAgentId: IDS.androidAgent,
			kind: "proposal" as const,
			body: "Use the agreed contract.",
		};
		const input = { ...createTurnInput(session), peerMessages: [peerMessage] };
		await collect(adapter.startTurn(input));

		peerMessage.body = "Replace the accepted work after host invocation.";

		expect(() => adapter.startTurn(input)).toThrow(
			/host execution reused with different turn correlation/,
		);
		expect(adapter.counters.turnsCreated).toBe(1);
	});

	it("looks up and recovers accepted and completed turns", async () => {
		const adapter = new FakeAgentHostAdapter();
		const session = await createSession(adapter);
		const input = createTurnInput(session);
		adapter.queueOutcome({ kind: "pending" });

		const accepted = await collect(adapter.startTurn(input));
		const ref = await adapter.lookupTurn(input.deliveryId, input.executionAttempt);
		expect(ref).toEqual(accepted[0]?.turn);
		expect((await collect(adapter.recoverTurn(ref!, input))).map((event) => event.kind)).toEqual([
			"accepted",
		]);

		adapter.completeTurn(input.deliveryId, input.executionAttempt, REPLY);
		const recovered = await collect(adapter.recoverTurn(ref!, input));

		expect(recovered.map((event) => event.kind)).toEqual(["accepted", "usage", "completed"]);
		expect(recovered[2]).toMatchObject({ kind: "completed", disposition: REPLY });
		expect(adapter.counters.turnsCreated).toBe(1);
		expect(adapter.counters.recoverTurnCalls).toBe(2);
	});

	it("replays normalized output, tool, and usage evidence without exposing mutable history", async () => {
		const adapter = new FakeAgentHostAdapter();
		const session = await createSession(adapter);
		const input = createTurnInput(session);
		const queuedDisposition = { ...REPLY };
		adapter.queueOutcome({
			kind: "completed",
			events: [
				{ kind: "output", text: "working" },
				{
					kind: "tool",
					activity: { toolCallId: "tool-1", name: "read_file", phase: "completed" },
				},
				{
					kind: "permission",
					activity: { requestId: "permission-1", capability: "write_workspace", phase: "granted" },
				},
				{
					kind: "artifact",
					artifact: {
						artifact_id: "00000000-0000-4000-8000-000000000004",
						type: "patch",
						version: 1,
						sha256: "b".repeat(64),
						media_type: "text/x-diff",
						byte_size: 128,
					},
				},
				{
					kind: "usage",
					usage: {
						available: true,
						scope: "turn_cumulative",
						inputTokens: 120,
						outputTokens: 30,
					},
				},
			],
			disposition: queuedDisposition,
		});
		queuedDisposition.message = "mutated after queueing";

		const first = await collect(adapter.startTurn(input));
		expect(first.map((event) => event.kind)).toEqual([
			"accepted",
			"output",
			"tool",
			"permission",
			"artifact",
			"usage",
			"completed",
		]);
		expect(first.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		const output = first.find((event) => event.kind === "output");
		if (output?.kind === "output") {
			(output as { text: string }).text = "mutated replay";
		}
		const completed = first.find((event) => event.kind === "completed");
		if (completed?.kind === "completed" && completed.disposition.kind === "reply") {
			completed.disposition.message = "mutated replay";
		}

		const recovered = await collect(
			adapter.recoverTurn(
				(await adapter.lookupTurn(input.deliveryId, input.executionAttempt))!,
				input,
			),
		);
		expect(recovered[1]).toMatchObject({ kind: "output", sequence: 2, text: "working" });
		expect(recovered.at(-1)).toMatchObject({
			kind: "completed",
			disposition: { message: "implementation complete" },
		});
	});

	it("replays the complete stable sequence after a consumer stops partway", async () => {
		const adapter = new FakeAgentHostAdapter();
		const session = await createSession(adapter);
		const input = createTurnInput(session);
		adapter.queueOutcome({
			kind: "completed",
			events: [
				{ kind: "output", text: " " },
				{ kind: "output", text: "done" },
			],
			disposition: REPLY,
		});

		const iterator = adapter.startTurn(input)[Symbol.asyncIterator]();
		expect((await iterator.next()).value).toMatchObject({ kind: "accepted", sequence: 1 });
		await iterator.return?.();

		const ref = await adapter.lookupTurn(input.deliveryId, input.executionAttempt);
		const recovered = await collect(adapter.recoverTurn(ref!, input));
		expect(recovered.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
		expect(recovered.map((event) => event.kind)).toEqual([
			"accepted",
			"output",
			"output",
			"usage",
			"completed",
		]);
	});

	it("reuses a session for the same Mission participant and workspace alias", async () => {
		const adapter = new FakeAgentHostAdapter();
		const input = {
			missionId: IDS.mission,
			participantId: IDS.backendAgent,
			workspaceAlias: "backend-primary",
		};

		const first = await adapter.ensureSession(input);
		const second = await adapter.ensureSession(input);

		expect(second).toEqual(first);
		expect(adapter.counters.ensureSessionCalls).toBe(2);
		expect(adapter.counters.sessionsCreated).toBe(1);
	});

	it("cancels an accepted turn idempotently and recovers the cancellation", async () => {
		const adapter = new FakeAgentHostAdapter();
		const session = await createSession(adapter);
		const input = createTurnInput(session);
		adapter.queueOutcome({ kind: "pending" });
		await collect(adapter.startTurn(input));
		const ref = await adapter.lookupTurn(input.deliveryId, input.executionAttempt);

		await adapter.cancelTurn(ref!);
		await adapter.cancelTurn(ref!);
		const recovered = await collect(adapter.recoverTurn(ref!, input));

		expect(recovered.map((event) => event.kind)).toEqual(["accepted", "usage", "cancelled"]);
		expect(adapter.counters.cancelTurnCalls).toBe(2);
		expect(adapter.counters.turnsCancelled).toBe(1);
		expect(adapter.counters.turnsCreated).toBe(1);
	});

	it("rejects a forged recovery reference with different Mission correlation", async () => {
		const adapter = new FakeAgentHostAdapter();
		const session = await createSession(adapter);
		const input = createTurnInput(session);
		await collect(adapter.startTurn(input));
		const ref = await adapter.lookupTurn(input.deliveryId, input.executionAttempt);

		expect(() => adapter.recoverTurn({ ...ref!, missionId: IDS.otherMission }, input)).toThrow(
			/unknown fake host turn/,
		);
		expect(() => adapter.recoverTurn({ ...ref!, executionAttempt: 2 }, input)).toThrow(
			/unknown fake host turn/,
		);
		expect(() =>
			adapter.recoverTurn(ref!, {
				...input,
				assignment: { ...input.assignment, text: "Changed recovery assignment" },
			}),
		).toThrow(/host execution reused with different turn correlation/);
		await expect(adapter.cancelTurn({ ...ref!, contractVersion: 2 })).rejects.toThrow(
			/unknown fake host turn/,
		);
	});

	it("rejects artifact content that does not match its declared bytes, hash, or typed JSON", async () => {
		const adapter = new FakeAgentHostAdapter();
		const session = await createSession(adapter);
		const input = createTurnInput(session);

		expect(() =>
			adapter.startTurn({
				...input,
				artifacts: [
					{
						...input.artifacts[0]!,
						artifact: { ...input.artifacts[0]!.artifact, sha256: "a".repeat(64) },
					},
				],
			}),
		).toThrow(/Artifact hash does not match/);
		expect(() =>
			adapter.startTurn({
				...input,
				artifacts: [
					{
						...input.artifacts[0]!,
						payload: {
							kind: "json",
							rawText: '{"status":"string"}',
							value: { status: "number" },
						},
					},
				],
			}),
		).toThrow(/Parsed JSON does not match/);
		expect(adapter.counters.turnsCreated).toBe(0);
	});

	it("rejects oversized host events before accepting a turn", async () => {
		const adapter = new FakeAgentHostAdapter();
		const session = await createSession(adapter);
		const input = createTurnInput(session);
		adapter.queueOutcome({
			kind: "pending",
			events: [{ kind: "output", text: "x".repeat(16_001) }],
		});

		expect(() => adapter.startTurn(input)).toThrow();
		expect(adapter.counters.turnsCreated).toBe(1);
		expect(await adapter.lookupTurn(input.deliveryId, input.executionAttempt)).not.toBeNull();
		expect((await collect(adapter.startTurn(input))).map((event) => event.kind)).toEqual([
			"accepted",
		]);
		expect(adapter.counters.turnsCreated).toBe(1);
	});

	it("rejects decreasing cumulative usage without losing the accepted turn", async () => {
		const adapter = new FakeAgentHostAdapter();
		const session = await createSession(adapter);
		const input = createTurnInput(session);
		adapter.queueOutcome({
			kind: "pending",
			events: [
				{
					kind: "usage",
					usage: {
						available: true,
						scope: "turn_cumulative",
						inputTokens: 100,
						outputTokens: 20,
					},
				},
				{
					kind: "usage",
					usage: {
						available: true,
						scope: "turn_cumulative",
						inputTokens: 90,
						outputTokens: 20,
					},
				},
			],
		});

		expect(() => adapter.startTurn(input)).toThrow(InvalidHostEventStreamError);
		const recovered = await collect(adapter.startTurn(input));
		expect(recovered.map((event) => event.kind)).toEqual(["accepted", "usage"]);
		expect(recovered[1]).toMatchObject({
			kind: "usage",
			usage: { available: true, inputTokens: 100, outputTokens: 20 },
		});
		expect(adapter.counters.turnsCreated).toBe(1);
	});

	it("enforces aggregate output and artifact limits across individually valid events", async () => {
		const outputAdapter = new FakeAgentHostAdapter();
		const outputSession = await createSession(outputAdapter);
		const outputInput = createTurnInput(outputSession);
		outputAdapter.queueOutcome({
			kind: "pending",
			events: Array.from({ length: 17 }, () => ({
				kind: "output" as const,
				text: "x".repeat(16_000),
			})),
		});
		expect(() => outputAdapter.startTurn(outputInput)).toThrow(InvalidHostEventStreamError);
		expect((await collect(outputAdapter.startTurn(outputInput))).length).toBe(17);

		const artifactAdapter = new FakeAgentHostAdapter();
		const artifactSession = await createSession(artifactAdapter);
		const artifactInput = createTurnInput(artifactSession);
		artifactAdapter.queueOutcome({
			kind: "pending",
			events: Array.from({ length: 17 }, (_, index) => ({
				kind: "artifact" as const,
				artifact: createOutputArtifactRef(index),
			})),
		});
		expect(() => artifactAdapter.startTurn(artifactInput)).toThrow(InvalidHostEventStreamError);
		expect((await collect(artifactAdapter.startTurn(artifactInput))).length).toBe(17);
	});
});

describe("acceptHostEvent", () => {
	it("requires contiguous acceptance-first sequencing and rejects post-terminal events", async () => {
		const adapter = new FakeAgentHostAdapter();
		const session = await createSession(adapter);
		const accepted = (await collect(adapter.startTurn(createTurnInput(session))))[0]!;
		expect(() =>
			acceptHostEvent(
				createHostEventStreamState({
					...accepted.turn,
					deliveryId: "00000000-0000-4000-8000-000000000099",
				}),
				accepted,
			),
		).toThrow(InvalidHostEventStreamError);
		expect(() =>
			acceptHostEvent(
				createHostEventStreamState({ ...accepted.turn, executionAttempt: 2 }),
				accepted,
			),
		).toThrow(InvalidHostEventStreamError);
		const first = acceptHostEvent(createHostEventStreamState(accepted.turn), accepted);
		if (first.event.kind === "accepted") {
			first.event.turn.deliveryId = IDS.otherMission;
		}
		expect(first.state.turn?.deliveryId).toBe(IDS.delivery);

		expect(() =>
			acceptHostEvent(first.state, {
				kind: "output",
				turn: accepted.turn,
				sequence: 3,
				text: "gap",
			}),
		).toThrow(InvalidHostEventStreamError);
		expect(() =>
			acceptHostEvent(first.state, {
				kind: "output",
				turn: { ...accepted.turn, turnId: "different-provider-turn" },
				sequence: 2,
				text: "wrong turn",
			}),
		).toThrow(InvalidHostEventStreamError);
		expect(() =>
			acceptHostEvent(first.state, {
				kind: "output",
				turn: { ...accepted.turn, executionAttempt: 2 },
				sequence: 2,
				text: "wrong execution attempt",
			}),
		).toThrow(InvalidHostEventStreamError);
		expect(() =>
			acceptHostEvent(
				first.state,
				{
					kind: "usage",
					turn: accepted.turn,
					sequence: 2,
					usage: {
						available: true,
						scope: "turn_cumulative",
						inputTokens: 8,
						outputTokens: 3,
					},
				},
				{ ...DEFAULT_HOST_EVENT_STREAM_POLICY, maxTokens: 10 },
			),
		).toThrow(InvalidHostEventStreamError);

		expect(() =>
			acceptHostEvent(first.state, {
				kind: "completed",
				turn: accepted.turn,
				sequence: 2,
				disposition: REPLY,
			}),
		).toThrow(InvalidHostEventStreamError);
		const withUsage = acceptHostEvent(first.state, {
			kind: "usage",
			turn: accepted.turn,
			sequence: 2,
			usage: { available: false, reason: "not_reported" },
		});
		expect(() =>
			acceptHostEvent(
				withUsage.state,
				{
					kind: "completed",
					turn: accepted.turn,
					sequence: 3,
					disposition: REPLY,
				},
				{ ...DEFAULT_HOST_EVENT_STREAM_POLICY, maxOutputBytes: 1 },
			),
		).toThrow(InvalidHostEventStreamError);
		const terminal = acceptHostEvent(withUsage.state, {
			kind: "completed",
			turn: accepted.turn,
			sequence: 3,
			disposition: REPLY,
		});
		expect(() =>
			acceptHostEvent(terminal.state, {
				kind: "output",
				turn: accepted.turn,
				sequence: 4,
				text: "late output",
			}),
		).toThrow(InvalidHostEventStreamError);
	});
});

describe("deriveHostMissionInputs", () => {
	it("derives objective, assignment, and criteria from authenticated Mission context", () => {
		const context = createMissionContext();
		const derived = deriveHostMissionInputs(context, context.manifest.participants[0].agent_id);

		expect(derived).toEqual({
			objective: {
				text: context.manifest.objective,
				authorPrincipalId: context.created_by.principal_id,
				provenance: "mission_manifest",
			},
			assignment: {
				text: context.manifest.participants[0].initial_assignment,
				authorPrincipalId: context.created_by.principal_id,
				provenance: "mission_manifest",
			},
			acceptanceCriteria: context.manifest.public_acceptance_criteria.map((text) => ({
				text,
				authorPrincipalId: context.created_by.principal_id,
				provenance: "mission_manifest",
			})),
		});
		expect(() => deriveHostMissionInputs(context, IDS.unknownParticipant)).toThrow(
			/Mission participant not found/,
		);
	});
});

describe("hostInputArtifactSchema", () => {
	it("safely rejects JSON nested beyond the adapter limit", () => {
		let value: unknown = "leaf";
		for (let depth = 0; depth < 2_500; depth += 1) {
			value = [value];
		}
		const rawText = JSON.stringify(value);
		let success: boolean | undefined;

		expect(() => {
			success = hostInputArtifactSchema.safeParse({
				artifact: {
					artifact_id: IDS.artifact,
					type: "api_contract",
					version: 1,
					media_type: "application/json",
					sha256: "a".repeat(64),
					byte_size: rawText.length,
				},
				source: { principal_id: IDS.androidAgent, kind: "agent" },
				payload: { kind: "json", rawText, value },
			}).success;
		}).not.toThrow();
		expect(success).toBe(false);
	});

	it("derives sanitized JSON from raw text and rejects mismatched media kinds", () => {
		const asserted: Record<PropertyKey, unknown> = { status: "string" };
		Object.defineProperty(asserted, "hidden", { value: "not-json", enumerable: false });
		Object.defineProperty(asserted, "toJSON", {
			value: () => "x".repeat(20_000),
			enumerable: false,
		});
		asserted[Symbol("secret")] = "not-json";
		const parsed = hostInputArtifactSchema.parse({
			artifact: {
				artifact_id: IDS.artifact,
				type: "api_contract",
				version: 3,
				media_type: "application/problem+json; charset=utf-8",
				sha256: "057dbc6d9bf35958a0f764d184ecf850c626587898ac20c4868c8b37625db1f7",
				byte_size: 19,
			},
			source: { principal_id: IDS.owner, kind: "owner" },
			payload: { kind: "json", rawText: '{"status":"string"}', value: asserted },
		});

		expect(parsed.artifact.version).toBe(3);
		expect(parsed.source).toEqual({ principal_id: IDS.owner, kind: "owner" });
		expect(parsed.payload).toEqual({
			kind: "json",
			rawText: '{"status":"string"}',
			value: { status: "string" },
		});
		expect(
			hostInputArtifactSchema.safeParse({
				artifact: {
					artifact_id: IDS.artifact,
					type: "api_contract",
					version: 1,
					media_type: "application/json",
					sha256: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
					byte_size: 1,
				},
				source: { principal_id: IDS.owner, kind: "owner" },
				payload: { kind: "text", text: "x" },
			}).success,
		).toBe(false);
	});
});

async function createSession(adapter: FakeAgentHostAdapter): Promise<HostSessionRef> {
	return adapter.ensureSession({
		missionId: IDS.mission,
		participantId: IDS.backendAgent,
		workspaceAlias: "backend-primary",
	});
}

function createTurnInput(session: HostSessionRef): StartTurnInput {
	return {
		session,
		missionId: session.missionId,
		deliveryId: IDS.delivery,
		executionAttempt: 1,
		contractVersion: 1,
		missionSequence: 3,
		objective: {
			text: "Implement the backend half of the shared feature",
			authorPrincipalId: IDS.owner,
			provenance: "mission_manifest",
		},
		assignment: {
			text: "Add the versioned API endpoint",
			authorPrincipalId: IDS.owner,
			provenance: "mission_manifest",
		},
		acceptanceCriteria: [
			{
				text: "contract fixture passes",
				authorPrincipalId: IDS.owner,
				provenance: "mission_manifest",
			},
		],
		peerMessages: [
			{
				messageId: IDS.message,
				authorAgentId: IDS.androidAgent,
				kind: "proposal",
				body: "Android client needs field `status`",
			},
		],
		artifacts: [
			{
				artifact: {
					artifact_id: IDS.artifact,
					type: "api_contract",
					version: 1,
					media_type: "application/json",
					sha256: "057dbc6d9bf35958a0f764d184ecf850c626587898ac20c4868c8b37625db1f7",
					byte_size: 19,
				},
				source: { principal_id: IDS.androidAgent, kind: "agent" },
				payload: {
					kind: "json",
					rawText: '{"status":"string"}',
					value: { status: "string" },
				},
			},
		],
	};
}

function createMissionContext() {
	return {
		manifest: {
			schema_version: 1 as const,
			mission_id: "00000000-0000-4000-8000-000000000001",
			objective: "Ship compatible backend and Android changes.",
			public_acceptance_criteria: ["The contract fixture passes."],
			participants: [
				{
					agent_id: "00000000-0000-4000-8000-000000000002",
					role: "backend",
					workspace_alias: "backend-api",
					repository_url: "https://github.com/acme/backend.git",
					expected_base_commit: "1".repeat(40),
					initial_assignment: "Implement the versioned endpoint.",
					requested_local_policy_profile: "coding",
				},
				{
					agent_id: "00000000-0000-4000-8000-000000000003",
					role: "android",
					workspace_alias: "android-app",
					repository_url: "https://github.com/acme/android.git",
					expected_base_commit: "2".repeat(40),
					initial_assignment: "Consume the versioned endpoint.",
					requested_local_policy_profile: "coding",
				},
			],
			shared_contract: {
				artifact_id: "00000000-0000-4000-8000-000000000004",
				type: "api_contract",
				version: 1 as const,
				sha256: "a".repeat(64),
				media_type: "application/json",
				byte_size: 128,
			},
			max_turns: 20,
			max_wall_time_seconds: 7_200,
			token_budget: 200_000,
			expires_at: "2026-08-02T12:00:00.000Z",
			allowed_artifact_types: ["api_contract", "patch"],
			created_at: "2026-08-02T10:00:00.000Z",
		},
		created_by: {
			principal_id: "00000000-0000-4000-8000-000000000010",
			kind: "owner" as const,
		},
	};
}

function createOutputArtifactRef(index = 0) {
	return {
		artifact_id: `00000000-0000-4000-8000-${String(20 + index).padStart(12, "0")}`,
		type: "patch",
		version: 1,
		sha256: "b".repeat(64),
		media_type: "text/x-diff",
		byte_size: 128,
	};
}

async function collect(events: AsyncIterable<HostEvent>): Promise<HostEvent[]> {
	const collected: HostEvent[] = [];
	for await (const event of events) {
		collected.push(event);
	}
	return collected;
}
