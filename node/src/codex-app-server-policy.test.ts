import { describe, expect, it } from "vitest";
import {
	createCodexServerRequestHandler,
	denyCodexServerRequest,
} from "./codex-app-server-policy.js";

describe("Codex app-server local policy", () => {
	it("declines command approval and makes the request fatal", () => {
		expect(
			denyCodexServerRequest({
				id: "approval-1",
				method: "item/commandExecution/requestApproval",
				params: {},
			}),
		).toMatchObject({
			kind: "result",
			value: { decision: "decline" },
			fatal: { name: "CodexAppServerError", reason: "policy" },
		});
	});

	it("rejects unknown server-initiated methods", () => {
		expect(denyCodexServerRequest({ id: 1, method: "unknown/method", params: {} })).toMatchObject({
			kind: "error",
			code: -32601,
			fatal: { reason: "policy" },
		});
	});

	it.each([
		["item/commandExecution/requestApproval", { decision: "decline" }],
		["item/fileChange/requestApproval", { decision: "decline" }],
		["item/permissions/requestApproval", { permissions: {}, scope: "turn" }],
		["item/tool/requestUserInput", { answers: {} }],
		["mcpServer/elicitation/request", { action: "decline", content: null, _meta: null }],
		["item/tool/call", { contentItems: [], success: false }],
		[
			"applyPatchApproval",
			{ decision: { denied: { rejection: "AgentRelay local policy denied approval" } } },
		],
		[
			"execCommandApproval",
			{ decision: { denied: { rejection: "AgentRelay local policy denied approval" } } },
		],
	] as const)("keeps %s on its fixed fatal denial", (method, value) => {
		expect(denyCodexServerRequest({ id: "server-1", method, params: {} })).toMatchObject({
			kind: "result",
			value,
			fatal: { name: "CodexAppServerError", reason: "policy" },
		});
	});

	it("routes only an exact dynamic patch call to the injected handler", async () => {
		const signal = new AbortController().signal;
		const calls: unknown[] = [];
		const handler = createCodexServerRequestHandler({
			async handle(call, receivedSignal) {
				calls.push({ call, signal: receivedSignal });
				return "applied";
			},
		});

		await expect(
			handler({ id: "tool-1", method: "item/tool/call", params: exactPatchParams() }, signal),
		).resolves.toEqual({
			kind: "result",
			value: {
				contentItems: [{ type: "inputText", text: "AgentRelay applied the patch." }],
				success: true,
			},
		});
		expect(calls).toEqual([
			{
				call: {
					threadId: "thread-1",
					turnId: "turn-1",
					callId: "call-1",
					patch: "patch",
				},
				signal,
			},
		]);

		expect(
			await handler(
				{
					id: "tool-2",
					method: "item/tool/call",
					params: { ...exactPatchParams(), namespace: "peer" },
				},
				signal,
			),
		).toMatchObject({
			kind: "result",
			value: { contentItems: [], success: false },
			fatal: { reason: "policy" },
		});
		expect(calls).toHaveLength(1);
	});

	it("propagates an async local handler failure without inventing a tool response", async () => {
		const canary = "local-handler-secret";
		const handler = createCodexServerRequestHandler({
			async handle() {
				throw new Error(canary);
			},
		});

		await expect(
			handler(
				{
					id: "tool-1",
					method: "item/tool/call",
					params: exactPatchParams(),
				},
				new AbortController().signal,
			),
		).rejects.toEqual(
			expect.objectContaining({
				name: "CodexAppServerError",
				reason: "policy",
				message: "AgentRelay patch tool handler failed closed",
			}),
		);
		try {
			await handler(
				{ id: "tool-2", method: "item/tool/call", params: exactPatchParams() },
				new AbortController().signal,
			);
		} catch (error) {
			expect(JSON.stringify(error)).not.toContain(canary);
		}
	});

	it("responds with a fixed rejection only for a durable fatal receipt outcome", async () => {
		const handler = createCodexServerRequestHandler({
			async handle() {
				return "fatal_rejected";
			},
		});

		expect(
			await handler(
				{ id: "tool-1", method: "item/tool/call", params: exactPatchParams() },
				new AbortController().signal,
			),
		).toEqual({
			kind: "result",
			value: {
				contentItems: [{ type: "inputText", text: "AgentRelay did not apply the patch." }],
				success: false,
			},
			fatal: expect.objectContaining({ reason: "policy" }),
		});
	});
});

function exactPatchParams() {
	return {
		threadId: "thread-1",
		turnId: "turn-1",
		callId: "call-1",
		namespace: "agentrelay",
		tool: "apply_patch",
		arguments: { patch: "patch" },
	};
}
