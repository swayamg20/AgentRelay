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

	it("validates appended artifacts", () => {
		expect(() =>
			sendMessageInput.parse({
				thread_id: "t1",
				body: "reviewed",
				artifacts: [{ type: "test_command", command: "pnpm test", cwd: "web" }],
			}),
		).not.toThrow();
		expect(() =>
			sendMessageInput.parse({
				thread_id: "t1",
				body: "reviewed",
				artifacts: [{ type: "test_command" }],
			}),
		).toThrow();
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
	it("trims exact filters without changing case or splitting tokens", () => {
		expect(
			listTeammatesInput.parse({ role: " Backend ", skill: " Type Script ", repo: " acme/core " }),
		).toEqual({ role: "Backend", skill: "Type Script", repo: "acme/core" });
	});
	it("opts into pagination only when page is present", () => {
		expect(listTeammatesInput.parse({})).toEqual({});
		expect(listTeammatesInput.parse({ page: {} })).toEqual({ page: { limit: 50, cursor: null } });
		expect(
			listTeammatesInput.parse({ page: { limit: 200, cursor: { after_handle: "bob@acme" } } }),
		).toEqual({ page: { limit: 200, cursor: { after_handle: "bob@acme" } } });
	});
	it.each([
		{ role: "" },
		{ skill: " \t\n " },
		{ repo: "" },
		{ role: null },
		{ skill: ["TypeScript"] },
		{ repo: 42 },
		{ role: "x".repeat(61) },
		{ skill: "x".repeat(61) },
		{ repo: "x".repeat(201) },
		{ filter: { role: "backend" } },
		{ page: null },
		{ page: [] },
		{ page: { limit: 0 } },
		{ page: { limit: -1 } },
		{ page: { limit: 201 } },
		{ page: { limit: 1.5 } },
		{ page: { limit: "2" } },
		{ page: { offset: 0 } },
		{ page: { cursor: "bob@acme" } },
		{ page: { cursor: {} } },
		{ page: { cursor: { after_handle: "" } } },
		{ page: { cursor: { after_handle: "not a handle" } } },
		{ page: { cursor: { after_handle: "bob@acme", extra: true } } },
		{ page: { cursor: { after_handle: `${"x".repeat(116)}@acme` } } },
	])("rejects malformed roster input %j", (input) => {
		expect(() => listTeammatesInput.parse(input)).toThrow();
	});
});
