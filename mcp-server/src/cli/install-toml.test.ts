import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
	CODEX_AUTO_APPROVED_AGENTRELAY_TOOLS,
	CODEX_MUTATING_AGENTRELAY_TOOLS,
	mergeCodexSettings,
	renderTomlMergeReport,
} from "./install-toml.js";

describe("mergeCodexSettings", () => {
	it("installs AgentRelay with prompt-by-default native MCP approvals", () => {
		const { tomlText, report, next } = mergeCodexSettings(undefined, {
			overwriteMcp: true,
			overwritePermissions: true,
		});
		expect(report.mcpServerAdded).toBe(true);
		expect((next.mcp_servers as Record<string, any>).agentrelay).toMatchObject({
			command: "npx",
			args: ["-y", "agentrelay-mcp"],
			default_tools_approval_mode: "prompt",
		});

		const round = parse(tomlText) as Record<string, any>;
		const entry = round.mcp_servers.agentrelay;
		expect(entry.default_tools_approval_mode).toBe("prompt");
		for (const tool of CODEX_AUTO_APPROVED_AGENTRELAY_TOOLS) {
			expect(entry.tools[tool].approval_mode).toBe("auto");
		}
		for (const tool of CODEX_MUTATING_AGENTRELAY_TOOLS) {
			expect(entry.tools[tool]).toBeUndefined();
		}
		expect(round.permissions).toBeUndefined();
	});

	it("adds missing native approvals to an existing matching MCP entry", () => {
		const input = `[mcp_servers.agentrelay]
command = "npx"
args = ["-y", "agentrelay-mcp"]
`;
		const { next, report } = mergeCodexSettings(input, {
			overwriteMcp: false,
			overwritePermissions: false,
		});
		const entry = (next.mcp_servers as Record<string, any>).agentrelay;
		expect(entry.default_tools_approval_mode).toBe("prompt");
		expect(entry.tools.view_thread.approval_mode).toBe("auto");
		expect(report.approvalSettingsAdded).toHaveLength(4);
	});

	it("preserves an explicit stricter tool approval without overwrite", () => {
		const input = `[mcp_servers.agentrelay]
command = "npx"
args = ["-y", "agentrelay-mcp"]
default_tools_approval_mode = "prompt"

[mcp_servers.agentrelay.tools.view_thread]
approval_mode = "prompt"
`;
		const { next, report } = mergeCodexSettings(input, {
			overwriteMcp: false,
			overwritePermissions: false,
		});
		const entry = (next.mcp_servers as Record<string, any>).agentrelay;
		expect(entry.tools.view_thread.approval_mode).toBe("prompt");
		expect(report.approvalSettingsUpdated).toEqual([]);
	});

	it("updates an explicit tool approval when overwrite is requested", () => {
		const input = `[mcp_servers.agentrelay]
command = "npx"
args = ["-y", "agentrelay-mcp"]
default_tools_approval_mode = "auto"

[mcp_servers.agentrelay.tools.view_thread]
approval_mode = "prompt"

[mcp_servers.agentrelay.tools.send_message]
approval_mode = "auto"
`;
		const { next, report } = mergeCodexSettings(input, {
			overwriteMcp: false,
			overwritePermissions: true,
		});
		const entry = (next.mcp_servers as Record<string, any>).agentrelay;
		expect(entry.default_tools_approval_mode).toBe("prompt");
		expect(entry.tools.view_thread.approval_mode).toBe("auto");
		expect(entry.tools.send_message.approval_mode).toBe("prompt");
		expect(report.approvalSettingsUpdated).toHaveLength(3);
	});

	it("preserves a legacy top-level permissions table as unrelated config", () => {
		const input = `[permissions]
allow = ["mcp__agentrelay__*", "Bash(my-custom-tool*)"]
`;
		const { tomlText } = mergeCodexSettings(input, {
			overwriteMcp: true,
			overwritePermissions: true,
		});
		const round = parse(tomlText) as Record<string, any>;
		expect(round.permissions.allow).toEqual(["mcp__agentrelay__*", "Bash(my-custom-tool*)"]);
		expect(round.mcp_servers.agentrelay.default_tools_approval_mode).toBe("prompt");
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
		expect((next.mcp_servers as Record<string, any>).agentrelay.command).toBe("node");
		expect(report.approvalSettingsAdded).toEqual([]);
	});

	it("overwrites a different MCP entry with the safe defaults when requested", () => {
		const input = `[mcp_servers.agentrelay]
command = "node"
args = ["custom.js"]
`;
		const { next, report } = mergeCodexSettings(input, {
			overwriteMcp: true,
			overwritePermissions: false,
		});
		expect(report.mcpServerOverwritten).toBe(true);
		expect((next.mcp_servers as Record<string, any>).agentrelay).toMatchObject({
			command: "npx",
			args: ["-y", "agentrelay-mcp"],
			default_tools_approval_mode: "prompt",
		});
	});

	it("reports no-op when native approvals are already in sync", () => {
		const first = mergeCodexSettings(undefined, {
			overwriteMcp: true,
			overwritePermissions: true,
		});
		const { report } = mergeCodexSettings(first.tomlText, {
			overwriteMcp: true,
			overwritePermissions: true,
		});
		expect(report.mcpServerAdded).toBe(false);
		expect(report.mcpServerOverwritten).toBe(false);
		expect(report.approvalSettingsAdded).toEqual([]);
		expect(report.approvalSettingsUpdated).toEqual([]);
		expect(renderTomlMergeReport(report)).toBe("(no changes — already in sync)");
	});

	it("preserves unknown top-level and MCP entry keys", () => {
		const input = `model = "custom"

[mcp_servers.agentrelay]
command = "npx"
args = ["-y", "agentrelay-mcp"]
startup_timeout_sec = 7
`;
		const { tomlText } = mergeCodexSettings(input, {
			overwriteMcp: false,
			overwritePermissions: false,
		});
		const round = parse(tomlText) as Record<string, any>;
		expect(round.model).toBe("custom");
		expect(round.mcp_servers.agentrelay.startup_timeout_sec).toBe(7);
	});

	it("renders native approval changes", () => {
		const { report } = mergeCodexSettings(undefined, {
			overwriteMcp: true,
			overwritePermissions: true,
		});
		const txt = renderTomlMergeReport(report);
		expect(txt).toContain("+ mcp_servers.agentrelay");
		expect(txt).toContain("default_tools_approval_mode = prompt");
		expect(txt).toContain("tools.view_thread.approval_mode = auto");
	});
});
