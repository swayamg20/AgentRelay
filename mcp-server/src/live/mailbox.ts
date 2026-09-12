import { z } from "zod";
import type { A2AClient } from "../a2a-client.js";
import { type ViewThreadResult, viewThread } from "../tools/view-thread.js";
import { type LiveScope, LiveSessionError, MAX_LIVE_INPUT_BYTES } from "./contracts.js";

export interface LiveMailbox {
	read(signal: AbortSignal): Promise<ViewThreadResult>;
	reply(
		input: { body: string; messageId: string; idempotencyKey: string },
		signal: AbortSignal,
	): Promise<string>;
}

export function createLiveMailbox(client: A2AClient, scope: LiveScope): LiveMailbox {
	return {
		async read(signal) {
			const thread = await viewThread(
				{ client, signal },
				{ thread_id: scope.threadId, caller_handle: scope.localHandle },
			);
			assertLiveThread(thread, scope);
			return thread;
		},
		async reply(input, signal) {
			const result = z
				.object({
					thread_id: z.literal(scope.threadId),
					message_id: z.string().uuid(),
					sequence_no: z.number().int().positive(),
				})
				.parse(
					await client.request(
						"message/send",
						{
							task_id: scope.threadId,
							message: { role: "user", parts: [{ type: "text", text: input.body }] },
							payload: {},
							artifacts: [],
							metadata: { agentrelay_live_reply_to: input.messageId },
						},
						{ idempotencyKey: input.idempotencyKey, signal },
					),
				);
			return result.message_id;
		},
	};
}

export function assertLiveThread(thread: ViewThreadResult, scope: LiveScope): void {
	const handles = [thread.sender.handle, thread.recipient?.handle];
	if (
		thread.thread_id !== scope.threadId ||
		!handles.includes(scope.localHandle) ||
		!handles.includes(scope.peerHandle)
	) {
		throw new LiveSessionError(
			"wrong_thread",
			"Relay returned a different thread or participant pair",
		);
	}
	if (thread.completed_at !== null || thread.cancelled_at !== null) {
		throw new LiveSessionError(
			"thread_closed",
			"The Relay thread is closed or has an unknown lifecycle",
		);
	}
	let previous = 0;
	const ids = new Set<string>();
	for (const message of thread.messages) {
		if (
			!z.string().uuid().safeParse(message.id).success ||
			message.sequence_no <= previous ||
			ids.has(message.id) ||
			!handles.includes(message.from)
		) {
			throw new LiveSessionError(
				"invalid_history",
				"Relay message history is not ordered and participant-scoped",
			);
		}
		ids.add(message.id);
		previous = message.sequence_no;
	}
}

export function liveTurnContent(thread: ViewThreadResult, sequence: number): string {
	// viewThread already provenance-marks every peer-bearing field, including
	// typed artifacts. Never forward raw tasks/get data or future messages.
	const content = JSON.stringify({
		thread_id: thread.thread_id,
		intent: thread.intent,
		summary: thread.summary,
		artifacts: thread.artifacts,
		metadata: thread.metadata,
		proposed_action: thread.proposed_action,
		messages: thread.messages.filter((message) => message.sequence_no <= sequence).slice(-12),
	});
	if (Buffer.byteLength(content) > MAX_LIVE_INPUT_BYTES) {
		throw new LiveSessionError(
			"input_limit",
			"Live context exceeds 32 KiB; inspect this thread manually",
		);
	}
	return content;
}
