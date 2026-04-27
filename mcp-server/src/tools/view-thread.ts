/**
 * view_thread — read-only fetch of a handoff thread by id. Useful for the
 * sender's side of a handoff: after sending, you want to see the receiver's
 * replies without doing accept_handoff (which is a state-changing recipient
 * action).
 *
 * Same L1 provenance discipline as accept_handoff: every text field
 * originating from a teammate (summary, message bodies, proposed_action
 * rationale) is wrapped before being returned to the agent. The wrap fires
 * regardless of whether the caller is sender or recipient — anyone NOT the
 * caller is treated as untrusted input.
 *
 * No trust gate here: viewing a thread you're a participant in doesn't
 * trigger Layer 3 (no work is being delegated; this is just data retrieval).
 * Layer 4 audit still records the access via the relay.
 */

import { z } from "zod";
import type { A2AClient } from "../a2a-client.js";
import { wrap } from "../provenance.js";
import { artifactSchema, proposedActionSchema } from "./schemas.js";

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
	// Lifecycle timestamps so the agent can reason about thread state
	// without re-fetching.
	accepted_at: z.string().nullable().optional(),
	completed_at: z.string().nullable().optional(),
	cancelled_at: z.string().nullable().optional(),
});

const inputSchema = z.object({
	thread_id: z.string(),
	caller_handle: z.string(),
});

export interface ViewThreadDeps {
	client: A2AClient;
}

export type ViewThreadResult = z.infer<typeof tasksGetResponseSchema>;

export async function viewThread(
	deps: ViewThreadDeps,
	rawInput: unknown,
): Promise<ViewThreadResult> {
	const input = inputSchema.parse(rawInput);
	const fetched = await deps.client.request<unknown>("tasks/get", { task_id: input.thread_id });
	const thread = tasksGetResponseSchema.parse(fetched);

	// Wrap every author-not-self message with L1 provenance. The summary
	// always comes from the sender (handoff originator), so it gets wrapped
	// unless the caller is the sender themselves.
	const callerIsSender = thread.sender.handle === input.caller_handle;
	const senderHandle = thread.sender.handle;

	const wrappedSummary = callerIsSender
		? thread.summary
		: wrap({ senderHandle, content: thread.summary });

	const wrappedMessages = thread.messages.map((m) =>
		m.from === input.caller_handle
			? m
			: { ...m, body: wrap({ senderHandle: m.from, content: m.body }) },
	);

	const wrappedProposed =
		thread.proposed_action && !callerIsSender
			? {
					...thread.proposed_action,
					rationale: wrap({ senderHandle, content: thread.proposed_action.rationale }),
				}
			: thread.proposed_action ?? undefined;

	return {
		...thread,
		summary: wrappedSummary,
		messages: wrappedMessages,
		...(wrappedProposed ? { proposed_action: wrappedProposed } : {}),
	};
}
