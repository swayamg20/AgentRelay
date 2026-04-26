/**
 * accept_handoff — the most security-sensitive tool. It pulls a teammate's
 * full thread into the local agent, so it MUST:
 *
 *   1. Reject when the sender is blocked (Layer 4 kill switch).
 *   2. Wrap every text field originating from the teammate (summary,
 *      message bodies, proposed_action.rationale) with the L1 provenance
 *      preamble before returning to the agent.
 *   3. Compute the L3 trust overlay for this sender and return it so the
 *      agent (and its harness) know what's pre-authorized.
 *
 * The relay is contacted twice: `tasks/get` to read the thread, then
 * `tasks/update` with `transition: accept` to mark it accepted server-side.
 */

import { z } from "zod";
import type { A2AClient } from "../a2a-client.js";
import { wrap } from "../provenance.js";
import {
	type OverlayDecision,
	type TrustFile,
	computeOverlay,
} from "../trust.js";
import { acceptHandoffInput, artifactSchema, proposedActionSchema } from "./schemas.js";

const senderSchema = z.object({
	handle: z.string(),
	name: z.string(),
	role: z.string(),
	email: z.string().optional(),
});

const messageSchema = z.object({
	id: z.string(),
	sequence_no: z.number().int().nonnegative(),
	from: z.string(),
	body: z.string(),
	payload: z.record(z.string(), z.unknown()).optional(),
	created_at: z.string(),
});

const tasksGetResponseSchema = z.object({
	thread_id: z.string(),
	intent: z.enum(["inform", "ask_question", "propose_action"]),
	sender: senderSchema,
	summary: z.string(),
	artifacts: z.array(artifactSchema).default([]),
	proposed_action: proposedActionSchema.nullable().optional(),
	messages: z.array(messageSchema).default([]),
});

const tasksUpdateResponseSchema = z.object({
	accepted_at: z.string(),
});

export interface AcceptHandoffDeps {
	client: A2AClient;
	trust: TrustFile;
}

export interface AcceptHandoffResult {
	thread_id: string;
	status: "accepted";
	intent: "inform" | "ask_question" | "propose_action";
	sender: z.infer<typeof senderSchema>;
	summary: string;
	artifacts: z.infer<typeof artifactSchema>[];
	proposed_action?: z.infer<typeof proposedActionSchema>;
	messages: z.infer<typeof messageSchema>[];
	accepted_at: string;
	trust_overlay: {
		auto_read: boolean;
		auto_test: boolean;
		auto_write_paths: string[];
		require_approval: string[];
	};
}

export class HandoffRejectedByTrustError extends Error {
	constructor(public readonly decision: Extract<OverlayDecision, { decision: "reject" }>) {
		super(`Handoff rejected: ${decision.reason}`);
		this.name = "HandoffRejectedByTrustError";
	}
}

export async function acceptHandoff(
	deps: AcceptHandoffDeps,
	rawInput: unknown,
): Promise<AcceptHandoffResult> {
	const input = acceptHandoffInput.parse(rawInput);

	const fetched = await deps.client.request<unknown>("tasks/get", { task_id: input.thread_id });
	const thread = tasksGetResponseSchema.parse(fetched);

	// Layer 3 / Layer 4: trust gate. Decide BEFORE we touch the relay's
	// state machine again, so rejected handoffs leave no side effects.
	const decision = computeOverlay(deps.trust, thread.sender.handle);
	if (decision.decision === "reject") {
		throw new HandoffRejectedByTrustError(decision);
	}

	const idempotencyKey = deps.client.newIdempotencyKey();
	const updated = await deps.client.request<unknown>(
		"tasks/update",
		{
			task_id: input.thread_id,
			transition: "accept",
			session_id: input.session_id,
		},
		{ idempotencyKey },
	);
	const { accepted_at } = tasksUpdateResponseSchema.parse(updated);

	// Layer 1: provenance wrap every teammate-originated text field. This
	// is the only place these fields are emitted to the agent — there is no
	// path that returns un-wrapped content.
	const senderHandle = thread.sender.handle;
	const wrappedSummary = wrap({ senderHandle, content: thread.summary });
	const wrappedMessages = thread.messages.map((m) => ({
		...m,
		body: wrap({ senderHandle, content: m.body }),
	}));
	const wrappedProposed = thread.proposed_action
		? {
				...thread.proposed_action,
				rationale: wrap({ senderHandle, content: thread.proposed_action.rationale }),
			}
		: undefined;

	return {
		thread_id: thread.thread_id,
		status: "accepted",
		intent: thread.intent,
		sender: thread.sender,
		summary: wrappedSummary,
		artifacts: thread.artifacts,
		...(wrappedProposed ? { proposed_action: wrappedProposed } : {}),
		messages: wrappedMessages,
		accepted_at,
		trust_overlay: decision.overlay,
	};
}
