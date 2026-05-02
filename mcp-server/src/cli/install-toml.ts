/**
 * Pure TOML merger for Codex CLI's `~/.codex/config.toml`.
 *
 * Mirrors `install.ts` (the JSON merger for Claude Code) with the same
 * preserve-by-default semantics:
 *
 * - Adds `[mcp_servers.agentrelay]` if absent. Overwrites it only when
 *   `overwriteMcp` is set.
 * - Adds AgentRelay's recommended permission rules to `[permissions]`
 *   buckets (`allow`/`ask`/`deny`). Rules already present are kept.
 *   Rules placed in a different bucket by the user stay put unless
 *   `overwritePermissions` is true.
 * - Returns `{next, report}` plus the raw toml string. Caller decides
 *   whether to persist; we never write here.
 *
 * lld.md §5.2 commits to Codex on day-1 alongside Claude Code. The
 * permission syntax under `[permissions]` is documented as "equivalent",
 * which we render as the same allow/ask/deny lists Claude Code uses —
 * Codex's harness reads them in the same risk-tiered way.
 */

import { parse, stringify } from "smol-toml";
import { z } from "zod";
import { RECOMMENDED_MCP_ENTRY, RECOMMENDED_PERMISSIONS } from "./install.js";

const tomlSettingsSchema = z
	.object({
		mcp_servers: z.record(z.string(), z.unknown()).optional(),
		permissions: z
			.object({
				allow: z.array(z.string()).optional(),
				ask: z.array(z.string()).optional(),
				deny: z.array(z.string()).optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();

export type CodexSettings = z.infer<typeof tomlSettingsSchema>;

export interface TomlMergeReport {
	mcpServerAdded: boolean;
	mcpServerOverwritten: boolean;
	permissionsAdded: { allow: string[]; ask: string[]; deny: string[] };
	permissionsRemovedFromOtherBuckets: { allow: string[]; ask: string[]; deny: string[] };
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
	next.permissions = next.permissions ?? {};
	next.permissions.allow = next.permissions.allow ?? [];
	next.permissions.ask = next.permissions.ask ?? [];
	next.permissions.deny = next.permissions.deny ?? [];

	const report: TomlMergeReport = {
		mcpServerAdded: false,
		mcpServerOverwritten: false,
		permissionsAdded: { allow: [], ask: [], deny: [] },
		permissionsRemovedFromOtherBuckets: { allow: [], ask: [], deny: [] },
	};

	const mcpServers = next.mcp_servers as Record<string, unknown>;
	const codexMcpEntry = {
		// Codex's TOML schema uses `command` + `args`. The `env` key in the
		// JSON form is unsupported in the documented Codex shape (lld §5.2),
		// so we omit it here. If the user added other keys we leave them.
		command: RECOMMENDED_MCP_ENTRY.command,
		args: [...RECOMMENDED_MCP_ENTRY.args],
	};

	const existing = mcpServers.agentrelay;
	if (existing === undefined) {
		mcpServers.agentrelay = codexMcpEntry;
		report.mcpServerAdded = true;
	} else if (!entryMatchesRecommended(existing) && options.overwriteMcp) {
		mcpServers.agentrelay = codexMcpEntry;
		report.mcpServerOverwritten = true;
	}

	for (const bucket of ["allow", "ask", "deny"] as const) {
		const recommended = RECOMMENDED_PERMISSIONS[bucket];
		const buckets = next.permissions as Record<"allow" | "ask" | "deny", string[]>;
		for (const rule of recommended) {
			if (buckets[bucket].includes(rule)) continue;
			const otherBuckets = (["allow", "ask", "deny"] as const).filter((b) => b !== bucket);
			const inOther = otherBuckets.find((b) => buckets[b].includes(rule));
			if (inOther) {
				if (options.overwritePermissions) {
					buckets[inOther] = buckets[inOther].filter((r) => r !== rule);
					buckets[bucket].push(rule);
					report.permissionsRemovedFromOtherBuckets[inOther].push(rule);
					report.permissionsAdded[bucket].push(rule);
				}
				// Else: respect user choice silently (matches JSON path).
			} else {
				buckets[bucket].push(rule);
				report.permissionsAdded[bucket].push(rule);
			}
		}
	}

	const tomlText = stringifyOrdered(next);
	return { next, tomlText, report };
}

export function renderTomlMergeReport(report: TomlMergeReport): string {
	const lines: string[] = [];
	if (report.mcpServerAdded) lines.push("+ mcp_servers.agentrelay (added)");
	if (report.mcpServerOverwritten)
		lines.push("~ mcp_servers.agentrelay (overwritten with recommended)");
	for (const bucket of ["allow", "ask", "deny"] as const) {
		for (const rule of report.permissionsAdded[bucket]) {
			lines.push(`+ permissions.${bucket}: ${rule}`);
		}
		for (const rule of report.permissionsRemovedFromOtherBuckets[bucket]) {
			lines.push(`- permissions.${bucket}: ${rule} (moved to recommended bucket)`);
		}
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

/**
 * Stringify with deterministic top-level ordering. smol-toml preserves
 * insertion order; we control order by building the object explicitly.
 * Anything we don't know about (user-added top-level keys) is appended
 * at the end so we don't drop data.
 */
function stringifyOrdered(settings: CodexSettings): string {
	const known = new Set(["mcp_servers", "permissions"]);
	const ordered: Record<string, unknown> = {};
	if (settings.mcp_servers && Object.keys(settings.mcp_servers).length > 0) {
		ordered.mcp_servers = settings.mcp_servers;
	}
	if (settings.permissions && Object.keys(settings.permissions).length > 0) {
		ordered.permissions = settings.permissions;
	}
	for (const [k, v] of Object.entries(settings)) {
		if (!known.has(k)) ordered[k] = v;
	}
	return stringify(ordered);
}
