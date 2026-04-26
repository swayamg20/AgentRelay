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

export const RECOMMENDED_MCP_ENTRY = {
	command: "npx",
	args: ["-y", "@agentrelay/mcp"],
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
 * Render a human-readable diff of a MergeReport. Used by the `install`
 * command to show changes before writing.
 */
export function renderMergeReport(report: MergeReport): string {
	const lines: string[] = [];
	if (report.mcpServerAdded) lines.push("+ mcpServers.agentrelay (added)");
	if (report.mcpServerOverwritten) lines.push("~ mcpServers.agentrelay (overwritten with recommended)");
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
