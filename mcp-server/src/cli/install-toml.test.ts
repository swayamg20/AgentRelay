import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { RECOMMENDED_PERMISSIONS } from "./install.js";
import { mergeCodexSettings, renderTomlMergeReport } from "./install-toml.js";

describe("mergeCodexSettings", () => {
	it("adds the [mcp_servers.agentrelay] block to an empty file", () => {
		const { tomlText, report, next } = mergeCodexSettings(undefined, {
			overwriteMcp: true,
			overwritePermissions: true,
		});
		expect(report.mcpServerAdded).toBe(true);
		expect((next.mcp_servers as Record<string, unknown>).agentrelay).toEqual({
			command: "npx",
			args: ["-y", "@agentrelay/mcp"],
		});
		const round = parse(tomlText) as Record<string, any>;
		expect(round.mcp_servers.agentrelay.command).toBe("npx");
		expect(round.mcp_servers.agentrelay.args).toEqual(["-y", "@agentrelay/mcp"]);
	});

	it("adds every recommended permission to a fresh file", () => {
		const { next, report, tomlText } = mergeCodexSettings(undefined, {
			overwriteMcp: true,
			overwritePermissions: true,
		});
		expect(report.permissionsAdded.allow).toEqual([...RECOMMENDED_PERMISSIONS.allow]);
		expect(next.permissions?.deny).toEqual([...RECOMMENDED_PERMISSIONS.deny]);
		// Round-trips cleanly through the parser.
		const round = parse(tomlText) as Record<string, any>;
		expect(round.permissions.allow).toContain("mcp__agentrelay__*");
		expect(round.permissions.deny).toContain("Bash(git push*)");
	});

	it("preserves user-added permission entries", () => {
		const input = `[permissions]
allow = ["Bash(my-custom-tool*)"]
ask = []
deny = []
`;
		const { next } = mergeCodexSettings(input, {
			overwriteMcp: true,
			overwritePermissions: true,
		});
		expect(next.permissions?.allow).toContain("Bash(my-custom-tool*)");
		expect(next.permissions?.allow).toContain("Read");
	});

	it("respects user customisation: rule placed in stricter bucket stays put", () => {
		const input = `[permissions]
deny = ["Edit"]
`;
		const { next, report } = mergeCodexSettings(input, {
			overwriteMcp: false,
			overwritePermissions: false,
		});
		expect(next.permissions?.deny).toContain("Edit");
		expect(next.permissions?.ask ?? []).not.toContain("Edit");
		expect(report.permissionsAdded.ask).not.toContain("Edit");
	});

	it("moves a misplaced rule when overwritePermissions=true", () => {
		const input = `[permissions]
deny = ["Edit"]
`;
		const { next, report } = mergeCodexSettings(input, {
			overwriteMcp: false,
			overwritePermissions: true,
		});
		expect(next.permissions?.deny).not.toContain("Edit");
		expect(next.permissions?.ask).toContain("Edit");
		expect(report.permissionsRemovedFromOtherBuckets.deny).toContain("Edit");
		expect(report.permissionsAdded.ask).toContain("Edit");
	});

	it("does not overwrite a different MCP entry without the flag", () => {
		const input = `[mcp_servers.agentrelay]
command = "node"
args = ["custom.js"]
`;
		const { next, report } = mergeCodexSettings(input, {
			overwriteMcp: false,
			overwritePermissions: false,
		});
		expect(report.mcpServerOverwritten).toBe(false);
		expect((next.mcp_servers as any).agentrelay.command).toBe("node");
	});

	it("overwrites when overwriteMcp=true", () => {
		const input = `[mcp_servers.agentrelay]
command = "node"
args = ["custom.js"]
`;
		const { next, report } = mergeCodexSettings(input, {
			overwriteMcp: true,
			overwritePermissions: false,
		});
		expect(report.mcpServerOverwritten).toBe(true);
		expect((next.mcp_servers as any).agentrelay).toEqual({
			command: "npx",
			args: ["-y", "@agentrelay/mcp"],
		});
	});

	it("reports no-op when settings already in sync", () => {
		const synced = `[mcp_servers.agentrelay]
command = "npx"
args = ["-y", "@agentrelay/mcp"]

[permissions]
allow = ${arrToToml([...RECOMMENDED_PERMISSIONS.allow])}
ask = ${arrToToml([...RECOMMENDED_PERMISSIONS.ask])}
deny = ${arrToToml([...RECOMMENDED_PERMISSIONS.deny])}
`;
		const { report } = mergeCodexSettings(synced, {
			overwriteMcp: true,
			overwritePermissions: true,
		});
		expect(report.mcpServerAdded).toBe(false);
		expect(report.mcpServerOverwritten).toBe(false);
		expect(Object.values(report.permissionsAdded).flat()).toEqual([]);
		expect(renderTomlMergeReport(report)).toBe("(no changes — already in sync)");
	});

	it("preserves unknown top-level keys (round-trips them)", () => {
		const input = `[other_tool]
key = "value"
`;
		const { tomlText } = mergeCodexSettings(input, {
			overwriteMcp: true,
			overwritePermissions: true,
		});
		const round = parse(tomlText) as Record<string, any>;
		expect(round.other_tool.key).toBe("value");
		expect(round.mcp_servers.agentrelay).toBeDefined();
	});

	it("renders a stable diff", () => {
		const { report } = mergeCodexSettings(undefined, {
			overwriteMcp: true,
			overwritePermissions: true,
		});
		const txt = renderTomlMergeReport(report);
		expect(txt).toContain("+ mcp_servers.agentrelay");
		expect(txt).toContain("+ permissions.allow: Read");
	});
});

function arrToToml(values: string[]): string {
	return `[${values.map((v) => JSON.stringify(v)).join(", ")}]`;
}
