import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { type MailboxEvent, agents, mailboxEvents } from "../db/schema.js";
import { RelayError } from "../errors.js";

export const MAILBOX_EVENT_NOTIFY_CHANNEL = "agentrelay_mailbox_events";

export const MAILBOX_EVENT_KINDS = [
	"thread.created",
	"message.appended",
	"thread.accepted",
	"thread.completed",
	"thread.cancelled",
] as const;

export type MailboxEventKind = (typeof MAILBOX_EVENT_KINDS)[number];

export interface AppendMailboxEventInput {
	recipientAgentId: string;
	actorAgentId: string;
	threadId: string;
	kind: MailboxEventKind;
	sourceId: string;
}

export interface ListMailboxEventsInput {
	recipientAgentId: string;
	afterCursor: bigint | null;
	limit: number;
}

export interface MailboxEventPage {
	events: Array<{
		event_id: string;
		cursor: string;
		kind: MailboxEventKind;
		thread_id: string;
		actor_handle: string;
		created_at: string;
	}>;
	next_cursor: string | null;
}

export async function appendMailboxEvent(
	// biome-ignore lint/suspicious/noExplicitAny: Drizzle transactions share this SQL execution surface
	tx: any,
	input: AppendMailboxEventInput,
): Promise<MailboxEvent> {
	// A global sequence alone can be allocated out of commit order. Serializing
	// allocation per recipient makes a replay checkpoint safe for that mailbox.
	const lockKey = `agentrelay:mailbox-events:${input.recipientAgentId}`;
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}::text, 0))`);

	const [event] = await tx
		.insert(mailboxEvents)
		.values({
			recipientAgentId: input.recipientAgentId,
			actorAgentId: input.actorAgentId,
			threadId: input.threadId,
			kind: input.kind,
			sourceId: input.sourceId,
		})
		.returning();
	if (!event) throw new RelayError("internal", "Failed to append mailbox event");

	// PostgreSQL emits this only if the surrounding transaction commits. The
	// payload is a routing hint; consumers still replay the durable table.
	await tx.execute(
		sql`SELECT pg_notify(${MAILBOX_EVENT_NOTIFY_CHANNEL}, ${input.recipientAgentId})`,
	);
	return event;
}

export async function listMailboxEvents(
	db: Database,
	input: ListMailboxEventsInput,
): Promise<MailboxEventPage> {
	const conditions = [eq(mailboxEvents.recipientAgentId, input.recipientAgentId)];
	if (input.afterCursor !== null) {
		conditions.push(gt(mailboxEvents.cursor, input.afterCursor));
	}

	const rows = await db
		.select({
			id: mailboxEvents.id,
			cursor: mailboxEvents.cursor,
			kind: mailboxEvents.kind,
			threadId: mailboxEvents.threadId,
			actorHandle: agents.handle,
			createdAt: mailboxEvents.createdAt,
		})
		.from(mailboxEvents)
		.innerJoin(agents, eq(agents.id, mailboxEvents.actorAgentId))
		.where(and(...conditions))
		.orderBy(asc(mailboxEvents.cursor))
		.limit(input.limit);

	const events = rows.map((row) => ({
		event_id: row.id,
		cursor: row.cursor.toString(),
		kind: row.kind as MailboxEventKind,
		thread_id: row.threadId,
		actor_handle: row.actorHandle,
		created_at: row.createdAt.toISOString(),
	}));
	return {
		events,
		next_cursor:
			events.at(-1)?.cursor ?? (input.afterCursor === null ? null : input.afterCursor.toString()),
	};
}
