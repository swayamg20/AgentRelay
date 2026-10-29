import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type DbHandle, createDb } from "../../../relay/dist/db/client.js";
import { TestRelay } from "./harness.js";

describe("notification intent across a production Relay restart", () => {
	let relay: TestRelay;
	let database: DbHandle;

	async function jobs() {
		return [
			...(await database.sql<
				Array<{
					id: string;
					thread_id: string;
					status: string;
					attempts: number;
					encrypted_payload: string | null;
				}>
			>`SELECT * FROM notification_outbox ORDER BY id`),
		];
	}

	beforeAll(async () => {
		const databaseUrl =
			process.env.RELAY_TEST_DATABASE_URL ??
			"postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay";
		relay = await TestRelay.boot({ databaseUrl, port: 18087 });
		database = createDb({ RELAY_DATABASE_URL: databaseUrl, RELAY_DB_POOL_SIZE: 2 });
		await database.sql.unsafe(`
			CREATE FUNCTION test_delay_notification() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN NEW.available_at := now() + interval '1 hour'; RETURN NEW; END $$;
			CREATE TRIGGER test_delay_notification BEFORE INSERT ON notification_outbox
			FOR EACH ROW EXECUTE FUNCTION test_delay_notification();
		`);
	});

	afterAll(async () => {
		await relay?.stop();
		if (database) {
			await database.sql.unsafe(`
				DROP TRIGGER IF EXISTS test_delay_notification ON notification_outbox;
				DROP FUNCTION IF EXISTS test_delay_notification();
			`);
			await database.close();
		}
	});

	it("keeps the committed job and mailbox receipt, then processes due work after restart", async () => {
		const sender = await relay.createAgent({
			handle: "sender@notification",
			email: "sender@notification.test",
			name: "Sender",
			role: "backend",
		});
		const recipient = await relay.createAgent({
			handle: "receiver@notification",
			email: "receiver@notification.test",
			name: "Receiver",
			role: "frontend",
		});
		const parameters = {
			recipient: recipient.handle,
			intent: "inform",
			message: { parts: [{ type: "text", text: "stored before the notification worker runs" }] },
			metadata: { client_idempotency_key: randomUUID() },
		};
		async function send() {
			const response = await fetch(`${relay.baseUrl}/a2a`, {
				method: "POST",
				headers: { authorization: `Bearer ${sender.api_key}`, "content-type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: parameters }),
			});
			expect(response.status).toBe(200);
			return (await response.json()) as { result: { task_id: string; created_at: string } };
		}
		const receipt = await send();
		const [before] = await jobs();
		expect(before).toMatchObject({
			thread_id: receipt.result.task_id,
			status: "pending",
			attempts: 0,
		});
		expect(before?.encrypted_payload).toMatch(/^enc:v1:/);
		await relay.restart();
		expect(await jobs()).toEqual([before]);
		expect(await send()).toEqual(receipt);
		expect(await jobs()).toHaveLength(1);

		const response = await fetch(`${relay.baseUrl}/a2a`, {
			method: "POST",
			headers: { authorization: `Bearer ${recipient.api_key}`, "content-type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tasks/get",
				params: { task_id: receipt.result.task_id },
			}),
		});
		expect(response.status).toBe(200);
		const thread = (await response.json()) as { result: { messages: Array<{ body: string }> } };
		expect(thread.result.messages.map((message) => message.body)).toEqual([
			"stored before the notification worker runs",
		]);
		if (!before) throw new Error("expected job");
		await database.sql`UPDATE notification_outbox SET available_at = now() WHERE id = ${before.id}`;
		await vi.waitFor(
			async () => {
				const [completed] = await jobs();
				expect(completed).toMatchObject({
					id: before.id,
					status: "skipped",
					reason: "no_webhook",
					attempts: 1,
				});
			},
			{ timeout: 5_000 },
		);
	});
});
