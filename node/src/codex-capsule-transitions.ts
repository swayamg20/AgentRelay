import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
	HostEvent,
	HostSessionRef,
	HostTurnRef,
	HostUsage,
	StartTurnInput,
} from "@agentrelay/protocol";
import { digestStartTurnInput, executionKey } from "./capsule-correlation.js";
import { CapsuleOperationError } from "./capsule-operation-error.js";
import { buildCodexCapsuleTurnIntent } from "./codex-capsule-prompt.js";
import {
	assertSameInput,
	conflict,
	parseTerminal,
	publicIntent,
	replayTerminalEvents,
	requireReadySession,
	requireTurnByInput,
	requireTurnByRef,
	storedIntent,
} from "./codex-capsule-records.js";
import {
	type CodexCapsuleState,
	type StoredCodexTurn,
	cloneStoredEvents,
	hostSessionFromState,
	hostTurnFromStored,
} from "./codex-capsule-state.js";
import type {
	CodexInterruptClaim,
	CodexNormalizedTerminal,
	CodexSessionStartClaim,
	CodexTurnStartClaim,
} from "./codex-capsule-types.js";

export function claimSessionStart(state: CodexCapsuleState): CodexSessionStartClaim {
	if (state.session.phase === "ready") {
		return {
			kind: "ready",
			session: hostSessionFromState(state),
			threadId: state.session.codex_thread_id!,
		};
	}
	if (state.session.phase === "start_maybe_sent") return { kind: "reconcile" };
	state.session.phase = "start_maybe_sent";
	return { kind: "send" };
}

export function acceptSession(state: CodexCapsuleState, threadId: string): HostSessionRef {
	if (state.session.phase === "ready") {
		if (state.session.codex_thread_id !== threadId) {
			throw conflict("Codex Capsule session is already bound to another thread");
		}
		return hostSessionFromState(state);
	}
	if (state.session.phase !== "start_maybe_sent") {
		throw conflict("Codex Capsule thread acceptance is missing its start barrier");
	}
	state.session.phase = "ready";
	state.session.codex_thread_id = threadId;
	return hostSessionFromState(state);
}

export function resetUnboundSessionAfterQuiescence(state: CodexCapsuleState): void {
	if (state.session.phase !== "start_maybe_sent" || state.session.codex_thread_id !== null) {
		throw conflict("Codex Capsule session has no unresolved thread start");
	}
	if (Object.keys(state.turns).length > 0) {
		throw conflict("Codex Capsule cannot replace a session after preparing a turn");
	}
	state.session.phase = "prepared";
}

export function prepareTurn(
	state: CodexCapsuleState,
	input: StartTurnInput,
	timestamp: string,
): HostTurnRef {
	const session = requireReadySession(state);
	if (!isDeepStrictEqual(input.session, session)) {
		throw new CapsuleOperationError("scope_mismatch", "Turn does not match the Codex session");
	}
	const key = executionKey(input.deliveryId, input.executionAttempt);
	const existing = state.turns[key];
	if (existing !== undefined) {
		assertSameInput(existing, input);
		return hostTurnFromStored(existing);
	}
	if (Object.values(state.turns).some((turn) => turn.phase !== "terminal")) {
		throw conflict("Codex Capsule already has an active turn");
	}
	const turn: StoredCodexTurn = {
		input: structuredClone(input),
		input_sha256: digestStartTurnInput(input),
		host_turn_id: `capsule-turn-${randomUUID()}`,
		phase: "prepared",
		codex_turn_id: null,
		provider_intent: storedIntent(buildCodexCapsuleTurnIntent(input)),
		cancellation: "none",
		events: [],
		created_at: timestamp,
		updated_at: timestamp,
	};
	const ref = hostTurnFromStored(turn);
	turn.events.push({ kind: "accepted", turn: ref, sequence: 1 });
	state.turns[key] = turn;
	return ref;
}

export function claimTurnStart(
	state: CodexCapsuleState,
	input: StartTurnInput,
): CodexTurnStartClaim {
	const turn = requireTurnByInput(state, input);
	if (turn.phase === "prepared") {
		turn.phase = "start_maybe_sent";
		return { kind: "send", intent: publicIntent(turn) };
	}
	if (
		turn.phase === "start_maybe_sent" ||
		(turn.phase === "cancelling" && turn.codex_turn_id === null)
	) {
		return { kind: "reconcile", intent: publicIntent(turn) };
	}
	return {
		kind: "accepted",
		turn: hostTurnFromStored(turn),
		terminal: turn.phase === "terminal",
	};
}

export function acceptTurn(
	state: CodexCapsuleState,
	input: StartTurnInput,
	codexTurnId: string,
): HostTurnRef {
	const turn = requireTurnByInput(state, input);
	if (turn.codex_turn_id !== null) {
		if (turn.codex_turn_id !== codexTurnId) {
			throw conflict("Codex execution is already bound to another provider turn");
		}
		return hostTurnFromStored(turn);
	}
	if (turn.phase !== "start_maybe_sent" && turn.phase !== "cancelling") {
		throw conflict("Codex turn acceptance is missing its at-most-once start barrier");
	}
	turn.codex_turn_id = codexTurnId;
	if (turn.phase === "start_maybe_sent") turn.phase = "accepted";
	return hostTurnFromStored(turn);
}

export function requestCancellation(state: CodexCapsuleState, ref: HostTurnRef): void {
	const turn = requireTurnByRef(state, ref);
	if (turn.phase === "terminal" || turn.phase === "cancelling") return;
	if (turn.phase === "prepared") {
		turn.cancellation = "requested";
		appendTerminal(turn, { available: false, reason: "not_reported" }, { kind: "cancelled" });
		return;
	}
	turn.phase = "cancelling";
	turn.cancellation = "requested";
}

export function claimInterrupt(state: CodexCapsuleState, ref: HostTurnRef): CodexInterruptClaim {
	const turn = requireTurnByRef(state, ref);
	if (turn.phase === "terminal") return { kind: "terminal" };
	if (turn.phase !== "cancelling") throw conflict("Codex cancellation was not requested");
	if (turn.codex_turn_id === null) return { kind: "awaiting_provider" };
	if (turn.cancellation === "interrupt_maybe_sent") return { kind: "reconcile" };
	turn.cancellation = "interrupt_maybe_sent";
	return {
		kind: "send",
		threadId: state.session.codex_thread_id!,
		codexTurnId: turn.codex_turn_id,
	};
}

/** Closes an uncertain interrupt only after generation quiescence and one exact provider read. */
export function recordUncertainInterruptAfterQuiescence(
	state: CodexCapsuleState,
	ref: HostTurnRef,
	expectedInput: StartTurnInput,
): readonly HostEvent[] {
	const turn = requireTurnByRef(state, ref);
	assertSameInput(turn, expectedInput);
	if (turn.phase === "terminal") return cloneStoredEvents(turn);
	if (
		turn.phase !== "cancelling" ||
		turn.cancellation !== "interrupt_maybe_sent" ||
		turn.codex_turn_id === null
	) {
		throw conflict("Codex turn has no uncertain provider interrupt to close");
	}
	appendTerminal(
		turn,
		{ available: false, reason: "not_reported" },
		{
			kind: "failed",
			failure: {
				class: "transient",
				message: "Codex cancellation outcome could not be recovered after provider shutdown",
			},
		},
	);
	return cloneStoredEvents(turn);
}

export function recordUnmatchedStartAfterQuiescence(
	state: CodexCapsuleState,
	ref: HostTurnRef,
	expectedInput: StartTurnInput,
): readonly HostEvent[] {
	const turn = requireTurnByRef(state, ref);
	assertSameInput(turn, expectedInput);
	if (turn.phase === "terminal") return cloneStoredEvents(turn);
	if (
		(turn.phase !== "start_maybe_sent" && turn.phase !== "cancelling") ||
		turn.codex_turn_id !== null
	) {
		throw conflict("Codex turn is not an unresolved provider start");
	}
	const outcome: CodexNormalizedTerminal =
		turn.cancellation === "none"
			? {
					kind: "failed",
					failure: {
						class: "transient",
						message: "Codex start could not be recovered after provider shutdown",
					},
				}
			: { kind: "cancelled" };
	appendTerminal(turn, { available: false, reason: "not_reported" }, outcome);
	return cloneStoredEvents(turn);
}

export function recordTerminal(
	state: CodexCapsuleState,
	ref: HostTurnRef,
	usage: HostUsage,
	outcomeValue: CodexNormalizedTerminal,
): readonly HostEvent[] {
	const outcome = parseTerminal(outcomeValue);
	const turn = requireTurnByRef(state, ref);
	if (turn.phase === "terminal") return replayTerminalEvents(turn, usage, outcome);
	if (outcome.kind === "cancelled" && turn.phase !== "cancelling") {
		throw conflict("Codex cancellation lacks a durable local cancellation intent");
	}
	if (turn.phase !== "accepted" && turn.phase !== "cancelling") {
		throw conflict("Codex terminal result arrived before durable provider binding");
	}
	appendTerminal(turn, usage, outcome);
	return cloneStoredEvents(turn);
}

function appendTerminal(
	turn: StoredCodexTurn,
	usage: HostUsage,
	outcome: CodexNormalizedTerminal,
): void {
	const ref = hostTurnFromStored(turn);
	turn.events.push({ kind: "usage", turn: ref, sequence: turn.events.length + 1, usage });
	turn.events.push({ ...outcome, turn: ref, sequence: turn.events.length + 1 });
	turn.phase = "terminal";
}
