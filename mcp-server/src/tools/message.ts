import { z } from "zod";
import type { A2AClient } from "../a2a-client.js";
import { sendMessageInput } from "./schemas.js";

const responseSchema = z.object({
	thread_id: z.string(),
	message_id: z.string(),
	sequence_no: z.number().int().nonnegative(),
	created_at: z.string(),
});

export type SendMessageResult = z.infer<typeof responseSchema>;

export async function sendMessage(client: A2AClient, rawInput: unknown): Promise<SendMessageResult> {
	const input = sendMessageInput.parse(rawInput);
	const idempotencyKey = client.newIdempotencyKey();
	const params = {
		task_id: input.thread_id,
		message: {
			role: "user",
			parts: [{ type: "text", text: input.body }],
		},
		metadata: {
			...(input.payload ?? {}),
			client_idempotency_key: idempotencyKey,
		},
	};
	const result = await client.request<unknown>("message/send", params, { idempotencyKey });
	return responseSchema.parse(result);
}
