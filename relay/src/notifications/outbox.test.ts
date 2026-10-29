import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	agents,
	auditLog,
	handoffs,
	mailboxEvents,
	messages,
	notificationOutbox,
} from "../db/schema.js";
import { type TestDb, truncateAll, tryConnect } from "../db/test-utils.js";
import {
	type CreateHandoffInput,
	appendMessage,
	createHandoff,
	transitionHandoff,
} from "../services/handoff.js";
import { decryptWebhook } from "./crypto.js";

const connection = await tryConnect();
const databaseDescribe = connection.available ? describe : describe.skip;
if (!connection.available) console.warn(`[outbox.test] skipping: ${connection.reason}`);
const context = { encryptionKey: "outbox-test-key", publicUrl: "http://localhost:8080" };

databaseDescribe("mailbox transaction notification intent", () => {
	let handle: TestDb;
	let senderId: string;
	let recipientId: string;

	beforeAll(() => {
		if (!connection.handle) throw new Error("expected database handle");
		handle = connection.handle;
	});
	beforeEach(async () => {
		await truncateAll(handle.sql);
		const [sender, recipient] = await handle.db
			.insert(agents)
			.values([
				{ handle: "bob@acme", email: "bob@acme.test", displayName: "Bob", role: "backend" },
				{ handle: "frank@acme", email: "frank@acme.test", displayName: "Frank", role: "frontend" },
			])
			.returning();
		if (!sender || !recipient) throw new Error("expected agents");
		senderId = sender.id;
		recipientId = recipient.id;
	});
	afterAll(async () => {
		await handle?.close();
	});

	function input(overrides: Partial<CreateHandoffInput> = {}): CreateHandoffInput {
		return {
			senderId,
			recipientHandle: "frank@acme",
			summary: "sensitive initial summary",
			intent: "inform",
			artifacts: [],
			initialPayload: {},
			proposedAction: null,
			metadata: {},
			idempotencyKey: randomUUID(),
			requestId: randomUUID(),
			...overrides,
		};
	}

	async function snapshot() {
		return {
			handoffs: await handle.db.select().from(handoffs).orderBy(asc(handoffs.id)),
			messages: await handle.db.select().from(messages).orderBy(asc(messages.id)),
			audit: await handle.db.select().from(auditLog).orderBy(asc(auditLog.id)),
			events: await handle.db.select().from(mailboxEvents).orderBy(asc(mailboxEvents.cursor)),
			jobs: await handle.db.select().from(notificationOutbox).orderBy(asc(notificationOutbox.id)),
		};
	}

	async function withFailingOutbox(operation: () => Promise<unknown>) {
		await handle.sql.unsafe(`
			CREATE FUNCTION test_reject_notification() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN RAISE EXCEPTION 'notification insert rejected by test'; END $$;
			CREATE TRIGGER test_reject_notification BEFORE INSERT ON notification_outbox
			FOR EACH ROW EXECUTE FUNCTION test_reject_notification();
		`);
		try {
			await expect(operation()).rejects.toThrow();
		} finally {
			await handle.sql.unsafe(`
				DROP TRIGGER test_reject_notification ON notification_outbox;
				DROP FUNCTION test_reject_notification();
			`);
		}
	}

	it("commits encrypted notification intent with creation, initial message, event, and audit", async () => {
		const result = await createHandoff(
			handle.db,
			input({ summary: "private ".repeat(100) }),
			context,
		);
		const state = await snapshot();
		expect(state.handoffs).toHaveLength(1);
		expect(state.messages).toHaveLength(1);
		expect(state.audit).toHaveLength(1);
		expect(state.events).toHaveLength(1);
		expect(state.jobs).toHaveLength(1);
		const job = state.jobs[0];
		expect(job).toMatchObject({
			kind: "notify.handoff.created",
			sourceId: result.handoff.id,
			threadId: result.handoff.id,
			recipientAgentId: recipientId,
			status: "pending",
			attempts: 0,
		});
		expect(JSON.stringify(job)).not.toContain("private");
		const payload = JSON.parse(decryptWebhook(job?.encryptedPayload ?? "", context.encryptionKey));
		expect(payload).toMatchObject({
			senderHandle: "bob@acme",
			senderName: "Bob",
			summary: "private ".repeat(100).slice(0, 240),
		});
	});

	it("rolls back creation, initial message, audit, event, and notification together", async () => {
		const before = await snapshot();
		await withFailingOutbox(() => createHandoff(handle.db, input(), context));
		expect(await snapshot()).toEqual(before);
	});

	it("rolls back an append if its notification insert fails", async () => {
		const { handoff } = await createHandoff(handle.db, input(), context);
		const before = await snapshot();
		await withFailingOutbox(() =>
			appendMessage(
				handle.db,
				{
					senderId: recipientId,
					taskId: handoff.id,
					body: "reply",
					payload: {},
					artifacts: [],
					idempotencyKey: randomUUID(),
					requestId: randomUUID(),
				},
				context,
			),
		);
		expect(await snapshot()).toEqual(before);
	});

	it("rolls back completion and its audit and event if notification persistence fails", async () => {
		const { handoff } = await createHandoff(handle.db, input(), context);
		await transitionHandoff(
			handle.db,
			{
				taskId: handoff.id,
				callerId: recipientId,
				transition: "accept",
				requestId: randomUUID(),
			},
			context,
		);
		const before = await snapshot();
		await withFailingOutbox(() =>
			transitionHandoff(
				handle.db,
				{
					taskId: handoff.id,
					callerId: recipientId,
					transition: "complete",
					resultSummary: "done",
					requestId: randomUUID(),
				},
				context,
			),
		);
		expect(await snapshot()).toEqual(before);
	});

	it("idempotent create and append replay do not create duplicate notification jobs", async () => {
		const creation = input();
		const first = await createHandoff(handle.db, creation, context);
		expect((await createHandoff(handle.db, creation, context)).replayed).toBe(true);
		const append = {
			senderId: recipientId,
			taskId: first.handoff.id,
			body: "reply",
			payload: {},
			artifacts: [],
			idempotencyKey: randomUUID(),
			requestId: randomUUID(),
		};
		const appended = await appendMessage(handle.db, append, context);
		expect((await appendMessage(handle.db, append, context)).replayed).toBe(true);
		const state = await snapshot();
		expect(state.jobs).toHaveLength(2);
		expect(state.jobs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "notify.handoff.created",
					recipientAgentId: recipientId,
					sourceId: first.handoff.id,
				}),
				expect.objectContaining({
					kind: "notify.message.appended",
					recipientAgentId: senderId,
					sourceId: appended.messageId,
				}),
			]),
		);
		await expect(
			createHandoff(handle.db, { ...creation, summary: "different" }, context),
		).rejects.toMatchObject({ code: "duplicate_idempotency_key" });
		expect(await snapshot()).toEqual(state);
	});

	it("routes completion to the sender, while acceptance stays silent", async () => {
		const { handoff } = await createHandoff(handle.db, input(), context);
		await transitionHandoff(
			handle.db,
			{
				taskId: handoff.id,
				callerId: recipientId,
				transition: "accept",
				requestId: randomUUID(),
			},
			context,
		);
		expect((await snapshot()).jobs).toHaveLength(1);
		await transitionHandoff(
			handle.db,
			{
				taskId: handoff.id,
				callerId: recipientId,
				transition: "complete",
				requestId: randomUUID(),
			},
			context,
		);
		const state = await snapshot();
		expect(state.jobs).toHaveLength(2);
		expect(state.jobs).toContainEqual(
			expect.objectContaining({
				kind: "notify.handoff.completed",
				recipientAgentId: senderId,
				sourceId: handoff.id,
			}),
		);
		const before = await snapshot();
		await expect(
			transitionHandoff(
				handle.db,
				{
					taskId: handoff.id,
					callerId: recipientId,
					transition: "complete",
					requestId: randomUUID(),
				},
				context,
			),
		).rejects.toMatchObject({ code: "invalid_transition" });
		expect(await snapshot()).toEqual(before);
	});

	it("preserves silent pending cancellation and forbids cancelling accepted handoffs", async () => {
		const { handoff } = await createHandoff(handle.db, input(), context);
		await transitionHandoff(
			handle.db,
			{
				taskId: handoff.id,
				callerId: senderId,
				transition: "cancel",
				requestId: randomUUID(),
			},
			context,
		);
		expect((await snapshot()).jobs).toHaveLength(1);
		const second = await createHandoff(handle.db, input(), context);
		await transitionHandoff(
			handle.db,
			{
				taskId: second.handoff.id,
				callerId: recipientId,
				transition: "accept",
				requestId: randomUUID(),
			},
			context,
		);
		const before = await snapshot();
		await expect(
			transitionHandoff(
				handle.db,
				{
					taskId: second.handoff.id,
					callerId: senderId,
					transition: "cancel",
					requestId: randomUUID(),
				},
				context,
			),
		).rejects.toMatchObject({ code: "invalid_transition" });
		expect(await snapshot()).toEqual(before);
	});

	it("unauthorized mutations do not add notification jobs", async () => {
		const { handoff } = await createHandoff(handle.db, input(), context);
		const before = await snapshot();
		await expect(
			transitionHandoff(
				handle.db,
				{
					taskId: handoff.id,
					callerId: senderId,
					transition: "accept",
					requestId: randomUUID(),
				},
				context,
			),
		).rejects.toMatchObject({ code: "not_authorized_transition" });
		expect(await snapshot()).toEqual(before);
		await handle.db.update(agents).set({ status: "disabled" }).where(eq(agents.id, recipientId));
		await expect(createHandoff(handle.db, input(), context)).rejects.toMatchObject({
			code: "recipient_not_found",
		});
		expect(await snapshot()).toEqual(before);
	});
});
