/**
 * Pure logic for `agentrelay install`. Side-effecting orchestration (read,
 * prompt, write) lives in the bin script — every function here is a
 * deterministic pure mapping that the test suite drives directly.
 */

import { z } from "zod";

export const RECOMMENDED_PERMISSIONS = {
	allow: [
		"Read",
		"Grep",
		"Glob",
		"Bash(npm test*)",
		"Bash(pytest*)",
		"Bash(cargo test*)",
		"Bash(npm run lint*)",
		"Bash(tsc*)",
		"mcp__agentrelay__*",
	],
	ask: ["Edit", "Write", "Bash(git commit*)", "Bash(git diff*)"],
	deny: [
		"Bash(git push*)",
		"Bash(npm publish*)",
		"Bash(rm -rf*)",
		"Bash(curl*)",
		"Bash(wget*)",
		"Bash(eval*)",
		"Bash(*ssh*)",
		"Bash(*aws*)",
		"Bash(*kubectl*)",
	],
} as const;

// TODO(#5): switch to ["-y", "agentrelay-mcp", "mcp"] in v0.2.0; today the deprecated bin still works and changing this would re-trigger Claude Code's MCP trust prompt for every existing user.
export const RECOMMENDED_MCP_ENTRY = {
	command: "npx",
	args: ["-y", "agentrelay-mcp"],
	env: {} as Record<string, string>,
} as const;

/**
 * Same shape as RECOMMENDED_MCP_ENTRY but with the `type: "stdio"` discriminator
 * Claude Code's `claude mcp add` command writes into `~/.claude.json`. Including
 * `type` makes our entry indistinguishable from one Claude Code wrote itself,
 * which avoids the user being prompted to "trust" the server again.
 */
// TODO(#5): switch to ["-y", "agentrelay-mcp", "mcp"] in v0.2.0; today the deprecated bin still works and changing this would re-trigger Claude Code's MCP trust prompt for every existing user.
export const RECOMMENDED_CLAUDE_JSON_MCP_ENTRY = {
	type: "stdio",
	command: "npx",
	args: ["-y", "agentrelay-mcp"],
	env: {} as Record<string, string>,
} as const;

const settingsSchema = z
	.object({
		mcpServers: z.record(z.string(), z.unknown()).optional(),
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

export type ClaudeSettings = z.infer<typeof settingsSchema>;

export interface MergeReport {
	mcpServerAdded: boolean;
	mcpServerOverwritten: boolean;
	permissionsAdded: { allow: string[]; ask: string[]; deny: string[] };
	permissionsRemovedFromOtherBuckets: { allow: string[]; ask: string[]; deny: string[] };
}

export interface MergeOptions {
	overwriteMcp: boolean;
	overwritePermissions: boolean;
}

/**
 * Merge AgentRelay's recommended config into the user's existing Claude
 * Code settings.json structure. The `report` lets the caller render a diff
 * for the user before persisting. The function never mutates its inputs.
 *
 * Permissions merge rules:
 * - Recommended entries we don't already see anywhere → added to their bucket.
 * - Recommended entries we see in a different bucket → only moved when
 *   `overwritePermissions` is true (otherwise skipped, preserving user
 *   customisation). Either way we report the would-be change.
 * - Existing entries the user added that AgentRelay does not recommend → kept.
 */
export function mergeClaudeSettings(
	current: unknown,
	options: MergeOptions,
): { next: ClaudeSettings; report: MergeReport } {
	const parsed = current === undefined || current === null ? {} : settingsSchema.parse(current);

	const next: ClaudeSettings = JSON.parse(JSON.stringify(parsed));
	next.mcpServers = next.mcpServers ?? {};
	next.permissions = next.permissions ?? {};
	next.permissions.allow = next.permissions.allow ?? [];
	next.permissions.ask = next.permissions.ask ?? [];
	next.permissions.deny = next.permissions.deny ?? [];

	const report: MergeReport = {
		mcpServerAdded: false,
		mcpServerOverwritten: false,
		permissionsAdded: { allow: [], ask: [], deny: [] },
		permissionsRemovedFromOtherBuckets: { allow: [], ask: [], deny: [] },
	};

	const existingMcp = (next.mcpServers as Record<string, unknown>).agentrelay;
	if (existingMcp === undefined) {
		(next.mcpServers as Record<string, unknown>).agentrelay = { ...RECOMMENDED_MCP_ENTRY };
		report.mcpServerAdded = true;
	} else if (!deepEqual(existingMcp, RECOMMENDED_MCP_ENTRY) && options.overwriteMcp) {
		(next.mcpServers as Record<string, unknown>).agentrelay = { ...RECOMMENDED_MCP_ENTRY };
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
			} else {
				buckets[bucket].push(rule);
				report.permissionsAdded[bucket].push(rule);
			}
		}
	}

	return { next, report };
}

/**
 * Merge ONLY the `mcpServers.agentrelay` entry into a Claude `~/.claude.json`
 * shape. Used for the user-scope MCP registration (which lives in a different
 * file than the permission overlay — see paths.ts:mcpPath). Pure function,
 * never mutates inputs. Returns the merged object plus a small report.
 */
export function mergeClaudeJsonMcp(
	current: unknown,
	options: { overwriteMcp: boolean },
): { next: Record<string, unknown>; mcpServerAdded: boolean; mcpServerOverwritten: boolean } {
	const parsed: Record<string, unknown> =
		current === undefined || current === null
			? {}
			: (settingsSchema.passthrough().parse(current) as Record<string, unknown>);
	const next: Record<string, unknown> = JSON.parse(JSON.stringify(parsed));
	const servers = (next.mcpServers as Record<string, unknown> | undefined) ?? {};
	next.mcpServers = servers;

	const existing = servers.agentrelay;
	let mcpServerAdded = false;
	let mcpServerOverwritten = false;
	if (existing === undefined) {
		servers.agentrelay = { ...RECOMMENDED_CLAUDE_JSON_MCP_ENTRY };
		mcpServerAdded = true;
	} else if (!deepEqual(existing, RECOMMENDED_CLAUDE_JSON_MCP_ENTRY) && options.overwriteMcp) {
		servers.agentrelay = { ...RECOMMENDED_CLAUDE_JSON_MCP_ENTRY };
		mcpServerOverwritten = true;
	}
	return { next, mcpServerAdded, mcpServerOverwritten };
}

/**
 * Merge ONLY the recommended permission overlay into a Claude
 * `~/.claude/settings.json` shape. Used for the permission overlay
 * (which lives in a different file than the MCP registration). Pure
 * function, never mutates inputs.
 */
export function mergeClaudeOverlay(
	current: unknown,
	options: { overwritePermissions: boolean },
): {
	next: ClaudeSettings;
	permissionsAdded: { allow: string[]; ask: string[]; deny: string[] };
	permissionsRemovedFromOtherBuckets: { allow: string[]; ask: string[]; deny: string[] };
} {
	const parsed = current === undefined || current === null ? {} : settingsSchema.parse(current);
	const next: ClaudeSettings = JSON.parse(JSON.stringify(parsed));
	next.permissions = next.permissions ?? {};
	next.permissions.allow = next.permissions.allow ?? [];
	next.permissions.ask = next.permissions.ask ?? [];
	next.permissions.deny = next.permissions.deny ?? [];

	const permissionsAdded = { allow: [] as string[], ask: [] as string[], deny: [] as string[] };
	const permissionsRemovedFromOtherBuckets = {
		allow: [] as string[],
		ask: [] as string[],
		deny: [] as string[],
	};

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
					permissionsRemovedFromOtherBuckets[inOther].push(rule);
					permissionsAdded[bucket].push(rule);
				}
			} else {
				buckets[bucket].push(rule);
				permissionsAdded[bucket].push(rule);
			}
		}
	}

	return { next, permissionsAdded, permissionsRemovedFromOtherBuckets };
}

/**
 * Render a human-readable diff of a MergeReport. Used by the `install`
 * command to show changes before writing.
 */
export function renderMergeReport(report: MergeReport): string {
	const lines: string[] = [];
	if (report.mcpServerAdded) lines.push("+ mcpServers.agentrelay (added)");
	if (report.mcpServerOverwritten)
		lines.push("~ mcpServers.agentrelay (overwritten with recommended)");
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

function deepEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}
