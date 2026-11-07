import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentCards, agents, notificationOutbox } from "../db/schema.js";
import { type TestDb, truncateAll, tryConnect } from "../db/test-utils.js";
import { createLogger } from "../logger.js";
import { createHandoff } from "../services/handoff.js";
import { decryptWebhook, encryptWebhook } from "./crypto.js";
import { NotificationDispatcher } from "./dispatcher.js";
import type { SlackPostResult, SlackPoster } from "./slack.js";

const connection = await tryConnect();
const databaseDescribe = connection.available ? describe : describe.skip;
if (!connection.available) console.warn(`[dispatcher.test] skipping: ${connection.reason}`);

const ENCRYPTION_KEY = "notification-test-key";
const WEBHOOK = "https://hooks.slack.com/services/T000/B000/secret-token";
const logger = createLogger({ RELAY_LOG_LEVEL: "fatal", RELAY_ENV: "dev" });
const context = { encryptionKey: ENCRYPTION_KEY, publicUrl: "http://localhost:8080" };

function deferred<Value>() {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

databaseDescribe("durable notification dispatcher", () => {
	let handle: TestDb;

	beforeAll(() => {
		if (!connection.handle) throw new Error("expected database handle");
		handle = connection.handle;
	});
	beforeEach(async () => {
		await truncateAll(handle.sql);
	});
	afterAll(async () => {
		await handle?.close();
	});

	async function enqueue(webhook: string | null = WEBHOOK) {
		const [sender, recipient] = await handle.db
			.insert(agents)
			.values([
				{ handle: "bob@acme", email: "bob@acme.test", displayName: "Bob", role: "backend" },
				{ handle: "frank@acme", email: "frank@acme.test", displayName: "Frank", role: "frontend" },
			])
			.returning();
		if (!sender || !recipient) throw new Error("expected agents");
		await handle.db.insert(agentCards).values({
			agentId: recipient.id,
			card: {},
			notificationWebhookUrl: webhook ? encryptWebhook(webhook, ENCRYPTION_KEY) : null,
		});
		const result = await createHandoff(
			handle.db,
			{
				senderId: sender.id,
				recipientHandle: recipient.handle,
				summary: "sensitive mailbox summary",
				intent: "inform",
				artifacts: [],
				initialPayload: {},
				proposedAction: null,
				metadata: {},
				idempotencyKey: null,
				requestId: randomUUID(),
			},
			context,
		);
		const [job] = await handle.db.select().from(notificationOutbox);
		if (!job) throw new Error("expected notification job");
		return { job, recipient, thread: result.handoff };
	}

	function worker(responses: Array<SlackPostResult | Error> = [{ status: 200, ok: true }]) {
		const poster = vi.fn<SlackPoster>(async () => {
			const response = responses.shift();
			if (response instanceof Error) throw response;
			if (!response) throw new Error("no scripted response");
			return response;
		});
		return {
			poster,
			dispatcher: new NotificationDispatcher({
				db: handle.db,
				encryptionKey: ENCRYPTION_KEY,
				logger,
				slackPoster: poster,
				backoffSchedule: [0, 0, 0],
				pollIntervalMs: 10,
			}),
		};
	}

	async function stored(jobId: string) {
		const [job] = await handle.db
			.select()
			.from(notificationOutbox)
			.where(eq(notificationOutbox.id, jobId));
		if (!job) throw new Error("expected stored job");
		return job;
	}

	async function makeDue(jobId: string) {
		await handle.db
			.update(notificationOutbox)
			.set({ availableAt: sql`now() - interval '1 second'` })
			.where(eq(notificationOutbox.id, jobId));
	}

	async function expireLease(jobId: string) {
		await handle.db
			.update(notificationOutbox)
			.set({ leaseExpiresAt: sql`now() - interval '1 second'` })
			.where(eq(notificationOutbox.id, jobId));
	}

	it("skips a missing webhook without affecting the mailbox", async () => {
		const { job } = await enqueue(null);
		const { dispatcher, poster } = worker([]);
		expect(await dispatcher.processDueJob()).toBe(true);
		expect(await stored(job.id)).toMatchObject({
			status: "skipped",
			reason: "no_webhook",
			attempts: 1,
		});
		expect(poster).not.toHaveBeenCalled();
	});

	it("posts the encrypted preview once and clears terminal payloads", async () => {
		const { job } = await enqueue();
		expect(job.encryptedPayload).toMatch(/^enc:v1:/);
		expect(job.encryptedPayload).not.toContain("sensitive mailbox summary");
		const { dispatcher, poster } = worker();
		expect(await dispatcher.processDueJob()).toBe(true);
		expect(await dispatcher.processDueJob()).toBe(false);
		expect(poster).toHaveBeenCalledWith(
			WEBHOOK,
			expect.objectContaining({ blocks: expect.any(Array) }),
			expect.any(AbortSignal),
		);
		expect(await stored(job.id)).toMatchObject({
			status: "succeeded",
			attempts: 1,
			lastStatus: 200,
			encryptedPayload: null,
			leaseToken: null,
			leaseExpiresAt: null,
			terminalAt: expect.any(Date),
		});
	});

	it("persists bounded 5xx retry attempts and eventually succeeds", async () => {
		const { job } = await enqueue();
		const { dispatcher, poster } = worker([
			{ status: 503, ok: false },
			{ status: 503, ok: false },
			{ status: 200, ok: true },
		]);
		await dispatcher.processDueJob();
		expect(await stored(job.id)).toMatchObject({ status: "pending", attempts: 1, lastStatus: 503 });
		await dispatcher.processDueJob();
		await dispatcher.processDueJob();
		expect(await stored(job.id)).toMatchObject({ status: "succeeded", attempts: 3 });
		expect(poster).toHaveBeenCalledTimes(3);
	});

	it("uses the 1s, 4s, 16s backoff schedule without holding a lease while waiting", async () => {
		const { job } = await enqueue();
		const dispatcher = new NotificationDispatcher({
			db: handle.db,
			encryptionKey: ENCRYPTION_KEY,
			logger,
			slackPoster: async () => ({ status: 503, ok: false }),
		});
		for (const milliseconds of [1_000, 4_000, 16_000]) {
			const before = Date.now();
			await dispatcher.processDueJob();
			const pending = await stored(job.id);
			expect(pending).toMatchObject({ status: "pending", leaseToken: null, leaseExpiresAt: null });
			expect(pending.availableAt.getTime() - before).toBeGreaterThanOrEqual(milliseconds - 50);
			expect(pending.availableAt.getTime() - Date.now()).toBeLessThanOrEqual(milliseconds);
			expect(await dispatcher.processDueJob()).toBe(false);
			await makeDue(job.id);
		}
	});

	it("fails after four claims and never issues a fifth provider attempt", async () => {
		const { job } = await enqueue();
		const { dispatcher, poster } = worker(
			Array.from({ length: 4 }, () => ({ status: 503, ok: false })),
		);
		for (let attempt = 0; attempt < 4; attempt += 1) await dispatcher.processDueJob();
		expect(await stored(job.id)).toMatchObject({
			status: "failed",
			reason: "max_attempts",
			attempts: 4,
		});
		expect(await dispatcher.processDueJob()).toBe(false);
		expect(poster).toHaveBeenCalledTimes(4);
	});

	it.each([400, 401, 403, 404])("does not retry permanent HTTP %s", async (status) => {
		const { job } = await enqueue();
		const { dispatcher, poster } = worker([{ status, ok: false }]);
		await dispatcher.processDueJob();
		expect(await stored(job.id)).toMatchObject({
			status: "failed",
			reason: "permanent_http",
			attempts: 1,
		});
		expect(await dispatcher.processDueJob()).toBe(false);
		expect(poster).toHaveBeenCalledTimes(1);
	});

	it("persists Retry-After and the one-rate-limit-retry budget across reconstruction", async () => {
		const { job } = await enqueue();
		const first = worker([{ status: 429, ok: false, retryAfterSeconds: 12 }]);
		const before = Date.now();
		await first.dispatcher.processDueJob();
		const pending = await stored(job.id);
		expect(pending).toMatchObject({
			status: "pending",
			attempts: 1,
			rateLimitRetried: true,
			lastStatus: 429,
		});
		expect(pending.availableAt.getTime() - before).toBeGreaterThanOrEqual(11_950);
		const second = worker([{ status: 429, ok: false, retryAfterSeconds: 12 }]);
		expect(await second.dispatcher.processDueJob()).toBe(false);
		await makeDue(job.id);
		await second.dispatcher.processDueJob();
		expect(await stored(job.id)).toMatchObject({
			status: "failed",
			reason: "rate_limited",
			attempts: 2,
		});
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
		"normalizes invalid Retry-After %s",
		async (seconds) => {
			const { job } = await enqueue();
			const { dispatcher } = worker([{ status: 429, ok: false, retryAfterSeconds: seconds }]);
			const before = Date.now();
			await dispatcher.processDueJob();
			const pending = await stored(job.id);
			expect(pending.availableAt.getTime() - before).toBeGreaterThanOrEqual(950);
			expect(pending.availableAt.getTime() - Date.now()).toBeLessThanOrEqual(1_000);
		},
	);

	it("caps an excessive Retry-After at one day", async () => {
		const { job } = await enqueue();
		const { dispatcher } = worker([{ status: 429, ok: false, retryAfterSeconds: 1e20 }]);
		await dispatcher.processDueJob();
		expect((await stored(job.id)).availableAt.getTime() - Date.now()).toBeLessThanOrEqual(
			86_400_000,
		);
	});

	it("two workers cannot own the same live attempt", async () => {
		const { job } = await enqueue();
		let releasePost: (result: SlackPostResult) => void = () => {};
		const entered = deferred<void>();
		const first = new NotificationDispatcher({
			db: handle.db,
			encryptionKey: ENCRYPTION_KEY,
			logger,
			slackPoster: () => {
				entered.resolve();
				return new Promise((resolve) => {
					releasePost = resolve;
				});
			},
		});
		const second = worker();
		const inFlight = first.processDueJob();
		await entered.promise;
		expect(await second.dispatcher.claimDueJob()).toBeNull();
		expect(await stored(job.id)).toMatchObject({ status: "leased", attempts: 1 });
		releasePost({ status: 200, ok: true });
		await inFlight;
		expect(second.poster).not.toHaveBeenCalled();
	});

	it("concurrent claims assign distinct jobs without waiting on locked work", async () => {
		const { job } = await enqueue();
		await handle.db.insert(notificationOutbox).values({
			recipientAgentId: job.recipientAgentId,
			threadId: job.threadId,
			kind: job.kind,
			sourceId: randomUUID(),
			encryptedPayload: job.encryptedPayload,
		});
		const [first, second] = await Promise.all([
			worker().dispatcher.claimDueJob(),
			worker().dispatcher.claimDueJob(),
		]);
		expect(first?.id).not.toBe(second?.id);
		expect(first?.leaseToken).not.toBe(second?.leaseToken);
		expect(first?.status).toBe("leased");
		expect(second?.status).toBe("leased");
	});

	it("reclaims a dead worker's expired lease with a new token", async () => {
		const { job } = await enqueue();
		const claim = await worker().dispatcher.claimDueJob();
		expect(claim?.leaseExpiresAt).toBeInstanceOf(Date);
		expect(await worker().dispatcher.claimDueJob()).toBeNull();
		await expireLease(job.id);
		const recovered = await worker().dispatcher.claimDueJob();
		expect(recovered).toMatchObject({ id: job.id, attempts: 2, status: "leased" });
		expect(recovered?.leaseToken).not.toBe(claim?.leaseToken);
	});

	it("fences a late response from a replaced lease holder", async () => {
		const { job } = await enqueue();
		const entered = deferred<void>();
		const response = deferred<SlackPostResult>();
		const first = new NotificationDispatcher({
			db: handle.db,
			encryptionKey: ENCRYPTION_KEY,
			logger,
			slackPoster: () => {
				entered.resolve();
				return response.promise;
			},
		});
		const pending = first.processDueJob();
		await entered.promise;
		await expireLease(job.id);
		await worker().dispatcher.processDueJob();
		const completed = await stored(job.id);
		response.resolve({ status: 503, ok: false });
		await pending;
		expect(await stored(job.id)).toEqual(completed);
	});

	it("settles a dead fourth claim without a fifth external attempt", async () => {
		const { job } = await enqueue();
		for (let attempt = 0; attempt < 4; attempt += 1) {
			await worker().dispatcher.claimDueJob();
			await expireLease(job.id);
		}
		const { dispatcher, poster } = worker();
		await dispatcher.processDueJob();
		expect(await stored(job.id)).toMatchObject({
			status: "failed",
			attempts: 4,
			reason: "max_attempts",
		});
		expect(poster).not.toHaveBeenCalled();
	});

	it("allows an at-least-once duplicate after a lost provider response", async () => {
		const { job } = await enqueue();
		let deliveries = 0;
		const first = new NotificationDispatcher({
			db: handle.db,
			encryptionKey: ENCRYPTION_KEY,
			logger,
			backoffSchedule: [0, 0, 0],
			slackPoster: async () => {
				deliveries += 1;
				throw new Error("response lost after delivery");
			},
		});
		await first.processDueJob();
		const second = new NotificationDispatcher({
			db: handle.db,
			encryptionKey: ENCRYPTION_KEY,
			logger,
			slackPoster: async () => {
				deliveries += 1;
				return { status: 200, ok: true };
			},
		});
		await second.processDueJob();
		expect(deliveries).toBe(2);
		expect(await stored(job.id)).toMatchObject({ status: "succeeded", attempts: 2 });
	});

	it.each(["corrupt", "invalid_json", "invalid_shape", "wrong_identity"])(
		"quarantines %s poison payloads",
		async (kind) => {
			const { job } = await enqueue();
			let encryptedPayload = "not encrypted";
			if (kind === "invalid_json") encryptedPayload = encryptWebhook("not json", ENCRYPTION_KEY);
			if (kind === "invalid_shape")
				encryptedPayload = encryptWebhook('{"kind":"execute"}', ENCRYPTION_KEY);
			if (kind === "wrong_identity") {
				const payload = JSON.parse(decryptWebhook(job.encryptedPayload ?? "", ENCRYPTION_KEY));
				encryptedPayload = encryptWebhook(
					JSON.stringify({ ...payload, recipientAgentId: randomUUID() }),
					ENCRYPTION_KEY,
				);
			}
			await handle.db
				.update(notificationOutbox)
				.set({ encryptedPayload })
				.where(eq(notificationOutbox.id, job.id));
			const { dispatcher, poster } = worker();
			await dispatcher.processDueJob();
			expect(await stored(job.id)).toMatchObject({
				status: "failed",
				reason: "invalid_payload",
				encryptedPayload: null,
			});
			expect(poster).not.toHaveBeenCalled();
		},
	);

	it("a poison job does not block the next healthy job", async () => {
		const { job } = await enqueue();
		await handle.db.insert(notificationOutbox).values({
			recipientAgentId: job.recipientAgentId,
			threadId: job.threadId,
			kind: job.kind,
			sourceId: randomUUID(),
			encryptedPayload: job.encryptedPayload,
		});
		await handle.db
			.update(notificationOutbox)
			.set({ encryptedPayload: "poison" })
			.where(eq(notificationOutbox.id, job.id));
		const { dispatcher, poster } = worker();
		await dispatcher.processDueJob();
		await dispatcher.processDueJob();
		expect(poster).toHaveBeenCalledTimes(1);
	});

	it.each([
		"https://127.0.0.1/internal/metadata",
		"https://hooks.slack.com.evil.test/services/T/B/secret",
	])("revalidates the Slack allowlist at send time for %s", async (webhook) => {
		const { job } = await enqueue(webhook);
		const { dispatcher, poster } = worker();
		await dispatcher.processDueJob();
		expect(await stored(job.id)).toMatchObject({ status: "failed", reason: "invalid_webhook" });
		expect(poster).not.toHaveBeenCalled();
	});

	it("fails closed on undecryptable stored webhook values", async () => {
		const { job, recipient } = await enqueue();
		await handle.db
			.update(agentCards)
			.set({ notificationWebhookUrl: WEBHOOK })
			.where(eq(agentCards.agentId, recipient.id));
		const { dispatcher, poster } = worker();
		await dispatcher.processDueJob();
		expect(await stored(job.id)).toMatchObject({ status: "failed", reason: "decrypt_failed" });
		expect(poster).not.toHaveBeenCalled();
	});

	it("uses the current webhook and honors its removal before dispatch", async () => {
		const { job, recipient } = await enqueue();
		await handle.db
			.update(agentCards)
			.set({ notificationWebhookUrl: null })
			.where(eq(agentCards.agentId, recipient.id));
		const { dispatcher, poster } = worker();
		await dispatcher.processDueJob();
		expect(await stored(job.id)).toMatchObject({ status: "skipped", reason: "no_webhook" });
		expect(poster).not.toHaveBeenCalled();
	});

	it("does not post for a disabled recipient", async () => {
		const { job, recipient } = await enqueue();
		await handle.db.update(agents).set({ status: "disabled" }).where(eq(agents.id, recipient.id));
		const { dispatcher, poster } = worker();
		await dispatcher.processDueJob();
		expect(await stored(job.id)).toMatchObject({ status: "skipped" });
		expect(poster).not.toHaveBeenCalled();
	});

	it("keeps over 10,000 jobs durable while claiming only one at a time", async () => {
		const { job } = await enqueue();
		await handle.sql`
			INSERT INTO notification_outbox (recipient_agent_id, thread_id, kind, source_id, encrypted_payload)
			SELECT ${job.recipientAgentId}, ${job.threadId}, ${job.kind}, gen_random_uuid(), ${job.encryptedPayload}
			FROM generate_series(1, 10000)
		`;
		const { dispatcher } = worker();
		await dispatcher.claimDueJob();
		const counts =
			await handle.sql`SELECT status, count(*)::integer AS count FROM notification_outbox GROUP BY status`;
		expect(counts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ status: "leased", count: 1 }),
				expect.objectContaining({ status: "pending", count: 10000 }),
			]),
		);
	});

	it("cleans only old terminal jobs in bounded batches", async () => {
		const { job } = await enqueue();
		await handle.sql`
			INSERT INTO notification_outbox (recipient_agent_id, thread_id, kind, source_id, status, terminal_at)
			SELECT ${job.recipientAgentId}, ${job.threadId}, ${job.kind}, gen_random_uuid(), 'succeeded', now() - interval '8 days'
			FROM generate_series(1, 105)
		`;
		await handle.sql`
			INSERT INTO notification_outbox (recipient_agent_id, thread_id, kind, source_id, status, terminal_at)
			VALUES (${job.recipientAgentId}, ${job.threadId}, ${job.kind}, gen_random_uuid(), 'failed', now())
		`;
		const { dispatcher } = worker();
		expect(await dispatcher.cleanupTerminalJobs()).toBe(100);
		expect(await dispatcher.cleanupTerminalJobs()).toBe(5);
		expect(await dispatcher.cleanupTerminalJobs()).toBe(0);
		expect(await stored(job.id)).toMatchObject({ status: "pending" });
		expect(await handle.db.select().from(notificationOutbox)).toHaveLength(2);
	});

	it("logs identifiers and safe outcomes, never provider errors or payloads", async () => {
		const { job } = await enqueue();
		let logs = "";
		const capturingLogger = createLogger(
			{ RELAY_LOG_LEVEL: "debug", RELAY_ENV: "dev" },
			{
				write: (line: string) => {
					logs += line;
				},
			},
		);
		const dispatcher = new NotificationDispatcher({
			db: handle.db,
			encryptionKey: ENCRYPTION_KEY,
			logger: capturingLogger,
			backoffSchedule: [0, 0, 0],
			slackPoster: async () => {
				throw new Error(`${WEBHOOK} sensitive mailbox summary`);
			},
		});
		for (let attempt = 0; attempt < 4; attempt += 1) await dispatcher.processDueJob();
		expect(logs).toContain(job.id);
		expect(logs).toContain("max_attempts");
		expect(logs).not.toContain(WEBHOOK);
		expect(logs).not.toContain("secret-token");
		expect(logs).not.toContain("sensitive mailbox summary");
		expect(logs).not.toContain(job.encryptedPayload);
	});

	it("aborts a hung provider request and persists a retry without waiting for lease expiry", async () => {
		const { job } = await enqueue();
		let aborted = false;
		const dispatcher = new NotificationDispatcher({
			db: handle.db,
			encryptionKey: ENCRYPTION_KEY,
			logger,
			slackPoster: async (_url, _payload, signal) =>
				new Promise<never>((_resolve, reject) => {
					signal?.addEventListener("abort", () => {
						aborted = true;
						reject(new Error("aborted"));
					});
				}),
		});
		await dispatcher.processDueJob();
		expect(aborted).toBe(true);
		expect(await stored(job.id)).toMatchObject({
			status: "pending",
			attempts: 1,
			leaseToken: null,
		});
	}, 10_000);

	it("a failed database settlement leaves work leased for recovery, not a false provider failure", async () => {
		const { job } = await enqueue();
		await handle.sql.unsafe(`
			CREATE FUNCTION test_reject_notification_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN IF NEW.status = 'succeeded' THEN RAISE EXCEPTION 'settlement rejected by test'; END IF;
			RETURN NEW; END $$;
			CREATE TRIGGER test_reject_notification_settlement BEFORE UPDATE ON notification_outbox
			FOR EACH ROW EXECUTE FUNCTION test_reject_notification_settlement();
		`);
		const { dispatcher, poster } = worker();
		try {
			await expect(dispatcher.processDueJob()).rejects.toThrow();
			expect(await stored(job.id)).toMatchObject({ status: "leased", attempts: 1, reason: null });
		} finally {
			await handle.sql.unsafe(`
				DROP TRIGGER test_reject_notification_settlement ON notification_outbox;
				DROP FUNCTION test_reject_notification_settlement();
			`);
		}
		expect(poster).toHaveBeenCalledTimes(1);
		await expireLease(job.id);
		await worker().dispatcher.processDueJob();
		expect(await stored(job.id)).toMatchObject({ status: "succeeded", attempts: 2 });
	});

	it("the running worker finds database jobs without a process-local enqueue", async () => {
		const { dispatcher } = worker();
		dispatcher.start();
		try {
			const { job } = await enqueue();
			await vi.waitFor(async () => {
				expect((await stored(job.id)).status).toBe("succeeded");
			});
		} finally {
			await dispatcher.stop();
		}
		dispatcher.start();
		await dispatcher.stop();
	});
});
