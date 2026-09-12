import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { codexChildEnvironment } from "./codex-policy.js";
import { LiveCodexTurn } from "./codex-tools.js";

function fixture() {
	const messageId = randomUUID();
	const turn = new LiveCodexTurn({ messageId, content: "provenance-marked data" }, "thread");
	turn.turnId = "turn";
	const call = {
		threadId: "thread",
		turnId: "turn",
		callId: "call",
		tool: "receive_live_message",
		arguments: { message_id: messageId },
	};
	return { turn, call };
}
describe("communication-only Codex tools", () => {
	it("requires receive, exact scope, one stable reply and a completed host turn", () => {
		const { turn, call } = fixture();
		const reply = {
			...call,
			tool: "reply_live_message",
			arguments: { ...call.arguments, body: "hello" },
		};
		expect(() => turn.answer(reply)).toThrow();
		expect(turn.answer(call).contentItems[0]?.text).toBe("provenance-marked data");
		expect(turn.answer(reply).success).toBe(true);
		expect(turn.answer(reply).success).toBe(true);
		expect(() =>
			turn.answer({ ...reply, arguments: { ...reply.arguments, body: "changed" } }),
		).toThrow();
		expect(() => turn.completed("interrupted")).toThrow();
		expect(turn.completed("completed").reply).toBe("hello");
	});
	it("denies other tools, messages, namespaces, local paths and peer overrides", () => {
		const { turn, call } = fixture();
		for (const patch of [
			{ threadId: "another" },
			{ turnId: "another" },
			{ tool: "exec_command" },
			{ namespace: "agentrelay" },
			{ arguments: { message_id: randomUUID() } },
			{ arguments: { ...call.arguments, cwd: "/tmp" } },
			{ arguments: { ...call.arguments, peer: "mallory" } },
		])
			expect(() => turn.answer({ ...call, ...patch })).toThrow();
	});
	it("allows a no-reply decision but not an empty or oversized answer", () => {
		const { turn, call } = fixture();
		turn.answer(call);
		for (const body of ["", " ", "x".repeat(4_001)]) {
			expect(() =>
				turn.answer({
					...call,
					tool: "reply_live_message",
					arguments: { ...call.arguments, body },
				}),
			).toThrow();
		}
		turn.answer({
			...call,
			tool: "reply_live_message",
			arguments: { ...call.arguments, body: null },
		});
		expect(turn.completed("completed").reply).toBeNull();
	});
	it("does not pass Relay credentials or process-loader injection into the host", () => {
		expect(
			codexChildEnvironment({
				PATH: "/bin",
				HOME: "/owner",
				OPENAI_API_KEY: "provider-auth",
				AGENTRELAY_ADMIN_TOKEN: "secret",
				NODE_OPTIONS: "--import bad",
				HTTP_PROXY: "bad",
				CODEX_THREAD_ID: "unrelated",
			}),
		).toEqual({ PATH: "/bin", HOME: "/owner", OPENAI_API_KEY: "provider-auth" });
	});
});
