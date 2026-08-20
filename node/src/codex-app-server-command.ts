import { isAbsolute, normalize } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	CODEX_PROVIDER_BASE_URL_CONFIG,
	CODEX_PROVIDER_CONFIG,
} from "./codex-provider-egress-policy.js";

export const DISABLED_CODEX_FEATURES = [
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

export const CODEX_EPHEMERAL_AUTH_CONFIG = 'cli_auth_credentials_store="ephemeral"';
export const CODEX_DISABLED_AGENTS_CONFIG = "agents.enabled=false";
export const CODEX_DISABLED_WEB_SEARCH_CONFIG = 'web_search="disabled"';

export function codexUntrustedProjectConfig(workspaceCwd: string): string {
	assertCanonicalWorkspace(workspaceCwd);
	return `projects={${JSON.stringify(workspaceCwd)}={trust_level="untrusted"}}`;
}

export function buildCodexAppServerArguments(workspaceCwd: string): string[] {
	return [
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
		"--config",
		codexUntrustedProjectConfig(workspaceCwd),
		...DISABLED_CODEX_FEATURES.flatMap((feature) => ["--disable", feature]),
		"app-server",
		"--listen",
		"stdio://",
	];
}

export type AdmittedCodexProcessKind = "version_probe" | "app_server";

export function classifyAdmittedCodexProcessArguments(
	argv: readonly string[],
	workspaceCwd: string,
): AdmittedCodexProcessKind | null {
	if (isDeepStrictEqual(argv, ["--version"])) return "version_probe";
	if (isDeepStrictEqual(argv, buildCodexAppServerArguments(workspaceCwd))) return "app_server";
	return null;
}

export function isAdmittedCodexProcessArguments(
	argv: readonly string[],
	workspaceCwd: string,
): boolean {
	return classifyAdmittedCodexProcessArguments(argv, workspaceCwd) !== null;
}

function assertCanonicalWorkspace(workspaceCwd: string): void {
	if (
		!isAbsolute(workspaceCwd) ||
		normalize(workspaceCwd) !== workspaceCwd ||
		workspaceCwd.includes("\0")
	) {
		throw new Error("Codex workspace must be an absolute normalized path without NUL");
	}
}
