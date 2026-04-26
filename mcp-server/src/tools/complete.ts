import { z } from "zod";
import type { A2AClient } from "../a2a-client.js";
import { completeHandoffInput } from "./schemas.js";

const responseSchema = z.object({
	thread_id: z.string(),
	status: z.literal("completed"),
	completed_at: z.string(),
});

export type CompleteHandoffResult = z.infer<typeof responseSchema>;

export async function completeHandoff(
	client: A2AClient,
	rawInput: unknown,
): Promise<CompleteHandoffResult> {
	const input = completeHandoffInput.parse(rawInput);
	const idempotencyKey = client.newIdempotencyKey();
	const params = {
		task_id: input.thread_id,
		transition: "complete",
		result_summary: input.result_summary,
		artifacts: input.artifacts ?? [],
	};
	const result = await client.request<unknown>("tasks/update", params, { idempotencyKey });
	return responseSchema.parse(result);
}
