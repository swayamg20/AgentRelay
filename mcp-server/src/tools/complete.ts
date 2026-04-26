import { z } from "zod";
import type { A2AClient } from "../a2a-client.js";
import { completeHandoffInput } from "./schemas.js";

// Relay returns both legacy (`status: {state}`) and rich (top-level
// `completed_at`) fields. We accept either status form and normalise
// to the literal "completed" string the MCP tool returns.
const wireSchema = z.object({
	thread_id: z.string(),
	status: z.union([
		z.literal("completed"),
		z.object({ state: z.literal("completed") }),
	]),
	completed_at: z.string(),
});

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
	const wire = wireSchema.parse(result);
	return {
		thread_id: wire.thread_id,
		status: "completed",
		completed_at: wire.completed_at,
	};
}
