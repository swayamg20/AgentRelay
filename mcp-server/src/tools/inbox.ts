import { z } from "zod";
import type { A2AClient } from "../a2a-client.js";
import { checkInboxInput, handoffStatusSchema } from "./schemas.js";

const inboxItemSchema = z.object({
	thread_id: z.string(),
	sender: z.object({
		handle: z.string(),
		name: z.string(),
		role: z.string(),
	}),
	summary_preview: z.string(),
	status: handoffStatusSchema,
	unread_messages: z.number().int().nonnegative(),
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
		role: "recipient",
		status: input.status ?? ["pending", "accepted"],
		since: input.since,
		limit: input.limit ?? 50,
	};
	const result = await client.request<unknown>("tasks/list", params);
	return inboxResponseSchema.parse(result);
}
