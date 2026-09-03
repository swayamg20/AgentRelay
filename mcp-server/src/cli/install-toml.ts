/**
 * Pure TOML merger for Codex CLI's `~/.codex/config.toml`.
 *
 * Uses Codex's native MCP approval settings with preserve-by-default
 * semantics:
 *
 * - Adds `[mcp_servers.agentrelay]` if absent. Overwrites it only when
 *   `overwriteMcp` is set.
 * - Defaults every AgentRelay tool to `prompt`.
 * - Allows teammate discovery without a prompt. Content-bearing mailbox reads
 *   and every mutation keep the prompt-by-default policy.
 * - Preserves unrelated user configuration, including any legacy top-level
 *   `[permissions]` table; Codex does not use that table for MCP approvals.
 * - Returns `{next, report}` plus the raw toml string. Caller decides
 *   whether to persist; we never write here.
 *
 * Current Codex config uses approval controls directly under the MCP server:
 * `default_tools_approval_mode` and `tools.<name>.approval_mode`.
 */

import { parse, stringify } from "smol-toml";
import { z } from "zod";
import { RECOMMENDED_MCP_ENTRY } from "./install.js";

export const CODEX_AUTO_APPROVED_AGENTRELAY_TOOLS = ["list_teammates"] as const;

export const CODEX_CONTENT_READ_AGENTRELAY_TOOLS = ["check_inbox", "view_thread"] as const;

export const CODEX_MUTATING_AGENTRELAY_TOOLS = [
	"handoff_to_teammate",
	"accept_handoff",
	"send_message",
	"complete_handoff",
] as const;

export const CODEX_PROMPTED_AGENTRELAY_TOOLS = [
	...CODEX_CONTENT_READ_AGENTRELAY_TOOLS,
	...CODEX_MUTATING_AGENTRELAY_TOOLS,
] as const;

export const CODEX_DEFAULT_AGENTRELAY_APPROVAL_MODE = "prompt" as const;

const tomlSettingsSchema = z
	.object({
		mcp_servers: z.record(z.string(), z.unknown()).optional(),
	})
	.passthrough();

export type CodexSettings = z.infer<typeof tomlSettingsSchema>;

export interface TomlMergeReport {
	mcpServerAdded: boolean;
	mcpServerOverwritten: boolean;
	approvalSettingsAdded: string[];
	approvalSettingsUpdated: string[];
}

export interface TomlMergeOptions {
	overwriteMcp: boolean;
	overwritePermissions: boolean;
}

export interface TomlMergeResult {
	next: CodexSettings;
	tomlText: string;
	report: TomlMergeReport;
}

/**
 * Parse a TOML string (or undefined for "no file") and merge in the
 * recommended Codex configuration. Pure; never touches disk.
 */
export function mergeCodexSettings(
	rawToml: string | undefined,
	options: TomlMergeOptions,
): TomlMergeResult {
	const parsed = rawToml === undefined || rawToml.length === 0 ? {} : parse(rawToml);
	const validated = tomlSettingsSchema.parse(parsed);
	const next: CodexSettings = JSON.parse(JSON.stringify(validated));

	next.mcp_servers = next.mcp_servers ?? {};

	const report: TomlMergeReport = {
		mcpServerAdded: false,
		mcpServerOverwritten: false,
		approvalSettingsAdded: [],
		approvalSettingsUpdated: [],
	};

	const mcpServers = next.mcp_servers as Record<string, unknown>;
	const existing = mcpServers.agentrelay;
	if (existing === undefined) {
		mcpServers.agentrelay = recommendedCodexMcpEntry();
		report.mcpServerAdded = true;
		report.approvalSettingsAdded.push(...recommendedApprovalPaths());
	} else if (!entryMatchesRecommended(existing) && options.overwriteMcp) {
		mcpServers.agentrelay = recommendedCodexMcpEntry();
		report.mcpServerOverwritten = true;
		report.approvalSettingsAdded.push(...recommendedApprovalPaths());
	} else if (entryMatchesRecommended(existing)) {
		mergeCodexApprovals(existing as Record<string, unknown>, options.overwritePermissions, report);
	}

	const tomlText = stringifyOrdered(next);
	return { next, tomlText, report };
}

export function renderTomlMergeReport(report: TomlMergeReport): string {
	const lines: string[] = [];
	if (report.mcpServerAdded) lines.push("+ mcp_servers.agentrelay (added)");
	if (report.mcpServerOverwritten)
		lines.push("~ mcp_servers.agentrelay (overwritten with recommended)");
	for (const setting of report.approvalSettingsAdded) {
		lines.push(`+ ${setting}`);
	}
	for (const setting of report.approvalSettingsUpdated) {
		lines.push(`~ ${setting}`);
	}
	return lines.length === 0 ? "(no changes — already in sync)" : lines.join("\n");
}

function entryMatchesRecommended(entry: unknown): boolean {
	if (!entry || typeof entry !== "object") return false;
	const e = entry as Record<string, unknown>;
	return (
		e.command === RECOMMENDED_MCP_ENTRY.command &&
		Array.isArray(e.args) &&
		e.args.length === RECOMMENDED_MCP_ENTRY.args.length &&
		e.args.every((v, i) => v === RECOMMENDED_MCP_ENTRY.args[i])
	);
}

function recommendedCodexMcpEntry(): Record<string, unknown> {
	return {
		// Codex's TOML schema uses `command` + `args`; the JSON-only `env`
		// value in RECOMMENDED_MCP_ENTRY is deliberately omitted here.
		command: RECOMMENDED_MCP_ENTRY.command,
		args: [...RECOMMENDED_MCP_ENTRY.args],
		default_tools_approval_mode: CODEX_DEFAULT_AGENTRELAY_APPROVAL_MODE,
		tools: Object.fromEntries(
			CODEX_AUTO_APPROVED_AGENTRELAY_TOOLS.map((tool) => [tool, { approval_mode: "auto" }]),
		),
	};
}

function recommendedApprovalPaths(): string[] {
	return [
		"mcp_servers.agentrelay.default_tools_approval_mode = prompt",
		...CODEX_AUTO_APPROVED_AGENTRELAY_TOOLS.map(
			(tool) => `mcp_servers.agentrelay.tools.${tool}.approval_mode = auto`,
		),
	];
}

function mergeCodexApprovals(
	entry: Record<string, unknown>,
	overwrite: boolean,
	report: TomlMergeReport,
): void {
	mergeApprovalValue(
		entry,
		"default_tools_approval_mode",
		CODEX_DEFAULT_AGENTRELAY_APPROVAL_MODE,
		"mcp_servers.agentrelay.default_tools_approval_mode = prompt",
		overwrite,
		report,
	);

	let tools = asRecord(entry.tools);
	if (!tools) {
		if (entry.tools !== undefined && !overwrite) return;
		tools = {};
		entry.tools = tools;
	}
	for (const tool of CODEX_AUTO_APPROVED_AGENTRELAY_TOOLS) {
		let toolConfig = asRecord(tools[tool]);
		if (!toolConfig) {
			if (tools[tool] !== undefined && !overwrite) continue;
			toolConfig = {};
			tools[tool] = toolConfig;
		}
		mergeApprovalValue(
			toolConfig,
			"approval_mode",
			"auto",
			`mcp_servers.agentrelay.tools.${tool}.approval_mode = auto`,
			overwrite,
			report,
		);
	}
	if (!overwrite) return;
	for (const tool of CODEX_PROMPTED_AGENTRELAY_TOOLS) {
		const current = tools[tool];
		if (current === undefined) continue;
		let toolConfig = asRecord(current);
		if (!toolConfig) {
			toolConfig = { approval_mode: "prompt" };
			tools[tool] = toolConfig;
			report.approvalSettingsUpdated.push(
				`mcp_servers.agentrelay.tools.${tool}.approval_mode = prompt`,
			);
			continue;
		}
		if (toolConfig.approval_mode === undefined) continue;
		mergeApprovalValue(
			toolConfig,
			"approval_mode",
			"prompt",
			`mcp_servers.agentrelay.tools.${tool}.approval_mode = prompt`,
			true,
			report,
		);
	}
}

function mergeApprovalValue(
	container: Record<string, unknown>,
	key: string,
	value: string,
	path: string,
	overwrite: boolean,
	report: TomlMergeReport,
): void {
	if (container[key] === value) return;
	if (container[key] === undefined) {
		container[key] = value;
		report.approvalSettingsAdded.push(path);
		return;
	}
	if (overwrite) {
		container[key] = value;
		report.approvalSettingsUpdated.push(path);
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/**
 * Stringify with deterministic top-level ordering. smol-toml preserves
 * insertion order; we control order by building the object explicitly.
 * Anything we don't know about (user-added top-level keys) is appended
 * at the end so we don't drop data.
 */
function stringifyOrdered(settings: CodexSettings): string {
	const known = new Set(["mcp_servers"]);
	const ordered: Record<string, unknown> = {};
	if (settings.mcp_servers && Object.keys(settings.mcp_servers).length > 0) {
		ordered.mcp_servers = settings.mcp_servers;
	}
	for (const [k, v] of Object.entries(settings)) {
		if (!known.has(k)) ordered[k] = v;
	}
	return stringify(ordered);
}
