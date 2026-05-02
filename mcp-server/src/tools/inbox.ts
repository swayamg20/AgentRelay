import { z } from "zod";
import type { A2AClient } from "../a2a-client.js";
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

export type InboxResponse = z.infer<typeof inboxResponseSchema>;

export async function checkInbox(client: A2AClient, rawInput: unknown): Promise<InboxResponse> {
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
	return inboxResponseSchema.parse(raw);
}
