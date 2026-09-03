import { randomUUID } from "node:crypto";
import { asc, inArray, sql } from "drizzle-orm";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client.js";
import { agents, handoffs, mailboxEvents } from "../db/schema.js";
import { type TestDb, truncateAll, tryConnect } from "../db/test-utils.js";
import { MailboxSignalHub } from "../events/mailbox-signal.js";
import { appendMailboxEvent, listMailboxEvents } from "./mailbox-events.js";

const TEST_URL = process.env.RELAY_TEST_DATABASE_URL ?? process.env.RELAY_DATABASE_URL;
const conn = await tryConnect();
const d = conn.available ? describe : describe.skip;

if (!conn.available) {
	console.warn(`[mailbox-events.test] skipping: ${conn.reason}`);
}

d("mailbox event ledger", () => {
	let handle: TestDb;

	beforeAll(() => {
		if (!conn.handle) throw new Error("expected database handle");
		handle = conn.handle;
	});

	beforeEach(async () => {
		await truncateAll(handle.sql);
	});

	afterAll(async () => {
		if (handle) await handle.close();
	});

	it("replays ordered opaque pages only for the authenticated recipient", async () => {
		const fixture = await seedThread(handle);
		const messageSourceId = randomUUID();
		await handle.db.transaction(async (tx) => {
			await appendMailboxEvent(tx, {
				recipientAgentId: fixture.recipientId,
				actorAgentId: fixture.senderId,
				threadId: fixture.threadId,
				kind: "thread.created",
				sourceId: fixture.threadId,
			});
		});
		await handle.db.transaction(async (tx) => {
			await appendMailboxEvent(tx, {
				recipientAgentId: fixture.recipientId,
				actorAgentId: fixture.senderId,
				threadId: fixture.threadId,
				kind: "message.appended",
				sourceId: messageSourceId,
			});
		});
		await handle.db.transaction(async (tx) => {
			await appendMailboxEvent(tx, {
				recipientAgentId: fixture.senderId,
				actorAgentId: fixture.recipientId,
				threadId: fixture.threadId,
				kind: "thread.accepted",
				sourceId: fixture.threadId,
			});
		});

		const first = await listMailboxEvents(handle.db, {
			recipientAgentId: fixture.recipientId,
			afterCursor: null,
			limit: 1,
		});
		expect(first.events).toHaveLength(1);
		expect(first.events[0]).toEqual({
			event_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
			cursor: expect.stringMatching(/^[1-9][0-9]*$/),
			kind: "thread.created",
			thread_id: fixture.threadId,
			actor_handle: "sender@acme",
			created_at: expect.any(String),
		});
		expect(first.next_cursor).toBe(first.events[0]?.cursor);

		const second = await listMailboxEvents(handle.db, {
			recipientAgentId: fixture.recipientId,
			afterCursor: BigInt(first.next_cursor ?? "0"),
			limit: 10,
		});
		expect(second.events.map((event) => event.kind)).toEqual(["message.appended"]);
		expect(second.next_cursor).toBe(second.events[0]?.cursor);

		const exhausted = await listMailboxEvents(handle.db, {
			recipientAgentId: fixture.recipientId,
			afterCursor: BigInt(second.next_cursor ?? "0"),
			limit: 10,
		});
		expect(exhausted).toEqual({ events: [], next_cursor: second.next_cursor });

		const senderPage = await listMailboxEvents(handle.db, {
			recipientAgentId: fixture.senderId,
			afterCursor: null,
			limit: 10,
		});
		expect(senderPage.events.map((event) => event.kind)).toEqual(["thread.accepted"]);
	});

	it("holds the recipient lock until commit so later cursors cannot overtake", async () => {
		if (!TEST_URL) throw new Error("expected test database URL");
		const fixture = await seedThread(handle);
		const firstSourceId = randomUUID();
		const secondSourceId = randomUUID();
		const firstDb = createDb({ RELAY_DATABASE_URL: TEST_URL, RELAY_DB_POOL_SIZE: 1 });
		const observer = postgres(TEST_URL, { max: 1, onnotice: () => undefined });
		const inserted = deferred<{ pid: number }>();
		const release = deferred<void>();
		let second: Promise<unknown> | undefined;

		const first = firstDb.db.transaction(async (tx) => {
			const event = await appendMailboxEvent(tx, {
				recipientAgentId: fixture.recipientId,
				actorAgentId: fixture.senderId,
				threadId: fixture.threadId,
				kind: "message.appended",
				sourceId: firstSourceId,
			});
			const backend = await tx.execute(sql`SELECT pg_backend_pid()::integer AS pid`);
			inserted.resolve({ pid: Number(backend[0]?.pid) });
			await release.promise;
			return event;
		});

		try {
			const { pid } = await inserted.promise;
			second = handle.db.transaction((tx) =>
				appendMailboxEvent(tx, {
					recipientAgentId: fixture.recipientId,
					actorAgentId: fixture.senderId,
					threadId: fixture.threadId,
					kind: "message.appended",
					sourceId: secondSourceId,
				}),
			);
			await waitForBlockedBy(observer, pid);
			release.resolve(undefined);
			await Promise.all([first, second]);

			const rows = await handle.db
				.select({ cursor: mailboxEvents.cursor, sourceId: mailboxEvents.sourceId })
				.from(mailboxEvents)
				.where(inArray(mailboxEvents.sourceId, [firstSourceId, secondSourceId]))
				.orderBy(asc(mailboxEvents.cursor));
			expect(rows.map((row) => row.sourceId)).toEqual([firstSourceId, secondSourceId]);
			expect(rows[0]?.cursor).toBeLessThan(rows[1]?.cursor ?? 0n);
		} finally {
			release.resolve(undefined);
			await first.catch(() => undefined);
			await second?.catch(() => undefined);
			await observer.end({ timeout: 2 });
			await firstDb.close();
		}
	});

	it("publishes a content-free hint to the committed event recipient", async () => {
		const fixture = await seedThread(handle);
		const hub = new MailboxSignalHub(handle.sql);
		await hub.start();
		const changed = deferred<void>();
		const recipientSignals: string[] = [];
		const senderSignals: string[] = [];
		const unsubscribeRecipient = hub.subscribe(fixture.recipientId, (signal) => {
			recipientSignals.push(signal);
			if (signal === "changed") changed.resolve(undefined);
		});
		const unsubscribeSender = hub.subscribe(fixture.senderId, (signal) => {
			senderSignals.push(signal);
		});

		try {
			await handle.db.transaction((tx) =>
				appendMailboxEvent(tx, {
					recipientAgentId: fixture.recipientId,
					actorAgentId: fixture.senderId,
					threadId: fixture.threadId,
					kind: "thread.created",
					sourceId: fixture.threadId,
				}),
			);
			await withTimeout(changed.promise, 2_000);
			expect(recipientSignals).toEqual(["changed"]);
			expect(senderSignals).toEqual([]);
		} finally {
			unsubscribeRecipient();
			unsubscribeSender();
			await hub.stop();
		}
	});
});

async function seedThread(handle: TestDb): Promise<{
	senderId: string;
	recipientId: string;
	threadId: string;
}> {
	const [sender, recipient] = await handle.db
		.insert(agents)
		.values([
			{
				handle: "sender@acme",
				email: "sender@acme.com",
				displayName: "Sender",
				role: "backend",
			},
			{
				handle: "recipient@acme",
				email: "recipient@acme.com",
				displayName: "Recipient",
				role: "frontend",
			},
		])
		.returning({ id: agents.id });
	if (!sender || !recipient) throw new Error("expected agents");
	const [thread] = await handle.db
		.insert(handoffs)
		.values({ senderId: sender.id, recipientId: recipient.id, summary: "hello" })
		.returning({ id: handoffs.id });
	if (!thread) throw new Error("expected thread");
	return { senderId: sender.id, recipientId: recipient.id, threadId: thread.id };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve = (_value: T): void => undefined;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitForBlockedBy(observer: Sql, blockerPid: number): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const [row] = await observer<Array<{ waiters: string }>>`
			SELECT count(*)::text AS waiters
			FROM pg_stat_activity
			WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
		`;
		if (Number(row?.waiters ?? "0") >= 1) return;
	}
	throw new Error("later mailbox event did not wait on the recipient cursor lock");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("timed out waiting for mailbox hint")),
			timeoutMs,
		);
		promise.then(
			(value) => {
				clearTimeout(timeout);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}
