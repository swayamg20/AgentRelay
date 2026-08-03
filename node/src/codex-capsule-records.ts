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
	type StoredCodexTurn,
	hostSessionFromState,
	hostTurnFromStored,
} from "./codex-capsule-state.js";
import type { CodexNormalizedTerminal } from "./codex-capsule-types.js";

export function storedIntent(intent: CodexCapsuleTurnIntent): StoredCodexTurn["provider_intent"] {
	return {
		prompt_version: 1,
		client_user_message_id: intent.clientUserMessageId,
		text: intent.text,
		text_sha256: intent.textSha256,
		output_schema: structuredClone(intent.outputSchema),
		output_schema_sha256: intent.outputSchemaSha256,
	};
}

export function publicIntent(turn: StoredCodexTurn): CodexCapsuleTurnIntent {
	return {
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

export function conflict(message: string): CapsuleOperationError {
	return new CapsuleOperationError("correlation_conflict", message);
}
