import { describe, expect, it } from "vitest";
import {
	CODEX_PROBE_CONFIG,
	answerCodexProbeTool,
	assertNoActiveMcpServers,
} from "./codex-probe-policy.js";
import { ProbeSession } from "./probe-session.js";

function fixture() {
	const session = new ProbeSession({
		turns: 1,
		expiresAt: Number.MAX_SAFE_INTEGER,
		onEvent: () => {},
	});
	const reference = session.nextReference()!;
	const host = { threadId: "local-thread", turnId: "local-turn" };
	const call = { ...host, callId: "call-1", tool: "receive_live_turn", arguments: reference };
	return { session, host, call };
}

describe("Codex host probe boundary", () => {
	it("accepts disabled integrations but refuses active, unknown or paginated inventory", () => {
		const server = { runtimeStatus: "disabled", tools: {}, resources: [], resourceTemplates: [] };
		expect(() => assertNoActiveMcpServers({ data: [server], nextCursor: null })).not.toThrow();
		for (const state of ["connected", "starting", null]) {
			expect(() =>
				assertNoActiveMcpServers({ data: [{ ...server, runtimeStatus: state }], nextCursor: null }),
			).toThrow();
		}
		expect(() => assertNoActiveMcpServers({ data: [], nextCursor: "more" })).toThrow();
		expect(() =>
			assertNoActiveMcpServers({
				data: [{ ...server, tools: { unexpected: {} } }],
				nextCursor: null,
			}),
		).toThrow();
	});
	it("returns provenance-marked data only to its exact host thread and turn", () => {
		const { session, host, call } = fixture();
		const result = answerCodexProbeTool(call, host, session);
		expect(result.success).toBe(true);
		const value = JSON.parse(result.contentItems[0]!.text);
		expect(value.peer_data.agentrelay_provenance.trust).toBe("untrusted");
		for (const field of ["threadId", "turnId"]) {
			expect(() => answerCodexProbeTool({ ...call, [field]: "other" }, host, session)).toThrow();
		}
	});

	it("rejects non-fixture tools, namespaces and peer-supplied local authority", () => {
		const { session, host, call } = fixture();
		for (const change of [
			{ tool: "exec_command" },
			{ namespace: "another-server" },
			{ arguments: { ...call.arguments, cwd: "/tmp" } },
		]) {
			expect(() => answerCodexProbeTool({ ...call, ...change }, host, session)).toThrow();
		}
	});

	it("does not enable host effects or change owner configuration", () => {
		expect(CODEX_PROBE_CONFIG["features.shell_tool"]).toBe(false);
		expect(CODEX_PROBE_CONFIG["features.hooks"]).toBe(false);
		expect(CODEX_PROBE_CONFIG["features.plugins"]).toBe(false);
		expect(CODEX_PROBE_CONFIG.sandbox_mode).toBe("read-only");
		expect(CODEX_PROBE_CONFIG.approval_policy).toBe("never");
	});
});
