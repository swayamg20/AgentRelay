import { describe, expect, it } from "vitest";
import {
	CODEX_DISABLED_AGENTS_CONFIG,
	CODEX_DISABLED_WEB_SEARCH_CONFIG,
	CODEX_EPHEMERAL_AUTH_CONFIG,
	DISABLED_CODEX_FEATURES,
	buildCodexAppServerArguments,
	classifyAdmittedCodexProcessArguments,
} from "./codex-app-server-command.js";
import {
	CODEX_PROVIDER_BASE_URL_CONFIG,
	CODEX_PROVIDER_CONFIG,
} from "./codex-provider-egress-policy.js";

const EXPECTED_DISABLED_FEATURES = [
	"apps",
	"auth_elicitation",
	"browser_use",
	"browser_use_external",
	"browser_use_full_cdp_access",
	"code_mode",
	"code_mode_buffered_exec",
	"code_mode_host",
	"code_mode_only",
	"computer_use",
	"deferred_executor",
	"enable_mcp_apps",
	"executor_capability_discovery",
	"external_agent_memory_import",
	"goals",
	"guardian_approval",
	"hooks",
	"image_generation",
	"in_app_browser",
	"in_app_updates",
	"js_repl",
	"js_repl_tools_only",
	"memories",
	"multi_agent",
	"multi_agent_v2",
	"network_proxy",
	"plugin_sharing",
	"plugins",
	"remote_plugin",
	"request_permissions_tool",
	"shell_snapshot",
	"shell_tool",
	"skill_mcp_dependency_install",
	"skill_search",
	"standalone_web_search",
	"tool_call_mcp_elicitation",
	"tool_suggest",
	"workspace_dependencies",
] as const;

describe("Codex app-server command", () => {
	it("pins the patch-only process configuration", () => {
		expect(DISABLED_CODEX_FEATURES).toEqual(EXPECTED_DISABLED_FEATURES);
		expect(buildCodexAppServerArguments()).toEqual([
			"--strict-config",
			"--config",
			CODEX_EPHEMERAL_AUTH_CONFIG,
			"--config",
			CODEX_PROVIDER_CONFIG,
			"--config",
			CODEX_PROVIDER_BASE_URL_CONFIG,
			"--config",
			CODEX_DISABLED_AGENTS_CONFIG,
			"--config",
			CODEX_DISABLED_WEB_SEARCH_CONFIG,
			...EXPECTED_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
			"app-server",
			"--listen",
			"stdio://",
		]);
	});

	it("disables native command surfaces without disabling native apply_patch", () => {
		expect(CODEX_DISABLED_AGENTS_CONFIG).toBe("agents.enabled=false");
		expect(CODEX_DISABLED_WEB_SEARCH_CONFIG).toBe('web_search="disabled"');
		expect(DISABLED_CODEX_FEATURES).toEqual(
			expect.arrayContaining([
				"shell_tool",
				"shell_snapshot",
				"code_mode",
				"hooks",
				"plugins",
				"apps",
				"multi_agent",
			]),
		);
		expect(DISABLED_CODEX_FEATURES).not.toContain("apply_patch");
	});

	it.each([
		["agents", CODEX_DISABLED_AGENTS_CONFIG, "agents.enabled=true"],
		["web search", CODEX_DISABLED_WEB_SEARCH_CONFIG, 'web_search="live"'],
	] as const)("rejects changed %s process configuration", (_name, current, replacement) => {
		expect(
			classifyAdmittedCodexProcessArguments(
				buildCodexAppServerArguments().map((value) => (value === current ? replacement : value)),
			),
		).toBeNull();
	});

	it("rejects a process command that restores a native shell surface", () => {
		const argv = buildCodexAppServerArguments();
		const shellTool = argv.indexOf("shell_tool");
		expect(shellTool).toBeGreaterThan(0);
		argv[shellTool - 1] = "--enable";

		expect(classifyAdmittedCodexProcessArguments(argv)).toBeNull();
	});
});
