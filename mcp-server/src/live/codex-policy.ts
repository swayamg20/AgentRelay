import { z } from "zod";

// Process-local: never alter the owner's normal Codex or MCP configuration.
export const COMMUNICATION_CODEX_CONFIG: Record<string, unknown> = {
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

export function assertCommunicationMcpInventory(input: unknown): void {
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

export function codexChildEnvironment(source = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of [
		"PATH",
		"HOME",
		"USER",
		"LOGNAME",
		"TMPDIR",
		"LANG",
		"LC_ALL",
		"TERM",
		"OPENAI_API_KEY",
	]) {
		if (source[name] !== undefined) env[name] = source[name];
	}
	return env;
}
