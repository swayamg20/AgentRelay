import { z } from "zod";
import type { ProbeSession } from "./probe-session.js";

const toolCallSchema = z.object({
	threadId: z.string().min(1),
	turnId: z.string().min(1),
	callId: z.string().min(1),
	tool: z.enum(["receive_live_turn", "reply_live_turn"]),
	namespace: z.null().optional(),
	arguments: z.unknown(),
});

export function assertNoActiveMcpServers(input: unknown): void {
	z.object({
		data: z.array(
			z.object({
				runtimeStatus: z.literal("disabled"),
				tools: z.record(z.unknown()).refine((tools) => Object.keys(tools).length === 0),
				resources: z.array(z.unknown()).length(0),
				resourceTemplates: z.array(z.unknown()).length(0),
			}),
		),
		nextCursor: z.null(),
	}).parse(input);
}

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

// These are process-local overrides, never writes to the owner's config.toml.
export const CODEX_PROBE_CONFIG: Record<string, unknown> = {
	"features.shell_tool": false,
	"features.apps": false,
	"features.plugins": false,
	"features.hooks": false,
	"features.memories": false,
	"features.multi_agent": false,
	"features.multi_agent_v2": false,
	"features.code_mode": false,
	"features.browser_use": false,
	"features.computer_use": false,
	"features.image_generation": false,
	"features.view_image": false,
	"features.goals": false,
	"features.skill_search": false,
	"features.skill_mcp_dependency_install": false,
	"features.skip_host_skill_discovery": true,
	"features.workspace_dependencies": false,
	web_search: "disabled",
	model_reasoning_effort: "low",
	project_doc_max_bytes: 0,
	approval_policy: "never",
	approvals_reviewer: "user",
	sandbox_mode: "read-only",
	notify: [],
};
