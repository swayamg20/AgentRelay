import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type HostEvent,
	type HostInputArtifact,
	type HostSessionRef,
	type StartTurnInput,
	acceptHostEvent,
	createHostEventStreamState,
	deriveHostMissionInputs,
} from "../adapter.js";
import {
	type CoordinatorTurnDisposition,
	type MissionCoordinatorConfig,
	type MissionCoordinatorEvent,
	type MissionCoordinatorState,
	createMissionCoordinatorState,
	reduceMissionCoordinatorEvent,
} from "../mission-coordinator.js";
import type { ActorRef, ArtifactRef, ContractRevision, Message } from "../schemas.js";
import {
	type FakeAdapterCounters,
	FakeAgentHostAdapter,
	type FakeTurnProgress,
} from "./fake-adapter.js";
import type { FixedCommand } from "./frozen-repository.js";
import { runFixedCommand } from "./frozen-repository.js";

export type FixtureReplayMode = "none" | "duplicate_start" | "recover_after_partial";

interface ScriptedMissionTurnBase {
	readonly deliveryId: string;
	readonly progress?: readonly FakeTurnProgress[];
	readonly replayMode?: FixtureReplayMode;
}

export type ScriptedMissionTurn =
	| (ScriptedMissionTurnBase & {
			readonly disposition: Exclude<
				CoordinatorTurnDisposition,
				{ readonly kind: "propose_contract" }
			>;
			readonly revision?: never;
	  })
	| (ScriptedMissionTurnBase & {
			readonly disposition: Extract<
				CoordinatorTurnDisposition,
				{ readonly kind: "propose_contract" }
			>;
			readonly revision: ContractRevision;
	  });

export interface ScriptedContractAcknowledgement {
	readonly participantAgentId: string;
	readonly revisionId: string;
	readonly contractVersion: number;
	readonly artifact: ArtifactRef;
}

export interface FixtureVerificationCommand {
	readonly command: FixedCommand;
	readonly summary: string;
	readonly durationMs: number;
}

export interface MissionFixtureEnvironment {
	readonly verificationCommands: Readonly<
		Record<string, Readonly<Record<string, FixtureVerificationCommand>>>
	>;
}

export interface ScriptedMissionFixture<TEnvironment extends MissionFixtureEnvironment> {
	readonly coordinatorConfig: MissionCoordinatorConfig;
	readonly artifacts: readonly HostInputArtifact[];
	readonly turnsByParticipant: Readonly<Record<string, readonly ScriptedMissionTurn[]>>;
	readonly contractAcknowledgements: readonly ScriptedContractAcknowledgement[];
	prepareEnvironment(): Promise<TEnvironment>;
	disposeEnvironment(environment: TEnvironment): Promise<void>;
}

export interface FixtureHostTurnTrace {
	readonly participantAgentId: string;
	readonly input: StartTurnInput;
	readonly events: readonly HostEvent[];
	readonly replayMode: FixtureReplayMode;
}

export interface MissionFixtureRunResult<TEnvironment extends MissionFixtureEnvironment> {
	readonly state: MissionCoordinatorState;
	readonly events: readonly MissionCoordinatorEvent[];
	readonly hostTurns: readonly FixtureHostTurnTrace[];
	readonly adapterCounters: Readonly<Record<string, FakeAdapterCounters>>;
	readonly duplicateDeliveriesSuppressed: number;
	readonly duplicateAcknowledgementsSuppressed: number;
	readonly recoveredHostTurns: number;
	readonly humanInterventions: 0;
	readonly environment: TEnvironment;
	dispose(): Promise<void>;
}

/** Runs one fully pre-scripted Mission after the initial owner-controlled kickoff. */
export async function runMissionFixture<TEnvironment extends MissionFixtureEnvironment>(
	fixture: ScriptedMissionFixture<TEnvironment>,
): Promise<MissionFixtureRunResult<TEnvironment>> {
	const environment = await fixture.prepareEnvironment();
	try {
		return await runPreparedMissionFixture(fixture, environment);
	} catch (error) {
		await fixture.disposeEnvironment(environment);
		throw error;
	}
}

async function runPreparedMissionFixture<TEnvironment extends MissionFixtureEnvironment>(
	fixture: ScriptedMissionFixture<TEnvironment>,
	environment: TEnvironment,
): Promise<MissionFixtureRunResult<TEnvironment>> {
	const context = fixture.coordinatorConfig.mission_context;
	const participants = context.manifest.participants;
	const adapters: Record<string, FakeAgentHostAdapter> = {};
	const sessions: Record<string, HostSessionRef> = {};
	const turnQueues: Record<string, ScriptedMissionTurn[]> = {};
	const acknowledgementQueue = [...fixture.contractAcknowledgements];

	for (const participant of participants) {
		const turns = [...(fixture.turnsByParticipant[participant.agent_id] ?? [])];
		const adapter = new FakeAgentHostAdapter();
		for (const turn of turns) {
			adapter.queueOutcome({
				kind: "completed",
				events: turn.progress,
				disposition: turn.disposition,
			});
		}
		adapters[participant.agent_id] = adapter;
		turnQueues[participant.agent_id] = turns;
		sessions[participant.agent_id] = await adapter.ensureSession({
			missionId: context.manifest.mission_id,
			participantId: participant.agent_id,
			workspaceAlias: participant.workspace_alias,
		});
	}

	let state = createMissionCoordinatorState(fixture.coordinatorConfig);
	state = reduceMissionCoordinatorEvent(state, {
		...eventEnvelope(state.sequence_no + 1, context.manifest.mission_id),
		type: "participants_accepted",
		participant_agent_ids: participants.map((participant) => participant.agent_id),
		contract: context.manifest.shared_contract,
	});

	const hostTurns: FixtureHostTurnTrace[] = [];
	let duplicateDeliveriesSuppressed = 0;
	let duplicateAcknowledgementsSuppressed = 0;
	let recoveredHostTurns = 0;
	let steps = 0;

	while (state.status === "active") {
		steps += 1;
		if (steps > context.manifest.max_turns * 3) {
			throw new Error("Scripted Mission exceeded its deterministic runner step limit");
		}

		if (state.pending_revision !== null) {
			const scripted = acknowledgementQueue.shift();
			if (scripted === undefined) {
				throw new Error(
					`No scripted acknowledgement remains for revision ${state.pending_revision.revision_id}`,
				);
			}
			const acknowledgement = {
				...eventEnvelope(state.sequence_no + 1, context.manifest.mission_id),
				type: "contract_acknowledged" as const,
				participant_agent_id: scripted.participantAgentId,
				revision_id: scripted.revisionId,
				contract_version: scripted.contractVersion,
				artifact: scripted.artifact,
			};
			state = reduceMissionCoordinatorEvent(state, acknowledgement);
			if (duplicateAcknowledgementsSuppressed === 0) {
				const beforeReplay = state;
				state = reduceMissionCoordinatorEvent(state, acknowledgement);
				assertDeepEqual(state, beforeReplay, "duplicate contract acknowledgement changed state");
				duplicateAcknowledgementsSuppressed += 1;
			}
			continue;
		}

		const participantAgentId = state.current_participant_agent_id;
		if (participantAgentId === null) {
			break;
		}
		const turn = turnQueues[participantAgentId]?.shift();
		if (turn === undefined) {
			throw new Error(`No scripted turn remains for current participant ${participantAgentId}`);
		}
		const adapter = requireValue(adapters[participantAgentId], "fake adapter");
		const session = requireValue(sessions[participantAgentId], "host session");
		const missionInputs = deriveHostMissionInputs(context, participantAgentId);
		const peerMessages = state.messages.filter(
			(message) => message.author_agent_id !== participantAgentId,
		);
		const input: StartTurnInput = {
			session,
			missionId: context.manifest.mission_id,
			deliveryId: turn.deliveryId,
			contractVersion: state.contract_version,
			missionSequence: state.sequence_no + 1,
			objective: missionInputs.objective,
			assignment: missionInputs.assignment,
			acceptanceCriteria: [...missionInputs.acceptanceCriteria],
			peerMessages: peerMessages.map((message) => ({
				messageId: message.message_id,
				authorAgentId: message.author_agent_id,
				kind: message.type,
				body: message.body,
			})),
			artifacts: collectTurnArtifacts(fixture.artifacts, state, peerMessages),
		};
		const replayMode = turn.replayMode ?? "none";
		const events = await executeHostTurn(adapter, input, replayMode);
		const terminal = events.at(-1);
		if (terminal?.kind !== "completed") {
			throw new Error(`Scripted host turn did not complete: ${turn.deliveryId}`);
		}
		assertDeepEqual(terminal.disposition, turn.disposition, "host disposition changed");

		const sequence = state.sequence_no + 1;
		const envelope = eventEnvelope(sequence, context.manifest.mission_id);
		const message = createMessage(turn.disposition, state, participantAgentId, envelope);
		const revision = createRevision(turn);
		const completedEvent = {
			...envelope,
			type: "turn_completed" as const,
			participant_agent_id: participantAgentId,
			delivery_id: turn.deliveryId,
			contract_version: input.contractVersion,
			disposition: terminal.disposition,
			message,
			revision,
		};
		state = reduceMissionCoordinatorEvent(state, completedEvent);
		if (replayMode === "duplicate_start") {
			const beforeReplay = state;
			state = reduceMissionCoordinatorEvent(state, completedEvent);
			assertDeepEqual(state, beforeReplay, "duplicate delivery changed coordinator state");
			duplicateDeliveriesSuppressed += 1;
		}
		if (replayMode === "recover_after_partial") {
			recoveredHostTurns += 1;
		}
		hostTurns.push({ participantAgentId, input, events, replayMode });
	}

	if (state.status !== "verifying") {
		throw new Error(`Scripted Mission did not reach verification: ${state.status}`);
	}

	for (const participant of participants) {
		const required = fixture.coordinatorConfig.required_verification_commands[participant.agent_id];
		for (const commandId of required ?? []) {
			const registered = environment.verificationCommands[participant.agent_id]?.[commandId];
			if (registered === undefined) {
				throw new Error(`No local verification command is registered for ${commandId}`);
			}
			const sequence = state.sequence_no + 1;
			const createdAt = timestampFor(sequence);
			let output = "";
			let passed = true;
			try {
				output = await runFixedCommand(registered.command);
			} catch {
				passed = false;
			}
			state = reduceMissionCoordinatorEvent(state, {
				...eventEnvelope(sequence, context.manifest.mission_id),
				type: "verification_recorded",
				participant_agent_id: participant.agent_id,
				contract_version: state.contract_version,
				verification_round: state.verification_round,
				evidence: {
					verification_id: fixtureUuid("22000000", sequence),
					command_id: commandId,
					outcome: passed ? "passed" : "failed",
					exit_code: passed ? 0 : 1,
					duration_ms: registered.durationMs,
					summary: registered.summary,
					output_sha256: createHash("sha256").update(output, "utf8").digest("hex"),
					artifacts: [],
					recorded_at: createdAt,
				},
			});
			if (!passed) {
				throw new Error(`Local verification command failed: ${commandId}`);
			}
		}
	}

	if (state.status !== "completed") {
		throw new Error(`Scripted Mission did not complete: ${state.status}`);
	}
	for (const [participantAgentId, turns] of Object.entries(turnQueues)) {
		if (turns.length > 0) {
			throw new Error(`Unused scripted turns remain for ${participantAgentId}`);
		}
	}
	if (acknowledgementQueue.length > 0) {
		throw new Error("Unused scripted contract acknowledgements remain");
	}

	let disposed = false;
	return {
		state,
		events: state.applied_events,
		hostTurns,
		adapterCounters: Object.fromEntries(
			Object.entries(adapters).map(([agentId, adapter]) => [agentId, adapter.counters]),
		),
		duplicateDeliveriesSuppressed,
		duplicateAcknowledgementsSuppressed,
		recoveredHostTurns,
		humanInterventions: 0,
		environment,
		async dispose() {
			if (!disposed) {
				disposed = true;
				await fixture.disposeEnvironment(environment);
			}
		},
	};
}

async function executeHostTurn(
	adapter: FakeAgentHostAdapter,
	input: StartTurnInput,
	mode: FixtureReplayMode,
): Promise<readonly HostEvent[]> {
	let events: readonly HostEvent[];
	if (mode === "recover_after_partial") {
		const iterator = adapter.startTurn(input)[Symbol.asyncIterator]();
		const partial: HostEvent[] = [];
		for (let index = 0; index < 2; index += 1) {
			const next = await iterator.next();
			if (next.done) {
				break;
			}
			partial.push(next.value);
		}
		await iterator.return?.();
		const ref = await adapter.lookupTurn(input.deliveryId);
		if (ref === null) {
			throw new Error(`Accepted host turn was not recoverable: ${input.deliveryId}`);
		}
		const recovered = await collect(adapter.recoverTurn(ref));
		events = mergeReplay(partial, recovered);
	} else {
		events = await collect(adapter.startTurn(input));
	}

	validateHostEvents(input, events);
	if (mode === "duplicate_start") {
		const replayed = await collect(adapter.startTurn(input));
		assertDeepEqual(replayed, events, "duplicate host start returned a different replay");
	}
	return events;
}

function validateHostEvents(input: StartTurnInput, events: readonly HostEvent[]): void {
	let state = createHostEventStreamState({
		sessionId: input.session.sessionId,
		missionId: input.missionId,
		deliveryId: input.deliveryId,
		contractVersion: input.contractVersion,
	});
	for (const event of events) {
		state = acceptHostEvent(state, event).state;
	}
	if (state.phase !== "terminal") {
		throw new Error(`Host event replay is not terminal: ${input.deliveryId}`);
	}
}

function mergeReplay(
	partial: readonly HostEvent[],
	recovered: readonly HostEvent[],
): readonly HostEvent[] {
	const bySequence = new Map<number, HostEvent>();
	for (const event of [...partial, ...recovered]) {
		const existing = bySequence.get(event.sequence);
		if (existing !== undefined && !isDeepStrictEqual(existing, event)) {
			throw new Error(`Host replay changed sequence ${event.sequence}`);
		}
		bySequence.set(event.sequence, structuredClone(event));
	}
	return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

function createMessage(
	disposition: CoordinatorTurnDisposition,
	state: MissionCoordinatorState,
	participantAgentId: string,
	envelope: ReturnType<typeof eventEnvelope>,
): Message | null {
	if (disposition.kind !== "reply") {
		return null;
	}
	return {
		message_id: fixtureUuid("21000000", envelope.sequence_no),
		mission_id: envelope.mission_id,
		sequence_no: state.messages.length + 1,
		author_agent_id: participantAgentId,
		type: disposition.message_type,
		body: disposition.message,
		artifacts: disposition.artifacts ?? [],
		contract_version: state.contract_version,
		idempotency_key: `fixture:message:${envelope.sequence_no}`,
		causal_parent_message_id: state.messages.at(-1)?.message_id ?? null,
		created_at: envelope.created_at,
	};
}

function createRevision(turn: ScriptedMissionTurn): ContractRevision | null {
	if (turn.disposition.kind !== "propose_contract" || turn.revision === undefined) {
		return null;
	}
	return structuredClone(turn.revision);
}

function collectTurnArtifacts(
	artifacts: readonly HostInputArtifact[],
	state: MissionCoordinatorState,
	peerMessages: readonly Message[],
): HostInputArtifact[] {
	const required: Array<{ ref: ArtifactRef; expectedSource: ActorRef | null }> = [
		{ ref: state.active_contract, expectedSource: activeContractSource(state) },
	];
	for (const message of peerMessages) {
		for (const ref of message.artifacts) {
			const existing = required.find(
				(candidate) =>
					candidate.ref.artifact_id === ref.artifact_id && candidate.ref.version === ref.version,
			);
			if (existing !== undefined) {
				if (!isDeepStrictEqual(existing.ref, ref)) {
					throw new Error(`Conflicting fixture metadata for artifact ${ref.artifact_id}`);
				}
				continue;
			}
			required.push({ ref, expectedSource: null });
		}
	}
	const allowedSources: ActorRef[] = [
		state.mission_context.created_by,
		...state.mission_context.manifest.participants.map((participant) => ({
			principal_id: participant.agent_id,
			kind: "agent" as const,
		})),
	];
	return required.map(({ ref, expectedSource }) =>
		findArtifact(artifacts, ref, expectedSource, allowedSources),
	);
}

function activeContractSource(state: MissionCoordinatorState): ActorRef {
	if (isDeepStrictEqual(state.active_contract, state.mission_context.manifest.shared_contract)) {
		return structuredClone(state.mission_context.created_by);
	}
	const revision = state.accepted_revisions.find((candidate) =>
		isDeepStrictEqual(candidate.artifact, state.active_contract),
	);
	if (revision === undefined) {
		throw new Error(`No accepted revision owns contract version ${state.contract_version}`);
	}
	return { principal_id: revision.proposed_by_agent_id, kind: "agent" };
}

function findArtifact(
	artifacts: readonly HostInputArtifact[],
	ref: ArtifactRef,
	expectedSource: ActorRef | null,
	allowedSources: readonly ActorRef[],
): HostInputArtifact {
	const matches = artifacts.filter((candidate) => isDeepStrictEqual(candidate.artifact, ref));
	if (matches.length !== 1) {
		throw new Error(
			`Expected one exact fixture payload for artifact ${ref.artifact_id} v${ref.version}, found ${matches.length}`,
		);
	}
	const found = matches[0]!;
	if (expectedSource !== null && !isDeepStrictEqual(found.source, expectedSource)) {
		throw new Error(`Fixture provenance mismatch for artifact ${ref.artifact_id} v${ref.version}`);
	}
	if (!allowedSources.some((source) => isDeepStrictEqual(found.source, source))) {
		throw new Error(`Fixture artifact source is not a Mission actor: ${ref.artifact_id}`);
	}
	return structuredClone(found);
}

function eventEnvelope(sequence: number, missionId: string) {
	return {
		event_id: fixtureUuid("20000000", sequence),
		idempotency_key: `fixture:event:${sequence}`,
		mission_id: missionId,
		sequence_no: sequence,
		created_at: timestampFor(sequence),
	};
}

function fixtureUuid(prefix: string, sequence: number): string {
	return `${prefix}-0000-4000-8000-${sequence.toString().padStart(12, "0")}`;
}

function timestampFor(sequence: number): string {
	return new Date(Date.parse("2026-08-02T10:00:00.000Z") + sequence * 1_000).toISOString();
}

async function collect(events: AsyncIterable<HostEvent>): Promise<readonly HostEvent[]> {
	const collected: HostEvent[] = [];
	for await (const event of events) {
		collected.push(event);
	}
	return collected;
}

function assertDeepEqual(left: unknown, right: unknown, message: string): void {
	if (!isDeepStrictEqual(left, right)) {
		throw new Error(message);
	}
}

function requireValue<T>(value: T | undefined, name: string): T {
	if (value === undefined) {
		throw new Error(`Missing ${name}`);
	}
	return value;
}
