import { z } from "zod";
import type { ProbeSession } from "./probe-session.js";
export {
	COMMUNICATION_CODEX_CONFIG as CODEX_PROBE_CONFIG,
	assertCommunicationMcpInventory as assertNoActiveMcpServers,
} from "../../src/live/codex-policy.js";

const toolCallSchema = z.object({
	threadId: z.string().min(1),
	turnId: z.string().min(1),
	callId: z.string().min(1),
	tool: z.enum(["receive_live_turn", "reply_live_turn"]),
	namespace: z.null().optional(),
	arguments: z.unknown(),
});

/** A host tool call must belong to the exact locally started thread and turn. */
export function answerCodexProbeTool(
	params: unknown,
	expected: { threadId: string; turnId: string },
	session: ProbeSession,
) {
	const call = toolCallSchema.parse(params);
	if (call.threadId !== expected.threadId || call.turnId !== expected.turnId) {
		throw new Error("Codex probe rejected a different host thread or turn");
	}
	const result =
		call.tool === "receive_live_turn"
			? session.receive(call.arguments)
			: session.reply(call.arguments);
	return {
		success: true,
		contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
	};
}
