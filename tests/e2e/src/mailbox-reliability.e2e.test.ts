import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Headers, fetch } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createA2AClient } from "../../../mcp-server/dist/a2a-client.js";
import { createMailboxEventClient } from "../../../mcp-server/dist/connector/event-client.js";
import { AgentHarness, TestRelay } from "./harness.js";

interface ThreadView {
	thread_id: string;
	messages: Array<{ id: string; sequence_no: number; from: string; body: string }>;
}

describe("durable mailbox process reliability", () => {
	let relay: TestRelay;
	let sender: AgentHarness;
	let receiver: AgentHarness | undefined;
	let senderAgent: Awaited<ReturnType<TestRelay["createAgent"]>>;
	let receiverAgent: Awaited<ReturnType<TestRelay["createAgent"]>>;
	let senderHome: string;
	let receiverHome: string;

	beforeAll(async () => {
		relay = await TestRelay.boot();
		senderAgent = await relay.createAgent({
			handle: "sender@reliability",
			email: "sender@reliability.test",
			name: "Sender",
			role: "backend",
		});
		receiverAgent = await relay.createAgent({
			handle: "receiver@reliability",
			email: "receiver@reliability.test",
			name: "Receiver",
			role: "frontend",
		});
		senderHome = await mkdtemp(join(tmpdir(), "agentrelay-reliability-sender-"));
		receiverHome = await mkdtemp(join(tmpdir(), "agentrelay-reliability-receiver-"));
		sender = await AgentHarness.start({
			relayUrl: relay.baseUrl,
			apiKey: senderAgent.api_key,
			agentId: senderAgent.agent_id,
			handle: senderAgent.handle,
			homeDir: senderHome,
		});
	});

	afterAll(async () => {
		await Promise.allSettled([sender?.stop(), receiver?.stop()]);
		await relay?.stop();
		await Promise.allSettled(
			[senderHome, receiverHome]
				.filter(Boolean)
				.map((home) => rm(home, { recursive: true, force: true })),
		);
	});

	it("retrieves the same committed thread in order after Relay restart and offline pickup, then replies", async () => {
		const sent = await sender.callTool<{ thread_id: string }>("handoff_to_teammate", {
			to: receiverAgent.handle,
			intent: "inform",
			summary: "Stored while the receiver has no MCP process",
		});
		const first = await sender.callTool<{ message_id: string; sequence_no: number }>(
			"send_message",
			{ thread_id: sent.thread_id, body: "First offline follow-up" },
		);
		const second = await sender.callTool<{ message_id: string; sequence_no: number }>(
			"send_message",
			{ thread_id: sent.thread_id, body: "Second offline follow-up" },
		);
		const before = await sender.callTool<ThreadView>("view_thread", {
			thread_id: sent.thread_id,
		});
		const eventClient = createMailboxEventClient({
			relayUrl: relay.baseUrl,
			apiKey: receiverAgent.api_key,
		});
		const eventsBefore = await eventClient.list(null);
		expect(eventsBefore.events.map((event) => event.kind)).toEqual([
			"thread.created",
			"message.appended",
			"message.appended",
		]);

		await relay.restart();
		expect(await eventClient.list(null)).toEqual(eventsBefore);
		receiver = await AgentHarness.start({
			relayUrl: relay.baseUrl,
			apiKey: receiverAgent.api_key,
			agentId: receiverAgent.agent_id,
			handle: receiverAgent.handle,
			homeDir: receiverHome,
		});
		const inbox = await receiver.callTool<{ items: Array<{ thread_id: string; status: string }> }>(
			"check_inbox",
			{},
		);
		expect(inbox.items).toEqual([
			expect.objectContaining({ thread_id: sent.thread_id, status: "pending" }),
		]);
		const after = await receiver.callTool<ThreadView>("view_thread", {
			thread_id: sent.thread_id,
		});
		expect(after.thread_id).toBe(sent.thread_id);
		expect(after.messages.map((message) => message.id)).toEqual(
			before.messages.map((message) => message.id),
		);
		expect(after.messages.map((message) => message.sequence_no)).toEqual([1, 2, 3]);
		expect(after.messages.slice(1).map((message) => message.id)).toEqual([
			first.message_id,
			second.message_id,
		]);
		for (const [index, body] of [
			"Stored while the receiver has no MCP process",
			"First offline follow-up",
			"Second offline follow-up",
		].entries()) {
			expect(after.messages[index]?.body).toContain(body);
			expect(after.messages[index]?.body).toContain(
				"[INBOUND HANDOFF FROM sender@reliability via AgentRelay]",
			);
		}
		const reply = await receiver.callTool<{ message_id: string; sequence_no: number }>(
			"send_message",
			{
				thread_id: sent.thread_id,
				body: "Replied after offline retrieval without accepting the task",
			},
		);
		expect(reply.sequence_no).toBe(4);
		const answered = await sender.callTool<ThreadView>("view_thread", {
			thread_id: sent.thread_id,
		});
		expect(answered.messages.at(-1)).toMatchObject({
			id: reply.message_id,
			sequence_no: 4,
			from: receiverAgent.handle,
		});
		expect(answered.messages.at(-1)?.body).toContain(
			"[INBOUND HANDOFF FROM receiver@reliability via AgentRelay]",
		);
	});

	it("retries an append whose committed response was withheld using the identical request and one sequence", async () => {
		const client = createA2AClient({ relayUrl: relay.baseUrl, apiKey: senderAgent.api_key });
		const createKey = randomUUID();
		const createParams = {
			recipient: receiverAgent.handle,
			message: { parts: [{ type: "text", text: "Retry fixture" }] },
		};
		const created = await client.request<{ task_id: string }>("message/send", createParams, {
			idempotencyKey: createKey,
		});
		const replayed = await client.request<{ task_id: string }>("message/send", createParams, {
			idempotencyKey: createKey,
		});
		expect(replayed).toEqual(created);
		const appendKey = randomUUID();
		const requests: Array<{ body: unknown; key: string | null }> = [];
		let committed: { message_id: string; sequence_no: number } | undefined;
		const withholdingFetch: typeof fetch = async (url, init) => {
			requests.push({ body: init?.body, key: new Headers(init?.headers).get("idempotency-key") });
			const response = await fetch(url, init);
			if (requests.length === 1) {
				expect(response.status).toBe(200);
				const receipt = (await response.json()) as { result: typeof committed; error?: unknown };
				expect(receipt.error).toBeUndefined();
				committed = receipt.result;
				expect(committed?.sequence_no).toBe(2);
				throw new Error("test transport withheld the committed append response");
			}
			return response;
		};
		const retryingClient = createA2AClient({
			relayUrl: relay.baseUrl,
			apiKey: senderAgent.api_key,
			fetch: withholdingFetch,
			maxAttempts: 2,
			backoffBaseMs: 0,
		});
		const appended = await retryingClient.request<{ message_id: string; sequence_no: number }>(
			"message/send",
			{
				task_id: created.task_id,
				message: { parts: [{ type: "text", text: "Only one durable append" }] },
				payload: { revision: 1 },
				artifacts: [{ type: "file_ref", path: "docs/contract.md" }],
			},
			{ idempotencyKey: appendKey },
		);
		expect(requests).toHaveLength(2);
		expect(requests[1]).toEqual(requests[0]);
		expect(requests[0]?.key).toBe(appendKey);
		expect(appended).toEqual(committed);
		const thread = await client.request<{ history: Array<{ id: string; sequence_no: number }> }>(
			"tasks/get",
			{ task_id: created.task_id },
		);
		expect(thread.history.map((message) => message.sequence_no)).toEqual([1, 2]);
		expect(thread.history.at(-1)?.id).toBe(appended.message_id);
		const next = await client.request<{ sequence_no: number }>("message/send", {
			task_id: created.task_id,
			message: { parts: [{ type: "text", text: "Next distinct message" }] },
		});
		expect(next.sequence_no).toBe(3);
	});
});
