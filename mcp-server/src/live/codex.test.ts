import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexLiveRuntime } from "./codex.js";
import { LiveSessionError } from "./contracts.js";

interface MockRpc {
	onFailure(error: Error): void;
	onRequest(method: string, params: unknown): unknown;
	onNotification(method: string, params: unknown): void;
}
const harness = vi.hoisted(() => ({
	rpc: undefined as MockRpc | undefined,
	calls: [] as Array<{ method: string; params: Record<string, unknown> }>,
	version: "codex-cli 0.154.0",
	pending: false,
	stop: vi.fn(async () => {}),
}));
vi.mock("node:child_process", () => ({
	execFile: Object.assign(() => {}, {
		[Symbol.for("nodejs.util.promisify.custom")]: async () => ({ stdout: harness.version }),
	}),
	spawn: vi.fn(),
}));
vi.mock("node:fs/promises", async (original) => ({
	...(await original<typeof import("node:fs/promises")>()),
	mkdtemp: async () => "/tmp/agentrelay-unit-host",
	realpath: async (path: string) => path,
}));
vi.mock("./codex-socket.js", () => ({
	startCodexSocketHost: async () => ({
		socketPath: "/tmp/unused",
		endpoint: "unix:///tmp/unused",
		stop: harness.stop,
	}),
}));
vi.mock("./codex-rpc.js", () => ({
	CodexLiveRpc: class implements MockRpc {
		onFailure: (error: Error) => void = () => {};
		onRequest: (method: string, params: unknown) => unknown = () => {};
		onNotification: (method: string, params: unknown) => void = () => {};
		constructor() {
			harness.rpc = this;
		}
		notify() {}
		fail(code: string) {
			this.onFailure(new LiveSessionError(code, code));
		}
		async close() {
			this.fail("closed");
		}
		async request(method: string, params: Record<string, unknown>) {
			harness.calls.push({ method, params });
			if (method === "config/read") return { config: { mcp_servers: { untrusted: {} } } };
			if (method === "thread/start")
				return {
					thread: { id: "owned" },
					approvalPolicy: "never",
					sandbox: { type: "readOnly" },
					cwd: params.cwd,
				};
			if (method === "mcpServerStatus/list") return { data: [], nextCursor: null };
			if (method === "turn/start") {
				queueMicrotask(() => {
					this.onNotification("turn/started", {
						threadId: "owned",
						turn: { id: "turn", status: "inProgress" },
					});
					if (harness.pending) return;
					const call = {
						threadId: "owned",
						turnId: "turn",
						callId: "call",
						tool: "receive_live_message",
						arguments: { message_id: params.clientUserMessageId },
					};
					this.onRequest("item/tool/call", call);
					this.onRequest("item/tool/call", {
						...call,
						tool: "reply_live_message",
						arguments: { ...call.arguments, body: "answer" },
					});
					this.onNotification("turn/completed", {
						threadId: "owned",
						turn: { id: "turn", status: "completed" },
					});
				});
				return { turn: { id: "turn" } };
			}
			return {};
		}
	},
}));

beforeEach(() => {
	harness.calls = [];
	harness.rpc = undefined;
	harness.pending = false;
	harness.version = "codex-cli 0.154.0";
	harness.stop.mockClear();
});

describe("owned Codex live runtime", () => {
	it("starts only a new restricted thread and does not report normal shutdown as failure", async () => {
		const onStop = vi.fn();
		const onAccepted = vi.fn();
		const runtime = createCodexLiveRuntime({ onStop, onAccepted });
		const result = await runtime.runTurn(
			{ messageId: randomUUID(), content: "marked data" },
			new AbortController().signal,
		);
		expect(result).toEqual({ reply: "answer", host: { threadId: "owned", turnId: "turn" } });
		const start = harness.calls.find((call) => call.method === "thread/start")!.params;
		expect(start).toMatchObject({
			approvalPolicy: "never",
			sandbox: "read-only",
			config: { "mcp_servers.untrusted.enabled": false, "features.shell_tool": false },
			environments: [],
		});
		expect(harness.calls.some((call) => call.method === "thread/resume")).toBe(false);
		expect(onAccepted).toHaveBeenCalledOnce();
		await runtime.close();
		await runtime.close();
		expect(harness.stop).toHaveBeenCalledOnce();
		expect(onStop).not.toHaveBeenCalled();
	});
	it("reports an idle host loss immediately so the bridge can stop its SSE connection", async () => {
		const onStop = vi.fn();
		const runtime = createCodexLiveRuntime({ onStop });
		await runtime.runTurn(
			{ messageId: randomUUID(), content: "data" },
			new AbortController().signal,
		);
		harness.rpc!.onFailure(new LiveSessionError("transport_closed", "closed"));
		expect(onStop).toHaveBeenCalledOnce();
		await runtime.close();
		expect(harness.stop).toHaveBeenCalledOnce();
	});
	it("cancels an in-flight turn and stops only its own host", async () => {
		harness.pending = true;
		const controller = new AbortController();
		const runtime = createCodexLiveRuntime({ onAccepted: () => controller.abort() });
		await expect(
			runtime.runTurn({ messageId: randomUUID(), content: "data" }, controller.signal),
		).rejects.toThrow("stopped");
		await runtime.close();
		expect(harness.stop).toHaveBeenCalledOnce();
	});
	it("refuses an untested host version before creating a thread", async () => {
		harness.version = "codex-cli 0.999.0";
		const runtime = createCodexLiveRuntime();
		await expect(
			runtime.runTurn({ messageId: randomUUID(), content: "data" }, new AbortController().signal),
		).rejects.toThrow("tested Codex");
		expect(harness.rpc).toBeUndefined();
		await runtime.close();
	});
});
