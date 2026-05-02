import { describe, expect, it } from "vitest";
import {
	RECOMMENDED_MCP_ENTRY,
	RECOMMENDED_PERMISSIONS,
	mergeClaudeSettings,
	renderMergeReport,
} from "./install.js";

describe("mergeClaudeSettings", () => {
	it("adds the MCP entry to an empty file", () => {
		const { next, report } = mergeClaudeSettings(
			{},
			{ overwriteMcp: true, overwritePermissions: true },
		);
		expect(report.mcpServerAdded).toBe(true);
		expect(next.mcpServers?.agentrelay).toEqual(RECOMMENDED_MCP_ENTRY);
	});

	it("adds every recommended permission to a fresh file", () => {
		const { next, report } = mergeClaudeSettings(
			{},
			{ overwriteMcp: true, overwritePermissions: true },
		);
		expect(report.permissionsAdded.allow).toEqual([...RECOMMENDED_PERMISSIONS.allow]);
		expect(next.permissions?.deny).toEqual([...RECOMMENDED_PERMISSIONS.deny]);
	});

	it("preserves the user's existing permission entries", () => {
		const current = {
			permissions: {
				allow: ["Bash(my-custom-tool*)"],
				ask: [],
				deny: [],
			},
		};
		const { next } = mergeClaudeSettings(current, {
			overwriteMcp: true,
			overwritePermissions: true,
		});
		expect(next.permissions?.allow).toContain("Bash(my-custom-tool*)");
		expect(next.permissions?.allow).toContain("Read");
	});

	it("does not overwrite an existing different MCP entry without overwrite flag", () => {
		const current = {
			mcpServers: { agentrelay: { command: "node", args: ["custom.js"] } },
		};
		const { next, report } = mergeClaudeSettings(current, {
			overwriteMcp: false,
			overwritePermissions: false,
		});
		expect(report.mcpServerOverwritten).toBe(false);
		expect((next.mcpServers as any).agentrelay.command).toBe("node");
	});

	it("does overwrite when overwriteMcp=true", () => {
		const current = {
			mcpServers: { agentrelay: { command: "node", args: ["custom.js"] } },
		};
		const { next, report } = mergeClaudeSettings(current, {
			overwriteMcp: true,
			overwritePermissions: true,
		});
		expect(report.mcpServerOverwritten).toBe(true);
		expect((next.mcpServers as any).agentrelay).toEqual(RECOMMENDED_MCP_ENTRY);
	});

	it("respects user customisation: rule already in another bucket stays put", () => {
		// User put "Edit" in deny — they're stricter than us. Don't move it.
		const current = {
			permissions: { allow: [], ask: [], deny: ["Edit"] },
		};
		const { next, report } = mergeClaudeSettings(current, {
			overwriteMcp: false,
			overwritePermissions: false,
		});
		expect(next.permissions?.deny).toContain("Edit");
		expect(next.permissions?.ask).not.toContain("Edit");
		expect(report.permissionsAdded.ask).not.toContain("Edit");
	});

	it("moves a misplaced rule when overwritePermissions=true", () => {
		const current = {
			permissions: { allow: [], ask: [], deny: ["Edit"] },
		};
		const { next, report } = mergeClaudeSettings(current, {
			overwriteMcp: false,
			overwritePermissions: true,
		});
		expect(next.permissions?.deny).not.toContain("Edit");
		expect(next.permissions?.ask).toContain("Edit");
		expect(report.permissionsRemovedFromOtherBuckets.deny).toContain("Edit");
		expect(report.permissionsAdded.ask).toContain("Edit");
	});

	it("renderMergeReport produces a stable diff", () => {
		const { report } = mergeClaudeSettings({}, { overwriteMcp: true, overwritePermissions: true });
		const txt = renderMergeReport(report);
		expect(txt).toContain("+ mcpServers.agentrelay");
		expect(txt).toContain("+ permissions.allow: Read");
	});

	it("renderMergeReport reports no-op", () => {
		const current = {
			mcpServers: { agentrelay: { ...RECOMMENDED_MCP_ENTRY } },
			permissions: {
				allow: [...RECOMMENDED_PERMISSIONS.allow],
				ask: [...RECOMMENDED_PERMISSIONS.ask],
				deny: [...RECOMMENDED_PERMISSIONS.deny],
			},
		};
		const { report } = mergeClaudeSettings(current, {
			overwriteMcp: true,
			overwritePermissions: true,
		});
		expect(renderMergeReport(report)).toBe("(no changes — already in sync)");
	});
});
