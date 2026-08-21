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
	assertSamePatchCallRequest,
	conflict,
	parsePatchReceipt,
	parseTerminal,
	publicIntent,
	publicPatchCall,
	publicPatchReceipt,
	replayTerminalEvents,
	requireReadySession,
	requireTurnByInput,
	requireTurnByRef,
	storedIntent,
} from "./codex-capsule-records.js";
import {
	CODEX_PATCH_MAX_CALLS_PER_TURN,
	CODEX_PATCH_MAX_RETAINED_RAW_BYTES_PER_TURN,
	type CodexCapsuleState,
	type StoredCodexPatchCall,
	type StoredCodexTurn,
	assertCodexCapsuleStateStorageBound,
	cloneStoredEvents,
	hostSessionFromState,
	hostTurnFromStored,
} from "./codex-capsule-state.js";
import type {
	CodexInterruptClaim,
	CodexNormalizedTerminal,
	CodexPatchCallClaim,
	CodexPatchCallReceipt,
	CodexPatchCallRequest,
	CodexSessionStartClaim,
	CodexTurnStartClaim,
} from "./codex-capsule-types.js";
import {
	CODEX_DYNAMIC_PATCH_TOOL_CONTRACT,
	type CodexDynamicPatchToolContract,
} from "./codex-dynamic-patch-tool-contract.js";
import {
	type CodexPatchAuthorityRecord,
	type CodexPatchToolCall,
	codexPatchSha256,
	codexPatchTransactionId,
	parseCodexPatchToolCall,
} from "./codex-workspace-patch-contract.js";

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
	toolContract: CodexDynamicPatchToolContract | null,
): HostTurnRef {
	const session = requireReadySession(state);
	if (!isDeepStrictEqual(input.session, session)) {
		throw new CapsuleOperationError("scope_mismatch", "Turn does not match the Codex session");
	}
	const key = executionKey(input.deliveryId, input.executionAttempt);
	const existing = state.turns[key];
	if (existing !== undefined) {
		assertSameInput(existing, input);
		if (existing.provider_intent.tool_contract !== toolContract) {
			throw conflict("Codex execution was reused with a different patch tool contract");
		}
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
		provider_intent: storedIntent(buildCodexCapsuleTurnIntent(input, toolContract)),
		cancellation: "none",
		patch_calls: {},
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

export function claimPatchCall(
	state: CodexCapsuleState,
	request: CodexPatchCallRequest,
	timestamp: string,
): CodexPatchCallClaim {
	const replay = inspectPatchCall(state, request);
	if (replay !== null) return replay;
	const transactionId = patchTransactionId(state, request);

	if (
		state.session.phase !== "ready" ||
		state.session.codex_thread_id !== request.providerThreadId
	) {
		throw new CapsuleOperationError(
			"scope_mismatch",
			"Codex patch call does not match the active provider thread",
		);
	}
	const active = Object.values(state.turns).filter((turn) => turn.phase !== "terminal");
	if (active.length !== 1 || active[0] === undefined) {
		throw new CapsuleOperationError("scope_mismatch", "Codex patch call has no active Host turn");
	}
	const turn = active[0];
	if (turn.phase === "prepared") {
		throw conflict("Codex patch call arrived before the provider turn start barrier");
	}
	if (turn.provider_intent.tool_contract !== CODEX_DYNAMIC_PATCH_TOOL_CONTRACT) {
		throw conflict("Codex patch call is not enabled for this exact provider intent");
	}
	if (turn.codex_turn_id !== null && turn.codex_turn_id !== request.providerTurnId) {
		throw conflict("Codex patch call does not match the active provider turn");
	}
	if (Object.keys(turn.patch_calls).length >= CODEX_PATCH_MAX_CALLS_PER_TURN) {
		throw conflict("Codex patch call limit is exhausted for this Host turn");
	}

	const call = parseCodexPatchToolCall({
		capsuleId: state.capsule_id,
		providerThreadId: request.providerThreadId,
		providerTurnId: request.providerTurnId,
		callId: request.callId,
		hostTurn: hostTurnFromStored(turn),
		patch: request.patch,
	});
	bindPatchCallToProviderTurn(turn, call.providerTurnId);
	const patchBytes = Buffer.byteLength(call.patch, "utf8");
	const retainedBytes = Object.values(turn.patch_calls).reduce(
		(total, stored) => total + (stored.patch === null ? 0 : stored.patch_bytes),
		0,
	);
	const rejected =
		turn.cancellation !== "none" ||
		retainedBytes + patchBytes > CODEX_PATCH_MAX_RETAINED_RAW_BYTES_PER_TURN;
	const stored: StoredCodexPatchCall = {
		transaction_id: transactionId,
		provider_thread_id: call.providerThreadId,
		provider_turn_id: call.providerTurnId,
		call_id: call.callId,
		host_turn: structuredClone(call.hostTurn),
		authority: structuredClone(request.authority),
		patch_sha256: codexPatchSha256(call.patch),
		patch_bytes: patchBytes,
		patch: rejected ? null : call.patch,
		receipt: rejected ? { outcome: "rejected" } : null,
		created_at: timestamp,
		updated_at: timestamp,
	};
	turn.patch_calls[transactionId] = stored;
	if (!rejected) {
		try {
			assertCodexCapsuleStateStorageBound(state);
		} catch {
			stored.patch = null;
			stored.receipt = { outcome: "rejected" };
		}
	}
	assertCodexCapsuleStateStorageBound(state);
	return stored.receipt === null
		? { kind: "pending", call, replayed: false }
		: { kind: "terminal", receipt: publicPatchReceipt(stored), replayed: false };
}

export function inspectPatchCall(
	state: CodexCapsuleState,
	request: CodexPatchCallRequest,
): CodexPatchCallClaim | null {
	const existing = findPatchCall(state, patchTransactionId(state, request));
	if (existing === null) return null;
	assertSamePatchCallRequest(existing, request);
	return existing.receipt === null
		? {
				kind: "pending",
				call: publicPatchCall(state.capsule_id, existing),
				replayed: true,
			}
		: { kind: "terminal", receipt: publicPatchReceipt(existing), replayed: true };
}

export function recordPatchCallReceipt(
	state: CodexCapsuleState,
	call: CodexPatchToolCall,
	authority: CodexPatchAuthorityRecord,
	receiptValue: CodexPatchCallReceipt,
	timestamp: string,
): CodexPatchCallReceipt {
	if (call.capsuleId !== state.capsule_id) {
		throw conflict("Codex patch receipt belongs to another Capsule");
	}
	const transactionId = codexPatchTransactionId({
		capsule_id: call.capsuleId,
		provider_thread_id: call.providerThreadId,
		provider_turn_id: call.providerTurnId,
		call_id: call.callId,
	});
	const stored = findPatchCall(state, transactionId);
	if (stored === null) throw conflict("Codex patch receipt has no durable request barrier");
	assertSamePatchCallRequest(stored, {
		providerThreadId: call.providerThreadId,
		providerTurnId: call.providerTurnId,
		callId: call.callId,
		patch: call.patch,
		authority,
	});
	if (!isDeepStrictEqual(stored.host_turn, call.hostTurn)) {
		throw conflict("Codex patch receipt does not match its durable Host turn");
	}
	const receipt = parsePatchReceipt(receiptValue);
	if (stored.receipt !== null) {
		if (!isDeepStrictEqual(stored.receipt, receipt)) {
			throw conflict("Codex patch call already has a different terminal receipt");
		}
		return publicPatchReceipt(stored);
	}
	if (
		receipt.outcome === "applied" &&
		(receipt.result.transactionId !== transactionId ||
			receipt.result.patchSha256 !== stored.patch_sha256)
	) {
		throw conflict("Codex patch result does not match its durable request");
	}
	stored.patch = null;
	stored.receipt = structuredClone(receipt);
	stored.updated_at = timestamp;
	return publicPatchReceipt(stored);
}

export function pendingPatchCalls(
	state: CodexCapsuleState,
	authority: CodexPatchAuthorityRecord,
): readonly CodexPatchToolCall[] {
	const calls: CodexPatchToolCall[] = [];
	for (const turn of Object.values(state.turns)) {
		for (const stored of Object.values(turn.patch_calls)) {
			if (stored.receipt !== null) continue;
			if (!isDeepStrictEqual(stored.authority, authority)) {
				throw conflict("Pending Codex patch request belongs to another runtime authority");
			}
			calls.push(publicPatchCall(state.capsule_id, stored));
		}
	}
	return Object.freeze(
		calls.sort((left, right) => {
			const leftId = codexPatchTransactionId({
				capsule_id: left.capsuleId,
				provider_thread_id: left.providerThreadId,
				provider_turn_id: left.providerTurnId,
				call_id: left.callId,
			});
			const rightId = codexPatchTransactionId({
				capsule_id: right.capsuleId,
				provider_thread_id: right.providerThreadId,
				provider_turn_id: right.providerTurnId,
				call_id: right.callId,
			});
			return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
		}),
	);
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
	if (Object.values(turn.patch_calls).some((call) => call.receipt === null)) {
		throw conflict("Codex turn cannot become terminal with an unresolved patch request");
	}
	const ref = hostTurnFromStored(turn);
	turn.events.push({ kind: "usage", turn: ref, sequence: turn.events.length + 1, usage });
	turn.events.push({ ...outcome, turn: ref, sequence: turn.events.length + 1 });
	turn.phase = "terminal";
}

function findPatchCall(
	state: CodexCapsuleState,
	transactionId: string,
): StoredCodexPatchCall | null {
	let found: StoredCodexPatchCall | null = null;
	for (const turn of Object.values(state.turns)) {
		const candidate = turn.patch_calls[transactionId];
		if (candidate === undefined) continue;
		if (found !== null) throw conflict("Codex patch transaction is duplicated in Capsule state");
		found = candidate;
	}
	return found;
}

function patchTransactionId(state: CodexCapsuleState, request: CodexPatchCallRequest): string {
	return codexPatchTransactionId({
		capsule_id: state.capsule_id,
		provider_thread_id: request.providerThreadId,
		provider_turn_id: request.providerTurnId,
		call_id: request.callId,
	});
}

function bindPatchCallToProviderTurn(turn: StoredCodexTurn, providerTurnId: string): void {
	if (turn.codex_turn_id !== null) return;
	if (turn.phase !== "start_maybe_sent" && turn.phase !== "cancelling") {
		throw conflict("Codex patch call cannot establish the provider turn binding");
	}
	turn.codex_turn_id = providerTurnId;
	if (turn.phase === "start_maybe_sent") turn.phase = "accepted";
}
