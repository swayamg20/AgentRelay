import { describe, expect, it } from "vitest";
import { CLI_MISUSE_HINT, CLI_VERBS, isCliMisuse } from "./argv-guard.js";

describe("agentrelay-mcp argv guard", () => {
	it("flags every known CLI verb as misuse", () => {
		for (const verb of CLI_VERBS) {
			expect(isCliMisuse(verb), `expected ${verb} to be flagged`).toBe(true);
		}
	});

	it.each([
		"register",
		"install",
		"doctor",
		"audit",
		"block",
		"unblock",
		"trust",
		"rotate-key",
		"version",
		"--help",
		"-h",
	])("flags %s", (verb) => {
		expect(isCliMisuse(verb)).toBe(true);
	});

	it("does not flag undefined (no-args invocation = legitimate stdio server start)", () => {
		expect(isCliMisuse(undefined)).toBe(false);
	});

	it("does not flag unrelated tokens", () => {
		expect(isCliMisuse("")).toBe(false);
		expect(isCliMisuse("anything")).toBe(false);
		expect(isCliMisuse("--unknown")).toBe(false);
		expect(isCliMisuse("Register")).toBe(false); // case-sensitive match by design
	});

	it("hint mentions the alternate bin and the CLI invocation form", () => {
		expect(CLI_MISUSE_HINT).toContain("agentrelay-mcp is the MCP server (stdio)");
		expect(CLI_MISUSE_HINT).toContain("npx -y -p agentrelay-mcp agentrelay");
		expect(CLI_MISUSE_HINT).toContain("agentrelay --help");
	});
});
