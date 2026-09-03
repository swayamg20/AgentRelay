import { describe, expect, it, vi } from "vitest";
import { buildCodexAttentionPrompt, createCodexAttentionAdapter } from "./codex.js";

const CODEX_THREAD = "01a02abd-9e1f-7991-9ec4-90fae3feb05b";
const MAIL_THREAD = "019fb4b5-5d71-72c2-b7ed-9d56847a32e6";
const EVENT = "b8bf5f45-7138-4ea1-89d9-7fa396cb785b";

describe("Codex attention adapter", () => {
	it("queues a fixed content-free prompt with execFile-shaped arguments", async () => {
		const runFile = vi.fn(async () => ({ stdout: "queued\n", stderr: "" }));
		const adapter = createCodexAttentionAdapter({ threadId: CODEX_THREAD, runFile });
		const receipt = await adapter.enqueueAttention({
			eventId: EVENT,
			threadId: MAIL_THREAD,
		});

		expect(runFile).toHaveBeenCalledOnce();
		const [file, args] = runFile.mock.calls[0] ?? [];
		expect(file).toBe("codex");
		expect(args?.slice(0, 4)).toEqual(["queue", "--thread", CODEX_THREAD, "--message"]);
		const prompt = args?.[4] ?? "";
		expect(prompt).not.toContain(EVENT);
		expect(prompt).not.toContain(MAIL_THREAD);
		expect(prompt).toContain("manual inspection");
		expect(prompt).toContain("Do not call tools");
		expect(prompt).not.toContain("view_thread");
		expect(prompt).not.toContain("bob@team");
		expect(receipt).toEqual({
			state: "runtime_queued",
			runtime: "codex",
			targetId: CODEX_THREAD,
			receipt: "queued",
		});
	});

	it("does not include an automatic content-retrieval instruction", () => {
		const prompt = buildCodexAttentionPrompt({
			eventId: EVENT,
			threadId: MAIL_THREAD,
		});
		expect(prompt).not.toContain("view_thread");
		expect(prompt).toContain("Do not call tools or take action");
	});

	it("rejects invalid local or mailbox identifiers before enqueue", async () => {
		expect(() => createCodexAttentionAdapter({ threadId: "session-name" })).toThrow(
			"Codex thread ID must be a UUID",
		);
		const runFile = vi.fn(async () => ({ stdout: "", stderr: "" }));
		const adapter = createCodexAttentionAdapter({ threadId: CODEX_THREAD, runFile });
		await expect(
			adapter.enqueueAttention({ eventId: "bad-event", threadId: MAIL_THREAD }),
		).rejects.toThrow("AgentRelay event ID must be a UUID");
		expect(runFile).not.toHaveBeenCalled();
	});
});
