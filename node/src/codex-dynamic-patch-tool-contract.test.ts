import { describe, expect, it } from "vitest";
import {
	CODEX_DYNAMIC_PATCH_TOOL_CONTRACT,
	CODEX_DYNAMIC_PATCH_TOOL_NAME,
	CODEX_DYNAMIC_TOOL_NAMESPACE,
	codexDynamicPatchToolResponse,
	codexDynamicPatchTools,
	parseCodexDynamicPatchToolCallParams,
	parseCodexDynamicPatchToolOutcome,
} from "./codex-dynamic-patch-tool-contract.js";
import { CODEX_PATCH_MAX_BYTES } from "./codex-workspace-patch-contract.js";

describe("Codex dynamic patch tool contract", () => {
	it("publishes one fixed, eagerly loaded AgentRelay namespace tool", () => {
		expect(CODEX_DYNAMIC_PATCH_TOOL_CONTRACT).toBe("agentrelay.apply_patch/v1");
		expect(codexDynamicPatchTools()).toEqual([
			{
				type: "namespace",
				name: CODEX_DYNAMIC_TOOL_NAMESPACE,
				description: "AgentRelay-authorized workspace operations",
				tools: [
					{
						type: "function",
						name: CODEX_DYNAMIC_PATCH_TOOL_NAME,
						description: "Apply one bounded patch through AgentRelay",
						inputSchema: {
							type: "object",
							properties: { patch: { type: "string" } },
							required: ["patch"],
							additionalProperties: false,
						},
						deferLoading: false,
					},
				],
			},
		]);

		const first = codexDynamicPatchTools();
		(first[0].tools[0].inputSchema.properties.patch as { type: string }).type = "number";
		expect(codexDynamicPatchTools()[0].tools[0].inputSchema.properties.patch.type).toBe("string");
	});

	it("decodes only the exact namespaced call and patch argument", () => {
		expect(parseCodexDynamicPatchToolCallParams(exactCall())).toEqual({
			threadId: "thread-1",
			turnId: "turn-1",
			callId: "call-1",
			patch: "diff --git a/a b/a\n",
		});
	});

	it.each([
		["null namespace", { namespace: null }],
		["wrong namespace", { namespace: "peer" }],
		["wrong tool", { tool: "shell" }],
		["extra request field", { extra: true }],
		["extra argument", { arguments: { patch: "x", path: "a" } }],
		["oversized provider reference", { callId: "x".repeat(513) }],
		["control-bearing provider reference", { turnId: "turn\u0000-1" }],
	] as const)("rejects a %s", (_name, override) => {
		expect(() => parseCodexDynamicPatchToolCallParams({ ...exactCall(), ...override })).toThrow();
	});

	it("enforces the decoded UTF-8 byte bound and rejects unpaired surrogates", () => {
		expect(() =>
			parseCodexDynamicPatchToolCallParams({
				...exactCall(),
				arguments: { patch: "¢".repeat(CODEX_PATCH_MAX_BYTES / 2) },
			}),
		).not.toThrow();
		expect(() =>
			parseCodexDynamicPatchToolCallParams({
				...exactCall(),
				arguments: { patch: `¢${"¢".repeat(CODEX_PATCH_MAX_BYTES / 2)}` },
			}),
		).toThrow();
		expect(() =>
			parseCodexDynamicPatchToolCallParams({
				...exactCall(),
				arguments: { patch: "\ud800" },
			}),
		).toThrow();
	});

	it("returns only fixed redacted outcome payloads", () => {
		expect(codexDynamicPatchToolResponse(parseCodexDynamicPatchToolOutcome("applied"))).toEqual({
			contentItems: [{ type: "inputText", text: "AgentRelay applied the patch." }],
			success: true,
		});
		expect(codexDynamicPatchToolResponse(parseCodexDynamicPatchToolOutcome("rejected"))).toEqual({
			contentItems: [{ type: "inputText", text: "AgentRelay did not apply the patch." }],
			success: false,
		});
		expect(
			codexDynamicPatchToolResponse(parseCodexDynamicPatchToolOutcome("fatal_rejected")),
		).toEqual({
			contentItems: [{ type: "inputText", text: "AgentRelay did not apply the patch." }],
			success: false,
		});
		expect(() => parseCodexDynamicPatchToolOutcome({ success: true })).toThrow();
	});
});

function exactCall(): Record<string, unknown> {
	return {
		threadId: "thread-1",
		turnId: "turn-1",
		callId: "call-1",
		namespace: CODEX_DYNAMIC_TOOL_NAMESPACE,
		tool: CODEX_DYNAMIC_PATCH_TOOL_NAME,
		arguments: { patch: "diff --git a/a b/a\n" },
	};
}
