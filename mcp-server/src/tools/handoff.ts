import { z } from "zod";
import type { A2AClient } from "../a2a-client.js";
import { handoffToTeammateInput } from "./schemas.js";

export interface HandoffToTeammateDeps {
	client: A2AClient;
	senderHandle: string;
}

export interface HandoffToTeammateResult {
	thread_id: string;
	status: "pending";
	recipient: string;
	created_at: string;
	inbox_url: string;
}

const relayResponseSchema = z.object({
	task_id: z.string(),
	status: z.object({ state: z.string() }).passthrough(),
	created_at: z.string(),
	inbox_url: z.string().optional(),
});

export async function handoffToTeammate(
	deps: HandoffToTeammateDeps,
	rawInput: unknown,
): Promise<HandoffToTeammateResult> {
	const input = handoffToTeammateInput.parse(rawInput);

	const idempotencyKey = deps.client.newIdempotencyKey();
	const params: Record<string, unknown> = {
		task_id: null,
		recipient: input.to,
		intent: input.intent,
		message: {
			role: "user",
			parts: [{ type: "text", text: input.summary }],
		},
		artifacts: input.artifacts ?? [],
		proposed_action: input.proposed_action ?? null,
		metadata: {
			...(input.metadata ?? {}),
			client_idempotency_key: idempotencyKey,
			question: input.question,
		},
	};

	const result = await deps.client.request<unknown>("message/send", params, { idempotencyKey });
	const parsed = relayResponseSchema.parse(result);

	return {
		thread_id: parsed.task_id,
		status: "pending",
		recipient: input.to,
		created_at: parsed.created_at,
		inbox_url: parsed.inbox_url ?? `${deriveRelayBase(deps.client)}/inbox/${parsed.task_id}`,
	};
}

function deriveRelayBase(_client: A2AClient): string {
	// A2AClient doesn't currently expose its base URL. Fallback to a relative
	// path; the relay's inbox_url field is the source of truth in practice.
	return "";
}
