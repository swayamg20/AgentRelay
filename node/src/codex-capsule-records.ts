import { isDeepStrictEqual } from "node:util";
import {
	type HostEvent,
	type HostSessionRef,
	type HostTurnRef,
	type HostUsage,
	type StartTurnInput,
	hostFailureSchema,
	turnDispositionSchema,
} from "@agentrelay/protocol";
import { digestStartTurnInput, executionKey } from "./capsule-correlation.js";
import { CapsuleOperationError } from "./capsule-operation-error.js";
import {
	type CodexCapsuleTurnIntent,
	parseCodexCapsuleDisposition,
} from "./codex-capsule-prompt.js";
import {
	type CodexCapsuleState,
	type StoredCodexPatchCall,
	type StoredCodexTurn,
	hostSessionFromState,
	hostTurnFromStored,
	storedCodexPatchReceiptSchema,
} from "./codex-capsule-state.js";
import type {
	CodexNormalizedTerminal,
	CodexPatchCallReceipt,
	CodexPatchCallRequest,
} from "./codex-capsule-types.js";
import { type CodexPatchToolCall, codexPatchSha256 } from "./codex-workspace-patch-contract.js";

export function storedIntent(intent: CodexCapsuleTurnIntent): StoredCodexTurn["provider_intent"] {
	return {
		prompt_version: intent.promptVersion,
		tool_contract: intent.toolContract,
		client_user_message_id: intent.clientUserMessageId,
		text: intent.text,
		text_sha256: intent.textSha256,
		output_schema: structuredClone(intent.outputSchema),
		output_schema_sha256: intent.outputSchemaSha256,
	};
}

export function publicIntent(turn: StoredCodexTurn): CodexCapsuleTurnIntent {
	return {
		promptVersion: turn.provider_intent.prompt_version,
		toolContract: turn.provider_intent.tool_contract,
		clientUserMessageId: turn.provider_intent.client_user_message_id,
		text: turn.provider_intent.text,
		textSha256: turn.provider_intent.text_sha256,
		outputSchema: structuredClone(turn.provider_intent.output_schema),
		outputSchemaSha256: turn.provider_intent.output_schema_sha256,
	};
}

export function requireReadySession(state: CodexCapsuleState): HostSessionRef {
	if (state.session.phase !== "ready") {
		throw new CapsuleOperationError("scope_mismatch", "Codex Capsule session is not ready");
	}
	return hostSessionFromState(state);
}

export function requireTurnByInput(
	state: CodexCapsuleState,
	input: StartTurnInput,
): StoredCodexTurn {
	const turn = state.turns[executionKey(input.deliveryId, input.executionAttempt)];
	if (turn === undefined)
		throw new CapsuleOperationError("not_found", "Codex turn is not prepared");
	assertSameInput(turn, input);
	return turn;
}

export function requireTurnByRef(state: CodexCapsuleState, ref: HostTurnRef): StoredCodexTurn {
	const turn = state.turns[executionKey(ref.deliveryId, ref.executionAttempt)];
	if (turn === undefined || !isDeepStrictEqual(hostTurnFromStored(turn), ref)) {
		throw new CapsuleOperationError("not_found", `Codex Capsule turn was not found: ${ref.turnId}`);
	}
	return turn;
}

export function assertSameInput(turn: StoredCodexTurn, input: StartTurnInput): void {
	if (!isDeepStrictEqual(turn.input, input) || turn.input_sha256 !== digestStartTurnInput(input)) {
		throw conflict("Codex execution key was reused with a different exact input");
	}
}

export function parseTerminal(outcome: CodexNormalizedTerminal): CodexNormalizedTerminal {
	if (outcome.kind === "completed") {
		const disposition = turnDispositionSchema.parse(outcome.disposition);
		parseCodexCapsuleDisposition(JSON.stringify(disposition));
		return { kind: "completed", disposition };
	}
	if (outcome.kind === "failed") {
		return { kind: "failed", failure: hostFailureSchema.parse(outcome.failure) };
	}
	return { kind: "cancelled" };
}

export function replayTerminalEvents(
	turn: StoredCodexTurn,
	usage: HostUsage,
	outcome: CodexNormalizedTerminal,
): readonly HostEvent[] {
	const ref = hostTurnFromStored(turn);
	const terminal = turn.events.at(-1);
	const usageEvent = turn.events.at(-2);
	if (terminal === undefined || usageEvent?.kind !== "usage") {
		throw conflict("Codex terminal replay is missing its durable usage event");
	}
	const expectedTerminal = { ...outcome, turn: ref, sequence: terminal.sequence };
	if (
		!isDeepStrictEqual(usageEvent.usage, usage) ||
		!isDeepStrictEqual(terminal, expectedTerminal)
	) {
		throw conflict("Codex terminal replay conflicts with durable output");
	}
	return structuredClone(turn.events);
}

export function assertSamePatchCallRequest(
	stored: StoredCodexPatchCall,
	request: CodexPatchCallRequest,
): void {
	let patchSha256: string;
	try {
		patchSha256 = codexPatchSha256(request.patch);
	} catch {
		throw conflict("Codex patch call contains invalid raw input");
	}
	if (
		stored.provider_thread_id !== request.providerThreadId ||
		stored.provider_turn_id !== request.providerTurnId ||
		stored.call_id !== request.callId ||
		!isDeepStrictEqual(stored.authority, request.authority) ||
		stored.patch_bytes !== Buffer.byteLength(request.patch, "utf8") ||
		stored.patch_sha256 !== patchSha256 ||
		(stored.patch !== null && stored.patch !== request.patch)
	) {
		throw conflict("Codex patch call identity was reused with different exact input");
	}
}

export function publicPatchCall(
	capsuleId: string,
	stored: StoredCodexPatchCall,
): CodexPatchToolCall {
	if (stored.patch === null) {
		throw conflict("Codex terminal patch request no longer retains raw input");
	}
	return Object.freeze({
		capsuleId,
		providerThreadId: stored.provider_thread_id,
		providerTurnId: stored.provider_turn_id,
		callId: stored.call_id,
		hostTurn: Object.freeze({ ...stored.host_turn }),
		patch: stored.patch,
	});
}

export function publicPatchReceipt(stored: StoredCodexPatchCall): CodexPatchCallReceipt {
	if (stored.receipt === null) throw conflict("Codex patch call has no durable receipt");
	return structuredClone(stored.receipt);
}

export function parsePatchReceipt(value: CodexPatchCallReceipt): CodexPatchCallReceipt {
	return storedCodexPatchReceiptSchema.parse(value);
}

export function conflict(message: string): CapsuleOperationError {
	return new CapsuleOperationError("correlation_conflict", message);
}
