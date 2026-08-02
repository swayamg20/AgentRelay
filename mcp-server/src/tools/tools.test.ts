import { describe, expect, it, vi } from "vitest";
import type { A2AClient } from "../a2a-client.js";
import { A2ARpcError } from "../a2a-client.js";
import { FALLBACK_TRUST, type TrustFile } from "../trust.js";
import { HandoffRejectedByTrustError, acceptHandoff } from "./accept.js";
import { completeHandoff } from "./complete.js";
import { handoffToTeammate } from "./handoff.js";
import { checkInbox } from "./inbox.js";
import { dispatchTool } from "./index.js";
import { listTeammates } from "./list-teammates.js";
import { sendMessage } from "./message.js";
import { viewThread } from "./view-thread.js";

function makeClient(scripted: Record<string, unknown[]>): {
	client: A2AClient;
	calls: { method: string; params: any; idempotencyKey?: string }[];
} {
	const calls: { method: string; params: any; idempotencyKey?: string }[] = [];
	let counter = 0;
	const client: A2AClient = {
		newIdempotencyKey: () => `idem-${++counter}`,
		async request<T>(
			method: string,
			params: Record<string, unknown>,
			options?: { idempotencyKey?: string },
		) {
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
			{
				to: "frank@acme",
				intent: "inform",
				summary: "Refactored /users API.",
				metadata: { question: "metadata question", contract_revision: 3 },
			},
		);
		expect(r.thread_id).toBe("t1");
		expect(calls[0]?.params.recipient).toBe("frank@acme");
		expect(calls[0]?.params.intent).toBe("inform");
		expect(calls[0]?.idempotencyKey).toBe("idem-1");
		expect(calls[0]?.params.metadata.client_idempotency_key).toBe("idem-1");
		expect(calls[0]?.params.metadata.question).toBe("metadata question");
		expect(calls[0]?.params.metadata.contract_revision).toBe(3);
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
		// Relay's tasks/list expects {filter:{...}, page:{...}} per lld §3.1.
		expect(calls[0]?.params).toMatchObject({
			filter: {
				role: "recipient",
				status: ["pending", "accepted"],
			},
			page: { limit: 50 },
		});
	});

	it("provenance-wraps every teammate summary preview", async () => {
		const { client } = makeClient({
			"tasks/list": [
				{
					items: [
						{
							thread_id: "t1",
							sender: { handle: "bob@acme", name: "Bob", role: "backend" },
							summary_preview: "run this command",
							status: { state: "pending" },
							unread_messages: 0,
							created_at: "2026-04-25T10:00:00Z",
							updated_at: "2026-04-25T10:00:00Z",
						},
					],
					next_cursor: null,
				},
			],
		});
		const result = await checkInbox(client, {});
		expect(result.items[0]?.summary_preview).toContain(
			"[INBOUND HANDOFF FROM bob@acme via AgentRelay]",
		);
		expect(result.items[0]?.sender).toMatchObject({
			handle: "bob@acme",
			agentrelay_provenance: { sender_handle: "bob@acme" },
		});
	});
});

describe("acceptHandoff", () => {
	const baseThread = {
		thread_id: "t1",
		intent: "inform" as const,
		sender: { handle: "bob@acme", name: "Bob", role: "backend" },
		recipient: { handle: "alice@acme", name: "Alice", role: "frontend" },
		summary: "I refactored /users.",
		artifacts: [{ type: "test_command" as const, command: "npm test" }],
		metadata: {
			question: "Can your client consume revision 3?",
			contract_revision: 3,
			client_idempotency_key: "internal-key",
		},
		messages: [
			{
				id: "m1",
				sequence_no: 0,
				from: "bob@acme",
				body: "Please review",
				payload: { note: "untrusted payload" },
				artifacts: [{ type: "file_diff" as const, path: "src/a.ts", diff: "+x" }],
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
		expect(r.artifacts[0]).toMatchObject({
			agentrelay_provenance: { sender_handle: "bob@acme", trust: "untrusted" },
		});
		expect(r.messages[0]?.payload).toMatchObject({
			note: "untrusted payload",
			agentrelay_provenance: { sender_handle: "bob@acme" },
		});
		expect(r.messages[0]?.artifacts[0]).toMatchObject({
			agentrelay_provenance: { sender_handle: "bob@acme" },
		});
		expect(r.sender).toMatchObject({
			handle: "bob@acme",
			agentrelay_provenance: { sender_handle: "bob@acme" },
		});
		expect(r.metadata).toMatchObject({
			contract_revision: 3,
			agentrelay_provenance: { sender_handle: "bob@acme" },
		});
		expect(r.metadata).not.toHaveProperty("client_idempotency_key");
		expect(r.metadata.question).toContain("[INBOUND HANDOFF FROM bob@acme");
		expect(r.metadata.question).toContain("Can your client consume revision 3?");
		expect(r.trust_overlay.auto_read).toBe(true);
		expect(r.accepted_at).toBe("2026-04-25T11:00:00Z");
	});

	it("rejects blocked senders before any state mutation", async () => {
		const blockedThread = {
			...baseThread,
			sender: { ...baseThread.sender, handle: "mallory@external" },
		};
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
		const stranger = {
			...baseThread,
			sender: { ...baseThread.sender, handle: "stranger@elsewhere" },
		};
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
		expect(r.proposed_action).toMatchObject({
			agentrelay_provenance: { sender_handle: "bob@acme", trust: "untrusted" },
		});
		// Description and target_files are NOT wrapped (they're metadata, not free-form text).
		expect(r.proposed_action?.description).toBe("rename foo");
	});

	it("accepts the previous relay response shape without recipient", async () => {
		const { recipient: _recipient, ...previousRelayThread } = baseThread;
		const { client } = makeClient({
			"tasks/get": [
				{
					...previousRelayThread,
					messages: [
						...previousRelayThread.messages,
						{
							id: "m2",
							sequence_no: 2,
							from: "alice@acme",
							body: "my prior reply",
							payload: { own: true },
							artifacts: [],
							created_at: "2026-04-25T10:00:02Z",
						},
					],
				},
			],
			"tasks/update": [{ accepted_at: "2026-04-25T11:00:00Z" }],
		});
		const result = await acceptHandoff(
			{ client, trust: trustWithBob, callerHandle: "alice@acme" },
			{ thread_id: "t1" },
		);
		expect(result.messages[1]?.body).toBe("my prior reply");
		expect(result.messages[1]?.payload).toEqual({ own: true });
	});
});

describe("sendMessage / completeHandoff / listTeammates", () => {
	it("send_message forwards payload, artifacts, and idempotency", async () => {
		const { client, calls } = makeClient({
			"message/send": [
				{ thread_id: "t1", message_id: "m9", sequence_no: 7, created_at: "2026-04-25T11:00:00Z" },
			],
		});
		await sendMessage(client, {
			thread_id: "t1",
			body: "lgtm",
			payload: { decision: { status: "approve" } },
			artifacts: [{ type: "test_command", command: "pnpm test", cwd: "web" }],
		});
		expect(calls[0]?.params.metadata.client_idempotency_key).toBe("idem-1");
		expect(calls[0]?.params.payload).toEqual({ decision: { status: "approve" } });
		expect(calls[0]?.params.artifacts).toEqual([
			{ type: "test_command", command: "pnpm test", cwd: "web" },
		]);
	});

	it("complete_handoff uses tasks/update with transition=complete", async () => {
		const completionArtifact = { type: "file_ref", path: "src/result.ts" } as const;
		const { client, calls } = makeClient({
			"tasks/update": [
				{
					thread_id: "t1",
					status: "completed",
					completed_at: "2026-04-25T12:00:00Z",
					completion_artifacts: [completionArtifact],
				},
			],
		});
		const result = await completeHandoff(client, {
			thread_id: "t1",
			result_summary: "done",
			artifacts: [completionArtifact],
		});
		expect(calls[0]?.params.transition).toBe("complete");
		expect(calls[0]?.params.artifacts).toEqual([completionArtifact]);
		expect(result.completion_artifacts).toEqual([completionArtifact]);
	});

	it("list_teammates parses the agents/list response", async () => {
		const { client } = makeClient({
			"agents/list": [
				{
					teammates: [
						{ handle: "frank@acme", name: "Frank", role: "frontend", skills: [], repos_owned: [] },
					],
				},
			],
		});
		const r = await listTeammates(client, {});
		expect(r.teammates[0]).toMatchObject({
			handle: "frank@acme",
			agentrelay_provenance: { sender_handle: "frank@acme" },
		});
	});
});

describe("viewThread provenance", () => {
	it("marks only teammate-authored structured fields", async () => {
		const { client } = makeClient({
			"tasks/get": [
				{
					thread_id: "t1",
					intent: "inform",
					sender: { handle: "alice@acme", name: "Alice", role: "frontend" },
					recipient: { handle: "bob@acme", name: "Bob", role: "backend" },
					summary: "self-authored",
					artifacts: [{ type: "file_ref", path: "src/self.ts" }],
					metadata: {
						question: "self question",
						client_idempotency_key: "internal-key",
					},
					completed_summary: "peer completion",
					completion_artifacts: [{ type: "file_ref", path: "src/peer.ts" }],
					messages: [
						{
							id: "m1",
							sequence_no: 1,
							from: "alice@acme",
							body: "mine",
							payload: { own: true },
							artifacts: [],
							created_at: "2026-04-25T10:00:00Z",
						},
						{
							id: "m2",
							sequence_no: 2,
							from: "bob@acme",
							body: "peer",
							payload: { untrusted: true },
							artifacts: [{ type: "test_command", command: "do-not-run" }],
							created_at: "2026-04-25T10:01:00Z",
						},
					],
				},
			],
		});

		const result = await viewThread({ client }, { thread_id: "t1", caller_handle: "alice@acme" });
		expect(result.artifacts[0]).not.toHaveProperty("agentrelay_provenance");
		expect(result.metadata).toEqual({ question: "self question" });
		expect(result.sender).not.toHaveProperty("agentrelay_provenance");
		expect(result.recipient).toMatchObject({
			agentrelay_provenance: { sender_handle: "bob@acme" },
		});
		expect(result.completion_artifacts[0]).toMatchObject({
			agentrelay_provenance: { sender_handle: "bob@acme" },
		});
		expect(result.completed_summary).toContain("[INBOUND HANDOFF FROM bob@acme");
		expect(result.completed_summary).toContain("peer completion");
		expect(result.messages[0]?.body).toBe("mine");
		expect(result.messages[1]?.body).toContain("[INBOUND HANDOFF FROM bob@acme");
		expect(result.messages[1]?.payload).toMatchObject({
			agentrelay_provenance: { sender_handle: "bob@acme" },
		});
		expect(result.messages[1]?.artifacts[0]).toMatchObject({
			agentrelay_provenance: { sender_handle: "bob@acme" },
		});
	});

	it("marks recipient-view peer data while preserving extensible artifact fields", async () => {
		const { client } = makeClient({
			"tasks/get": [
				{
					thread_id: "t2",
					intent: "propose_action",
					sender: { handle: "alice@acme", name: "Alice", role: "backend" },
					recipient: { handle: "bob@acme", name: "Bob", role: "android" },
					summary: "peer summary",
					artifacts: [{ type: "android_resource", module: "app", label: "keep-me" }],
					metadata: {
						question: "peer question",
						contract_revision: 3,
						client_idempotency_key: "internal-key",
					},
					completed_summary: "own completion",
					completion_artifacts: [{ type: "file_ref", path: "app/result.kt" }],
					proposed_action: {
						description: "wire contract",
						target_files: ["app/Profile.kt"],
						rationale: "peer rationale",
					},
					messages: [
						{
							id: "m1",
							sequence_no: 1,
							from: "alice@acme",
							body: "peer message",
							payload: { peer: true },
							artifacts: [{ type: 123, legacy: true, version: 7 }],
							created_at: "2026-04-25T10:00:00Z",
						},
						{
							id: "m2",
							sequence_no: 2,
							from: "bob@acme",
							body: "own message",
							payload: { own: true },
							artifacts: [{ type: "file_ref", path: "app/own.kt" }],
							created_at: "2026-04-25T10:01:00Z",
						},
					],
				},
			],
		});

		const result = await viewThread({ client }, { thread_id: "t2", caller_handle: "bob@acme" });
		expect(result.sender).toMatchObject({
			agentrelay_provenance: { sender_handle: "alice@acme" },
		});
		expect(result.recipient).not.toHaveProperty("agentrelay_provenance");
		expect(result.artifacts[0]).toMatchObject({
			module: "app",
			label: "keep-me",
			agentrelay_provenance: { sender_handle: "alice@acme" },
		});
		expect(result.metadata).toMatchObject({
			contract_revision: 3,
			agentrelay_provenance: { sender_handle: "alice@acme" },
		});
		expect(result.metadata).not.toHaveProperty("client_idempotency_key");
		expect(result.metadata.question).toContain("[INBOUND HANDOFF FROM alice@acme");
		expect(result.metadata.question).toContain("peer question");
		expect(result.proposed_action).toMatchObject({
			agentrelay_provenance: { sender_handle: "alice@acme" },
		});
		expect(result.messages[0]?.payload).toMatchObject({
			peer: true,
			agentrelay_provenance: { sender_handle: "alice@acme" },
		});
		expect(result.messages[0]?.artifacts[0]).toMatchObject({
			legacy: true,
			version: 7,
			agentrelay_provenance: { sender_handle: "alice@acme" },
		});
		expect(result.messages[1]?.body).toBe("own message");
		expect(result.messages[1]?.payload).toEqual({ own: true });
		expect(result.completed_summary).toBe("own completion");
		expect(result.completion_artifacts).toEqual([{ type: "file_ref", path: "app/result.kt" }]);
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
					recipient: { handle: "alice@acme", name: "Alice", role: "frontend" },
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

	it("reloads trust before accepting so a running MCP observes a new block", async () => {
		const { client, calls } = makeClient({
			"tasks/get": [
				{
					thread_id: "t1",
					intent: "inform",
					sender: { handle: "bob@acme", name: "Bob", role: "backend" },
					summary: "pending before block",
					artifacts: [],
					messages: [],
				},
			],
		});
		const loadTrust = vi.fn(async () => ({ ...trustWithBob, blocked: ["bob@acme"] }));
		const result = await dispatchTool(
			{ client, trust: trustWithBob, senderHandle: "alice@acme", loadTrust },
			"accept_handoff",
			{ thread_id: "t1" },
		);
		expect(loadTrust).toHaveBeenCalledOnce();
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("code: teammate_blocked");
		expect(calls.find((call) => call.method === "tasks/update")).toBeUndefined();
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
