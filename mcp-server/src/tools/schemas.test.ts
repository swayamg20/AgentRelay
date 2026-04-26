import { describe, expect, it } from "vitest";
import {
	acceptHandoffInput,
	checkInboxInput,
	completeHandoffInput,
	handoffToTeammateInput,
	listTeammatesInput,
	sendMessageInput,
} from "./schemas.js";

describe("handoffToTeammateInput", () => {
	it("accepts a minimal inform handoff", () => {
		const r = handoffToTeammateInput.parse({
			to: "frank@acme",
			intent: "inform",
			summary: "x",
		});
		expect(r.intent).toBe("inform");
	});

	it("rejects malformed handles", () => {
		expect(() =>
			handoffToTeammateInput.parse({ to: "no-at-symbol", intent: "inform", summary: "x" }),
		).toThrow();
	});

	it("requires proposed_action when intent is propose_action", () => {
		expect(() =>
			handoffToTeammateInput.parse({
				to: "frank@acme",
				intent: "propose_action",
				summary: "x",
			}),
		).toThrow();
	});

	it("rejects proposed_action when intent is not propose_action", () => {
		expect(() =>
			handoffToTeammateInput.parse({
				to: "frank@acme",
				intent: "inform",
				summary: "x",
				proposed_action: { description: "a", target_files: [], rationale: "r" },
			}),
		).toThrow();
	});

	it("validates artifact discriminated union", () => {
		expect(() =>
			handoffToTeammateInput.parse({
				to: "frank@acme",
				intent: "inform",
				summary: "x",
				artifacts: [{ type: "file_diff", path: "a.ts", diff: "..." }],
			}),
		).not.toThrow();
		expect(() =>
			handoffToTeammateInput.parse({
				to: "frank@acme",
				intent: "inform",
				summary: "x",
				artifacts: [{ type: "file_diff", path: "a.ts" }],
			}),
		).toThrow();
	});
});

describe("checkInboxInput", () => {
	it("accepts empty input", () => {
		expect(() => checkInboxInput.parse({})).not.toThrow();
	});

	it("rejects unknown statuses", () => {
		expect(() => checkInboxInput.parse({ status: ["weird"] })).toThrow();
	});

	it("clamps limit", () => {
		expect(() => checkInboxInput.parse({ limit: 9999 })).toThrow();
		expect(() => checkInboxInput.parse({ limit: 0 })).toThrow();
	});
});

describe("acceptHandoffInput", () => {
	it("requires thread_id", () => {
		expect(() => acceptHandoffInput.parse({})).toThrow();
	});
	it("rejects unknown keys", () => {
		expect(() => acceptHandoffInput.parse({ thread_id: "t1", evil: 1 })).toThrow();
	});
});

describe("sendMessageInput", () => {
	it("requires non-empty body", () => {
		expect(() => sendMessageInput.parse({ thread_id: "t1", body: "" })).toThrow();
	});
});

describe("completeHandoffInput", () => {
	it("requires result_summary", () => {
		expect(() => completeHandoffInput.parse({ thread_id: "t1" })).toThrow();
	});
});

describe("listTeammatesInput", () => {
	it("accepts no filter", () => {
		expect(() => listTeammatesInput.parse({})).not.toThrow();
	});
	it("rejects unknown keys", () => {
		expect(() => listTeammatesInput.parse({ team: "x" })).toThrow();
	});
});
