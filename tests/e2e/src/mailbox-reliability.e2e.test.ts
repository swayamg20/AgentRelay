import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetch as undiciFetch } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createA2AClient } from "../../../mcp-server/dist/a2a-client.js";
import { createMailboxEventClient } from "../../../mcp-server/dist/connector/event-client.js";
import type { ViewThreadResult } from "../../../mcp-server/dist/tools/view-thread.js";
import { AgentHarness, TestRelay } from "./harness.js";

interface AppendReceipt {
	thread_id: string;
	message_id: string;
	sequence_no: number;
	created_at: string;
}

describe("durable mailbox process boundaries", () => {
	let relay: TestRelay;
	let directory: string;
	let senderAgent: Awaited<ReturnType<TestRelay["createAgent"]>>;
	let receiverAgent: typeof senderAgent;
	let sender: AgentHarness;
	let receiver: AgentHarness | undefined;

	beforeAll(async () => {
		relay = await TestRelay.boot({ port: 18085 });
		directory = await mkdtemp(join(tmpdir(), "agentrelay-mailbox-reliability-"));
		senderAgent = await relay.createAgent({
			handle: "sender@mailbox",
			email: "sender@example.test",
			name: "Sender",
			role: "developer",
		});
		receiverAgent = await relay.createAgent({
			handle: "receiver@mailbox",
			email: "receiver@example.test",
			name: "Receiver",
			role: "developer",
		});
		sender = await AgentHarness.start({
			relayUrl: relay.baseUrl,
			apiKey: senderAgent.api_key,
			agentId: senderAgent.agent_id,
			handle: senderAgent.handle,
			homeDir: join(directory, "sender"),
		});
	});

	afterAll(async () => {
		await Promise.allSettled([sender?.stop(), receiver?.stop()]);
		await relay?.stop();
		if (directory) await rm(directory, { recursive: true, force: true });
	});

	it("retains committed sends across restart and offline receiver pickup and reply", async () => {
		const client = createA2AClient({ relayUrl: relay.baseUrl, apiKey: senderAgent.api_key });
		const params = {
			recipient: receiverAgent.handle,
			intent: "inform",
			message: { parts: [{ type: "text", text: "Stored while the receiver is offline" }] },
		};
		const idempotencyKey = randomUUID();
		const created = await client.request<{ task_id: string }>("message/send", params, {
			idempotencyKey,
		});
		const threadId = created.task_id;
		for (const body of ["First offline follow-up", "Second offline follow-up"]) {
			await sender.callTool("send_message", { thread_id: threadId, body });
		}
		const before = await sender.callTool<ViewThreadResult>("view_thread", {
			thread_id: threadId,
		});
		expect(before.messages.map((message) => message.sequence_no)).toEqual([1, 2, 3]);

		await relay.restart();
		const replayed = await client.request<{ task_id: string }>("message/send", params, {
			idempotencyKey,
		});
		expect(replayed.task_id).toBe(threadId);
		expect(await sender.callTool("view_thread", { thread_id: threadId })).toEqual(before);

		receiver = await AgentHarness.start({
			relayUrl: relay.baseUrl,
			apiKey: receiverAgent.api_key,
			agentId: receiverAgent.agent_id,
			handle: receiverAgent.handle,
			homeDir: join(directory, "receiver"),
		});
		const inbox = await receiver.callTool<{ items: Array<{ thread_id: string }> }>(
			"check_inbox",
			{},
		);
		expect(inbox.items.map((item) => item.thread_id)).toEqual([threadId]);
		const pickedUp = await receiver.callTool<ViewThreadResult>("view_thread", {
			thread_id: threadId,
		});
		expect(pickedUp.messages.map((message) => message.id)).toEqual(
			before.messages.map((message) => message.id),
		);
		for (const [index, message] of pickedUp.messages.entries()) {
			expect(message.sequence_no).toBe(index + 1);
			expect(message.body).toContain("[INBOUND HANDOFF FROM sender@mailbox via AgentRelay]");
			expect(message.body).toContain(before.messages[index]?.body);
		}
		const reply = await receiver.callTool<AppendReceipt>("send_message", {
			thread_id: threadId,
			body: "Retrieved all three messages and replying in the same thread",
		});
		expect(reply.sequence_no).toBe(4);
		const answered = await sender.callTool<ViewThreadResult>("view_thread", {
			thread_id: threadId,
		});
		expect(answered.messages.map((message) => message.sequence_no)).toEqual([1, 2, 3, 4]);
		expect(answered.messages[3]?.id).toBe(reply.message_id);
		expect(answered.messages[3]?.body).toContain(
			"[INBOUND HANDOFF FROM receiver@mailbox via AgentRelay]",
		);
		expect(answered.messages[3]?.body).toContain("Retrieved all three messages");
	});

	it("retries an append whose committed response was lost without a duplicate message", async () => {
		const created = await sender.callTool<{ thread_id: string }>("handoff_to_teammate", {
			to: receiverAgent.handle,
			intent: "inform",
			summary: "Lost response fixture",
		});
		const requestBodies: string[] = [];
		let committedReceipt: AppendReceipt | undefined;
		let responseWithheld = false;
		const transport: typeof undiciFetch = async (input, init) => {
			requestBodies.push(String(init?.body));
			const response = await undiciFetch(input, init);
			if (requestBodies.length === 1) {
				expect(response.status).toBe(200);
				const envelope = (await response.json()) as { result: AppendReceipt };
				committedReceipt = envelope.result;
				const stored = await sender.callTool<ViewThreadResult>("view_thread", {
					thread_id: created.thread_id,
				});
				expect(stored.messages[1]?.id).toBe(committedReceipt.message_id);
				responseWithheld = true;
				throw new Error("Test transport withheld the committed append response");
			}
			return response;
		};
		const client = createA2AClient({
			relayUrl: relay.baseUrl,
			apiKey: senderAgent.api_key,
			fetch: transport,
			maxAttempts: 2,
			backoffBaseMs: 0,
		});
		const idempotencyKey = randomUUID();
		const params = {
			task_id: created.thread_id,
			message: { parts: [{ type: "text", text: "Only one committed follow-up" }] },
			payload: { revision: 2 },
			artifacts: [{ type: "file_ref", path: "docs/contract.md" }],
		};
		const result = await client.request<AppendReceipt>("message/send", params, {
			idempotencyKey,
		});
		expect(requestBodies).toHaveLength(2);
		expect(responseWithheld).toBe(true);
		expect(requestBodies[0]).toBe(requestBodies[1]);
		expect(JSON.parse(requestBodies[0] ?? "{}").params.metadata.client_idempotency_key).toBe(
			idempotencyKey,
		);
		expect(result).toEqual(committedReceipt);
		expect(result.sequence_no).toBe(2);

		await relay.restart();
		expect(await client.request<AppendReceipt>("message/send", params, { idempotencyKey })).toEqual(
			result,
		);
		const stored = await sender.callTool<ViewThreadResult>("view_thread", {
			thread_id: created.thread_id,
		});
		expect(stored.messages.map((message) => message.sequence_no)).toEqual([1, 2]);
		expect(stored.messages[1]).toMatchObject({
			id: result.message_id,
			body: "Only one committed follow-up",
			payload: params.payload,
			artifacts: params.artifacts,
		});
		const events = await createMailboxEventClient({
			relayUrl: relay.baseUrl,
			apiKey: receiverAgent.api_key,
		}).list(null);
		expect(
			events.events
				.filter((event) => event.thread_id === created.thread_id)
				.map((event) => event.kind),
		).toEqual(["thread.created", "message.appended"]);
	});
});
