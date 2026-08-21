import { type HostUsage, hostUsageSchema } from "@agentrelay/protocol";
import { z } from "zod";
import {
	type CodexRelevantNotification,
	type CodexThread,
	type CodexTurn,
	codexAgentMessageItemSchema,
	codexDynamicToolCallItemSchema,
	codexUserMessageItemSchema,
} from "./codex-app-server-protocol.js";
import {
	type CodexCapsuleTurnIntent,
	parseCodexCapsuleDisposition,
} from "./codex-capsule-prompt.js";
import type { CodexTerminalPatchAttestation } from "./codex-capsule-runner-contract.js";
import type { CodexNormalizedTerminal } from "./codex-capsule-types.js";
import { dynamicToolItemSha256 } from "./codex-dynamic-patch-tool.js";

const textContentSchema = z
	.object({ type: z.literal("text"), text: z.string().max(1_048_576) })
	.passthrough();

const SAFE_READ_ONLY_ITEM_TYPES = new Set(["userMessage", "agentMessage", "reasoning"]);

export type CodexTurnReconciliation =
	| { readonly kind: "none" }
	| { readonly kind: "matched"; readonly turn: CodexTurn };

/** Finds one exact correlated provider turn. It never treats clientId as provider idempotency. */
export function reconcileCodexTurn(
	thread: CodexThread,
	intent: CodexCapsuleTurnIntent,
): CodexTurnReconciliation {
	const matches: CodexTurn[] = [];
	for (const turn of thread.turns) {
		if (turn.itemsView !== "full") {
			throw new Error("Codex reconciliation requires full turn items");
		}
		for (const itemValue of turn.items) {
			const parsed = codexUserMessageItemSchema.safeParse(itemValue);
			if (!parsed.success || parsed.data.clientId !== intent.clientUserMessageId) continue;
			assertExactUserText(parsed.data.content, intent.text);
			matches.push(turn);
		}
	}
	if (matches.length > 1) {
		throw new Error("Codex client message correlation matched multiple provider turns");
	}
	return matches[0] === undefined
		? { kind: "none" }
		: { kind: "matched", turn: structuredClone(matches[0]) };
}

/** Reduces one authoritative terminal turn to bounded, provider-neutral output. */
export function normalizeCodexTerminal(
	turn: CodexTurn,
	cancellationRequested: boolean,
	patchAttestation: CodexTerminalPatchAttestation | null = null,
): CodexNormalizedTerminal {
	if (turn.status === "inProgress") throw new Error("Codex turn is not terminal");
	if (turn.itemsView === "full" && !hasOnlyAttestedItems(turn, patchAttestation)) {
		return safeFailure("policy_denied", "Codex turn attempted a disallowed capability");
	}
	if (patchAttestation?.fatalPatchFailure === true) {
		return safeFailure("transient", "Codex patch tool failed before a publishable turn result");
	}
	if (turn.status === "interrupted") {
		return cancellationRequested
			? { kind: "cancelled" }
			: safeFailure("transient", "Codex turn stopped without a local cancellation intent");
	}
	if (turn.status === "failed") {
		return safeFailure("transient", "Codex turn failed without publishable output");
	}
	if (turn.itemsView !== "full") {
		return safeFailure("permanent", "Codex completed without full authoritative output");
	}
	const finalAnswers = turn.items.flatMap((item) => {
		const parsed = codexAgentMessageItemSchema.safeParse(item);
		return parsed.success && parsed.data.phase === "final_answer" ? [parsed.data.text] : [];
	});
	if (finalAnswers.length !== 1) {
		return safeFailure("permanent", "Codex turn did not produce one structured final answer");
	}
	try {
		return { kind: "completed", disposition: parseCodexCapsuleDisposition(finalAnswers[0]!) };
	} catch {
		return safeFailure("permanent", "Codex final answer violated the structured output contract");
	}
}

function hasOnlyAttestedItems(
	turn: CodexTurn,
	patchAttestation: CodexTerminalPatchAttestation | null,
): boolean {
	const expected = new Map<string, string>();
	if (patchAttestation !== null) {
		if (patchAttestation.providerTurnId !== turn.id) return false;
		for (const call of patchAttestation.calls) {
			if (expected.has(call.callId)) return false;
			expected.set(call.callId, call.itemSha256);
		}
	}
	let observed = 0;
	for (const item of turn.items) {
		if (SAFE_READ_ONLY_ITEM_TYPES.has(item.type)) continue;
		if (patchAttestation === null || item.type !== "dynamicToolCall") return false;
		const parsed = codexDynamicToolCallItemSchema.safeParse(item);
		if (!parsed.success || expected.get(parsed.data.id) !== dynamicToolItemSha256(parsed.data)) {
			return false;
		}
		expected.delete(parsed.data.id);
		observed += 1;
	}
	return patchAttestation === null
		? true
		: observed === patchAttestation.calls.length && expected.size === 0;
}

export function normalizeCodexTurnUsage(
	notification: Extract<CodexRelevantNotification, { method: "thread/tokenUsage/updated" }>,
	expectedThreadId: string,
	expectedTurnId: string,
): HostUsage {
	if (
		notification.params.threadId !== expectedThreadId ||
		notification.params.turnId !== expectedTurnId
	) {
		throw new Error("Codex usage notification does not match the active turn");
	}
	const usage = notification.params.tokenUsage.last;
	return hostUsageSchema.parse({
		available: true,
		scope: "turn_cumulative",
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
	});
}

function assertExactUserText(content: readonly unknown[], expected: string): void {
	if (content.length !== 1) throw new Error("Correlated Codex user message has unexpected content");
	const parsed = textContentSchema.safeParse(content[0]);
	if (!parsed.success || parsed.data.text !== expected) {
		throw new Error("Correlated Codex user message does not match the durable provider intent");
	}
}

function safeFailure(
	classification: "transient" | "permanent" | "policy_denied",
	message: string,
): CodexNormalizedTerminal {
	return { kind: "failed", failure: { class: classification, message } };
}
