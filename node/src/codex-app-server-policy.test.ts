import { describe, expect, it } from "vitest";
import { denyCodexServerRequest } from "./codex-app-server-policy.js";

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
});
