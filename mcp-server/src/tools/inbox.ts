import { z } from "zod";
import type { A2AClient } from "../a2a-client.js";
import { markExternalValue, markTeammateValue, wrap, wrapExternalReply } from "../provenance.js";
import { type ShareClient, shareInboxReceipt } from "../share-client.js";
import { checkInboxInput, handoffStatusSchema } from "./schemas.js";

// Wire shape uses rich `thread_id` + `sender:{...}` (lld §4.2). The relay
// also returns legacy `task_id`/`status:{state}`/`sender_id` fields for
// older A2A-style clients; we ignore those here and consume the rich
// fields directly.
const inboxItemSchema = z.object({
	thread_id: z.string(),
	sender: z.object({
		handle: z.string(),
		name: z.string(),
		role: z.string(),
	}),
	summary_preview: z.string(),
	intent: z.string().optional(),
	// Legacy `status` is `{state: string}` while rich shape doesn't have a
	// flat status yet — read both.
	status: z.union([
		handoffStatusSchema,
		z.object({ state: handoffStatusSchema }).transform((v) => v.state),
	]),
	unread_messages: z.number().int().nonnegative().default(0),
	created_at: z.string(),
	updated_at: z.string(),
});

const inboxResponseSchema = z.object({
	items: z.array(inboxItemSchema),
	next_cursor: z.string().nullable(),
});

export async function checkInbox(
	client: A2AClient,
	rawInput: unknown,
	shareInbox?: Pick<ShareClient, "inbox">,
) {
	const input = checkInboxInput.parse(rawInput ?? {});
	const params = {
		filter: {
			role: "recipient",
			status: input.status ?? ["pending", "accepted"],
			since: input.since,
		},
		page: { limit: input.limit ?? 50, cursor: null },
	};
	const raw = await client.request<unknown>("tasks/list", params);
	const parsed = inboxResponseSchema.parse(raw);
	const external = shareInbox
		? shareInboxReceipt.parse(
				await shareInbox.inbox({
					after_cursor: input.external_after_cursor ?? "0",
					limit: Math.min(input.limit ?? 50, 10),
					since: input.since,
				}),
			)
		: { replies: [], next_cursor: input.external_after_cursor ?? "0", has_more: false };
	return {
		...parsed,
		items: parsed.items.map((item) => ({
			...item,
			sender: markTeammateValue(item.sender.handle, item.sender),
			summary_preview: wrap({ senderHandle: item.sender.handle, content: item.summary_preview }),
		})),
		external_replies: external.replies.map((reply) =>
			markExternalValue({
				...reply,
				content: reply.content === null ? null : wrapExternalReply(reply.content),
			}),
		),
		external_next_cursor: external.next_cursor,
		external_has_more: external.has_more,
	};
}

export type InboxResponse = Awaited<ReturnType<typeof checkInbox>>;
