import { describe, expect, it, vi } from "vitest";
import type { A2AClient } from "../a2a-client.js";
import { A2ARpcError } from "../a2a-client.js";
import { FALLBACK_TRUST, type TrustFile } from "../trust.js";
import { acceptHandoff, HandoffRejectedByTrustError } from "./accept.js";
import { checkInbox } from "./inbox.js";
import { completeHandoff } from "./complete.js";
import { dispatchTool } from "./index.js";
import { handoffToTeammate } from "./handoff.js";
import { listTeammates } from "./list-teammates.js";
import { sendMessage } from "./message.js";

function makeClient(scripted: Record<string, unknown[]>): {
	client: A2AClient;
	calls: { method: string; params: any; idempotencyKey?: string }[];
} {
	const calls: { method: string; params: any; idempotencyKey?: string }[] = [];
	let counter = 0;
	const client: A2AClient = {
		newIdempotencyKey: () => `idem-${++counter}`,
		async request<T>(method: string, params: Record<string, unknown>, options?: { idempotencyKey?: string }) {
			calls.push({ method, params, idempotencyKey: options?.idempotencyKey });
			const queue = scripted[method];
			if (!queue || queue.length === 0) {
				throw new Error(`unexpected call to ${method}`);
			}
			const next = queue.shift();
			if (next instanceof Error) throw next;
			return next as T;
		},
	};
	return { client, calls };
}

const trustWithBob: TrustFile = {
	version: 1,
	teammates: {
		"bob@acme": {
			auto_read: true,
			auto_test: true,
			auto_write_paths: [],
			require_approval: ["Edit", "Write", "Bash"],
		},
	},
	unknown_teammates: { policy: "reject" },
	blocked: ["mallory@external"],
	defaults: {},
};

describe("handoffToTeammate", () => {
	it("posts message/send and returns the new thread", async () => {
		const { client, calls } = makeClient({
			"message/send": [
				{ task_id: "t1", status: { state: "pending" }, created_at: "2026-04-25T10:00:00Z" },
			],
		});
		const r = await handoffToTeammate(
			{ client, senderHandle: "alice@acme" },
			{ to: "frank@acme", intent: "inform", summary: "Refactored /users API." },
		);
		expect(r.thread_id).toBe("t1");
		expect(calls[0]?.params.recipient).toBe("frank@acme");
		expect(calls[0]?.params.intent).toBe("inform");
		expect(calls[0]?.idempotencyKey).toBe("idem-1");
		expect(calls[0]?.params.metadata.client_idempotency_key).toBe("idem-1");
	});

	it("rejects propose_action without proposed_action", async () => {
		const { client } = makeClient({});
		await expect(
			handoffToTeammate(
				{ client, senderHandle: "alice@acme" },
				{ to: "frank@acme", intent: "propose_action", summary: "do it" },
			),
		).rejects.toThrow();
	});
});

describe("checkInbox", () => {
	it("calls tasks/list with default filters", async () => {
		const { client, calls } = makeClient({
			"tasks/list": [{ items: [], next_cursor: null }],
		});
		await checkInbox(client, {});
		expect(calls[0]?.params).toMatchObject({
			role: "recipient",
			status: ["pending", "accepted"],
			limit: 50,
		});
	});
});

describe("acceptHandoff", () => {
	const baseThread = {
		thread_id: "t1",
		intent: "inform" as const,
		sender: { handle: "bob@acme", name: "Bob", role: "backend" },
		summary: "I refactored /users.",
		artifacts: [],
		messages: [
			{
				id: "m1",
				sequence_no: 0,
				from: "bob@acme",
				body: "Please review",
				created_at: "2026-04-25T10:00:01Z",
			},
		],
	};

	it("wraps summary and message bodies with provenance", async () => {
		const { client } = makeClient({
			"tasks/get": [baseThread],
			"tasks/update": [{ accepted_at: "2026-04-25T11:00:00Z" }],
		});
		const r = await acceptHandoff({ client, trust: trustWithBob }, { thread_id: "t1" });
		expect(r.summary).toContain("[INBOUND HANDOFF FROM bob@acme via AgentRelay]");
		expect(r.summary).toContain("I refactored /users.");
		expect(r.messages[0]?.body).toContain("[INBOUND HANDOFF FROM bob@acme");
		expect(r.messages[0]?.body).toContain("Please review");
		expect(r.trust_overlay.auto_read).toBe(true);
		expect(r.accepted_at).toBe("2026-04-25T11:00:00Z");
	});

	it("rejects blocked senders before any state mutation", async () => {
		const blockedThread = { ...baseThread, sender: { ...baseThread.sender, handle: "mallory@external" } };
		const { client, calls } = makeClient({
			"tasks/get": [blockedThread],
		});
		await expect(
			acceptHandoff({ client, trust: trustWithBob }, { thread_id: "t1" }),
		).rejects.toBeInstanceOf(HandoffRejectedByTrustError);
		// Critically, no tasks/update call was made.
		expect(calls.find((c) => c.method === "tasks/update")).toBeUndefined();
	});

	it("rejects unknown senders when policy is reject", async () => {
		const stranger = { ...baseThread, sender: { ...baseThread.sender, handle: "stranger@elsewhere" } };
		const { client } = makeClient({
			"tasks/get": [stranger],
		});
		await expect(
			acceptHandoff({ client, trust: trustWithBob }, { thread_id: "t1" }),
		).rejects.toBeInstanceOf(HandoffRejectedByTrustError);
	});

	it("wraps proposed_action.rationale", async () => {
		const proposedThread = {
			...baseThread,
			intent: "propose_action" as const,
			proposed_action: {
				description: "rename foo",
				target_files: ["src/foo.ts"],
				rationale: "we should call it bar",
			},
		};
		const { client } = makeClient({
			"tasks/get": [proposedThread],
			"tasks/update": [{ accepted_at: "2026-04-25T11:00:00Z" }],
		});
		const r = await acceptHandoff({ client, trust: trustWithBob }, { thread_id: "t1" });
		expect(r.proposed_action?.rationale).toContain("[INBOUND HANDOFF FROM bob@acme");
		expect(r.proposed_action?.rationale).toContain("we should call it bar");
		// Description and target_files are NOT wrapped (they're metadata, not free-form text).
		expect(r.proposed_action?.description).toBe("rename foo");
	});
});

describe("sendMessage / completeHandoff / listTeammates", () => {
	it("send_message threads idempotency through metadata", async () => {
		const { client, calls } = makeClient({
			"message/send": [
				{ thread_id: "t1", message_id: "m9", sequence_no: 7, created_at: "2026-04-25T11:00:00Z" },
			],
		});
		await sendMessage(client, { thread_id: "t1", body: "lgtm" });
		expect(calls[0]?.params.metadata.client_idempotency_key).toBe("idem-1");
	});

	it("complete_handoff uses tasks/update with transition=complete", async () => {
		const { client, calls } = makeClient({
			"tasks/update": [{ thread_id: "t1", status: "completed", completed_at: "2026-04-25T12:00:00Z" }],
		});
		await completeHandoff(client, { thread_id: "t1", result_summary: "done" });
		expect(calls[0]?.params.transition).toBe("complete");
	});

	it("list_teammates parses the agents/list response", async () => {
		const { client } = makeClient({
			"agents/list": [
				{ teammates: [{ handle: "frank@acme", name: "Frank", role: "frontend", skills: [], repos_owned: [] }] },
			],
		});
		const r = await listTeammates(client, {});
		expect(r.teammates[0]?.handle).toBe("frank@acme");
	});
});

describe("dispatchTool error mapping", () => {
	it("zod errors become invalid_params", async () => {
		const { client } = makeClient({});
		const r = await dispatchTool(
			{ client, trust: FALLBACK_TRUST, senderHandle: "alice@acme" },
			"send_message",
			{ thread_id: "t1" }, // missing body
		);
		expect(r.isError).toBe(true);
		expect(r.content[0]?.text).toContain("code: invalid_params");
	});

	it("relay RPC errors are mapped to their symbol", async () => {
		const { client } = makeClient({
			"tasks/list": [new A2ARpcError({ code: -32003, message: "rate limited" })],
		});
		const r = await dispatchTool(
			{ client, trust: FALLBACK_TRUST, senderHandle: "alice@acme" },
			"check_inbox",
			{},
		);
		expect(r.isError).toBe(true);
		expect(r.content[0]?.text).toContain("code: rate_limited");
	});

	it("unknown tools surface method_not_found", async () => {
		const { client } = makeClient({});
		const r = await dispatchTool(
			{ client, trust: FALLBACK_TRUST, senderHandle: "alice@acme" },
			"unknown_tool",
			{},
		);
		expect(r.isError).toBe(true);
		expect(r.content[0]?.text).toContain("code: method_not_found");
	});

	it("trust-rejected handoffs surface teammate_blocked", async () => {
		const { client } = makeClient({
			"tasks/get": [
				{
					thread_id: "t1",
					intent: "inform",
					sender: { handle: "stranger@x", name: "S", role: "x" },
					summary: "hi",
					artifacts: [],
					messages: [],
				},
			],
		});
		const r = await dispatchTool(
			{ client, trust: trustWithBob, senderHandle: "alice@acme" },
			"accept_handoff",
			{ thread_id: "t1" },
		);
		expect(r.isError).toBe(true);
		expect(r.content[0]?.text).toContain("code: teammate_blocked");
	});

	it("happy path returns JSON-serialized result with no error flag", async () => {
		const { client } = makeClient({
			"tasks/list": [{ items: [], next_cursor: null }],
		});
		const r = await dispatchTool(
			{ client, trust: FALLBACK_TRUST, senderHandle: "alice@acme" },
			"check_inbox",
			{},
		);
		expect(r.isError).toBeFalsy();
		expect(r.content[0]?.text).toContain('"items"');
	});
});

// Light import to keep vi available without unused-import warnings if the
// suite is later extended with mocks.
void vi;
