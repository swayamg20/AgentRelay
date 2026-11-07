import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, gt, gte, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { agents, shareEvents, shareLinks, shareReplies } from "../db/schema.js";
import { RelayError } from "../errors.js";
import {
	type CreateShareInput,
	SHARE_CONTENT_BYTES,
	type ShareAnswerInput,
	type ShareInboxInput,
	type ShareReplyInput,
} from "../share-schemas.js";
import { writeAudit } from "./audit.js";
import { lockAgentLifecycle } from "./node-enrollment.js";

type ShareTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type ShareLink = typeof shareLinks.$inferSelect;

function requireActive(link: ShareLink): void {
	if (link.revokedAt || link.contentDeletedAt || link.expiresAt.getTime() <= Date.now()) {
		throw new RelayError("thread_not_found", "Link unavailable");
	}
}

async function lockOwnerLink(transaction: ShareTransaction, senderId: string, publicId: string) {
	await lockAgentLifecycle(transaction, senderId);
	const [sender] = await transaction
		.select({ id: agents.id })
		.from(agents)
		.where(and(eq(agents.id, senderId), eq(agents.status, "active")));
	if (!sender) throw new RelayError("forbidden", "Sender unavailable");
	const [link] = await transaction
		.select()
		.from(shareLinks)
		.where(and(eq(shareLinks.publicId, publicId), eq(shareLinks.senderId, senderId)))
		.for("update");
	if (!link) throw new RelayError("thread_not_found", "Link unavailable");
	return link;
}

async function lockPublicLink(transaction: ShareTransaction, publicId: string) {
	const [owner] = await transaction
		.select({ senderId: shareLinks.senderId })
		.from(shareLinks)
		.where(eq(shareLinks.publicId, publicId));
	if (!owner) throw new RelayError("thread_not_found", "Link unavailable");
	await lockAgentLifecycle(transaction, owner.senderId);
	const [row] = await transaction
		.select({ link: shareLinks, companyDomain: agents.companyDomain })
		.from(shareLinks)
		.innerJoin(agents, eq(agents.id, shareLinks.senderId))
		.where(and(eq(shareLinks.publicId, publicId), eq(agents.status, "active")))
		.for("update", { of: shareLinks });
	if (!row) throw new RelayError("thread_not_found", "Link unavailable");
	requireActive(row.link);
	return row;
}

export function shareReceipt(link: ShareLink) {
	return {
		link_id: link.publicId,
		expires_at: link.expiresAt.toISOString(),
		revoked_at: link.revokedAt?.toISOString() ?? null,
		content_deleted_at: link.contentDeletedAt?.toISOString() ?? null,
	};
}

export async function createShare(
	db: Database,
	senderId: string,
	input: CreateShareInput,
	requestId: string,
) {
	return db.transaction(async (transaction) => {
		await lockAgentLifecycle(transaction, senderId);
		const [sender] = await transaction
			.select({ id: agents.id })
			.from(agents)
			.where(and(eq(agents.id, senderId), eq(agents.status, "active")));
		if (!sender) throw new RelayError("forbidden", "Sender unavailable");
		const [existing] = await transaction
			.select()
			.from(shareLinks)
			.where(
				and(
					eq(shareLinks.senderId, senderId),
					eq(shareLinks.idempotencyKey, input.idempotency_key),
				),
			);
		if (existing) {
			const days = (existing.expiresAt.getTime() - existing.createdAt.getTime()) / 86_400_000;
			if (existing.content !== input.content || days !== input.expires_in_days) {
				throw new RelayError("duplicate_idempotency_key", "Creation key already used");
			}
			return { ...shareReceipt(existing), replayed: true };
		}
		const now = new Date();
		const [link] = await transaction
			.insert(shareLinks)
			.values({
				publicId: randomBytes(32).toString("base64url"),
				senderId,
				content: input.content,
				idempotencyKey: input.idempotency_key,
				createdAt: now,
				expiresAt: new Date(now.getTime() + input.expires_in_days * 86_400_000),
			})
			.returning();
		if (!link) throw new Error("share insert returned no row");
		await transaction.insert(shareEvents).values({
			linkId: link.id,
			kind: "link.created",
			actorKind: "agent",
			actorAgentId: senderId,
		});
		await writeAudit(transaction, {
			actorId: senderId,
			action: "link.created",
			resourceType: "share_link",
			resourceId: link.id,
			requestId,
		});
		return { ...shareReceipt(link), replayed: false };
	});
}

export async function fetchShare(
	db: Database,
	publicId: string,
	format: "html" | "markdown",
	knownBot: boolean,
) {
	return db.transaction(async (transaction) => {
		const { link, companyDomain } = await lockPublicLink(transaction, publicId);
		const answers = await transaction
			.select({ content: shareReplies.content, seq: shareReplies.seq })
			.from(shareReplies)
			.where(and(eq(shareReplies.linkId, link.id), eq(shareReplies.authorKind, "sender")))
			.orderBy(asc(shareReplies.seq));
		await transaction.insert(shareEvents).values({
			linkId: link.id,
			kind: "link.fetched",
			actorKind: "external",
			metadata: { format, known_bot: knownBot },
		});
		return {
			content: link.content ?? "",
			answers: answers.filter((answer) => answer.content !== null),
			companyDomain,
			expiresAt: link.expiresAt.toISOString(),
		};
	});
}

export async function postShareReply(
	db: Database,
	publicId: string,
	input: ShareReplyInput,
	channel: "api" | "form",
	requestId: string,
) {
	return db.transaction(async (transaction) => {
		const { link } = await lockPublicLink(transaction, publicId);
		const key = input.idempotency_key ?? randomUUID();
		const replies = await transaction
			.select()
			.from(shareReplies)
			.where(eq(shareReplies.linkId, link.id))
			.orderBy(asc(shareReplies.seq));
		const existing = replies.find(
			(reply) => reply.authorKind === "external" && reply.idempotencyKey === key,
		);
		if (existing) {
			if (existing.content !== input.content || existing.channel !== channel) {
				throw new RelayError("duplicate_idempotency_key", "Reply key already used");
			}
			return { stored: true, replayed: true };
		}
		if (replies.filter((reply) => reply.authorKind === "external").length >= 10) {
			throw new RelayError("invalid_transition", "Reply limit reached");
		}
		const [reply] = await transaction
			.insert(shareReplies)
			.values({
				linkId: link.id,
				seq: (replies.at(-1)?.seq ?? 0) + 1,
				authorKind: "external",
				channel,
				content: input.content,
				idempotencyKey: key,
			})
			.returning();
		if (!reply) throw new Error("share reply insert returned no row");
		await transaction.insert(shareEvents).values({
			linkId: link.id,
			replyId: reply.id,
			kind: "reply.posted",
			actorKind: "external",
			metadata: { channel },
		});
		await writeAudit(transaction, {
			actorKind: "external",
			actorId: null,
			action: "reply.posted",
			resourceType: "share_reply",
			resourceId: reply.id,
			metadata: { link_id: link.id, channel },
			requestId,
		});
		return { stored: true, replayed: false };
	});
}

export async function revokeShare(
	db: Database,
	senderId: string,
	publicId: string,
	requestId: string,
) {
	return db.transaction(async (transaction) => {
		const link = await lockOwnerLink(transaction, senderId, publicId);
		if (link.revokedAt) return { ...shareReceipt(link), replayed: true };
		const revokedAt = new Date();
		await transaction.update(shareLinks).set({ revokedAt }).where(eq(shareLinks.id, link.id));
		await writeAudit(transaction, {
			actorId: senderId,
			action: "link.revoked",
			resourceType: "share_link",
			resourceId: link.id,
			requestId,
		});
		return { ...shareReceipt({ ...link, revokedAt }), replayed: false };
	});
}

export async function listShareReplies(db: Database, senderId: string, publicId: string) {
	return db.transaction(async (transaction) => {
		const link = await lockOwnerLink(transaction, senderId, publicId);
		const replies = await transaction
			.select()
			.from(shareReplies)
			.where(and(eq(shareReplies.linkId, link.id), eq(shareReplies.authorKind, "external")))
			.orderBy(asc(shareReplies.seq));
		return {
			...shareReceipt(link),
			replies: replies.map((reply) => ({
				reply_id: reply.id,
				sequence: reply.seq,
				channel: reply.channel,
				content: reply.content,
				created_at: reply.createdAt.toISOString(),
				released_at: reply.releasedAt?.toISOString() ?? null,
				origin: "external_unverified" as const,
			})),
		};
	});
}

export async function answerShare(
	db: Database,
	senderId: string,
	publicId: string,
	input: ShareAnswerInput,
	requestId: string,
) {
	return db.transaction(async (transaction) => {
		const link = await lockOwnerLink(transaction, senderId, publicId);
		requireActive(link);
		const replies = await transaction
			.select()
			.from(shareReplies)
			.where(eq(shareReplies.linkId, link.id))
			.orderBy(asc(shareReplies.seq));
		const existing = replies.find(
			(reply) => reply.authorKind === "sender" && reply.idempotencyKey === input.idempotency_key,
		);
		if (existing && existing.content !== input.content) {
			throw new RelayError("duplicate_idempotency_key", "Answer key already used");
		}
		let answer = existing;
		if (!answer) {
			const bytes = replies
				.filter((reply) => reply.authorKind === "sender")
				.reduce(
					(size, reply) => size + Buffer.byteLength(reply.content ?? "", "utf8"),
					Buffer.byteLength(link.content ?? "", "utf8"),
				);
			if (bytes + Buffer.byteLength(input.content, "utf8") > SHARE_CONTENT_BYTES) {
				throw new RelayError("invalid_params", "Published link content limit reached");
			}
			[answer] = await transaction
				.insert(shareReplies)
				.values({
					linkId: link.id,
					seq: (replies.at(-1)?.seq ?? 0) + 1,
					authorKind: "sender",
					channel: "api",
					content: input.content,
					idempotencyKey: input.idempotency_key,
				})
				.returning();
			if (!answer) throw new Error("share answer insert returned no row");
			await transaction.insert(shareEvents).values({
				linkId: link.id,
				replyId: answer.id,
				kind: "answer.posted",
				actorKind: "agent",
				actorAgentId: senderId,
			});
			await writeAudit(transaction, {
				actorId: senderId,
				action: "answer.posted",
				resourceType: "share_reply",
				resourceId: answer.id,
				metadata: { link_id: link.id },
				requestId,
			});
		}
		return {
			link_id: link.publicId,
			answer_id: answer.id,
			sequence: answer.seq,
			created_at: answer.createdAt.toISOString(),
			replayed: existing !== undefined,
		};
	});
}

export async function releaseShareReply(
	db: Database,
	senderId: string,
	replyId: string,
	requestId: string,
) {
	return db.transaction(async (transaction) => {
		const [owned] = await transaction
			.select({ publicId: shareLinks.publicId })
			.from(shareReplies)
			.innerJoin(shareLinks, eq(shareLinks.id, shareReplies.linkId))
			.where(and(eq(shareReplies.id, replyId), eq(shareLinks.senderId, senderId)));
		if (!owned) throw new RelayError("thread_not_found", "Reply unavailable");
		const link = await lockOwnerLink(transaction, senderId, owned.publicId);
		const [reply] = await transaction
			.select()
			.from(shareReplies)
			.where(and(eq(shareReplies.id, replyId), eq(shareReplies.authorKind, "external")));
		if (!reply) throw new RelayError("thread_not_found", "Reply unavailable");
		if (reply.content === null || link.contentDeletedAt) {
			throw new RelayError("thread_not_found", "Reply content unavailable");
		}
		const releasedAt = reply.releasedAt ?? new Date();
		if (!reply.releasedAt) {
			await transaction
				.update(shareReplies)
				.set({ releasedAt, releasedByAgentId: senderId })
				.where(eq(shareReplies.id, reply.id));
			await transaction.insert(shareEvents).values({
				linkId: link.id,
				replyId: reply.id,
				kind: "reply.released",
				actorKind: "agent",
				actorAgentId: senderId,
			});
			await writeAudit(transaction, {
				actorId: senderId,
				action: "reply.released",
				resourceType: "share_reply",
				resourceId: reply.id,
				metadata: { link_id: link.id },
				requestId,
			});
		}
		return {
			link_id: link.publicId,
			reply_id: reply.id,
			released_at: releasedAt.toISOString(),
			origin: "external_unverified" as const,
			replayed: reply.releasedAt !== null,
		};
	});
}

export async function listShareInbox(db: Database, senderId: string, input: ShareInboxInput) {
	return db.transaction(async (transaction) => {
		await lockAgentLifecycle(transaction, senderId);
		const [sender] = await transaction
			.select({ id: agents.id })
			.from(agents)
			.where(and(eq(agents.id, senderId), eq(agents.status, "active")));
		if (!sender) throw new RelayError("forbidden", "Sender unavailable");
		const conditions = [
			eq(shareLinks.senderId, senderId),
			eq(shareEvents.kind, "reply.released"),
			eq(shareReplies.authorKind, "external"),
			gt(shareEvents.id, BigInt(input.after_cursor)),
		];
		if (input.since) conditions.push(gte(shareReplies.releasedAt, new Date(input.since)));
		const rows = await transaction
			.select({ cursor: shareEvents.id, linkId: shareLinks.publicId, reply: shareReplies })
			.from(shareEvents)
			.innerJoin(shareLinks, eq(shareLinks.id, shareEvents.linkId))
			.innerJoin(shareReplies, eq(shareReplies.id, shareEvents.replyId))
			.where(and(...conditions))
			.orderBy(asc(shareEvents.id))
			.limit(input.limit + 1);
		const page = rows.slice(0, input.limit);
		return {
			replies: page.map(({ cursor, linkId, reply }) => ({
				cursor: cursor.toString(),
				link_id: linkId,
				reply_id: reply.id,
				sequence: reply.seq,
				channel: reply.channel,
				content: reply.content,
				created_at: reply.createdAt.toISOString(),
				released_at: reply.releasedAt!.toISOString(),
				origin: "external_unverified" as const,
			})),
			next_cursor: page.at(-1)?.cursor.toString() ?? input.after_cursor,
			has_more: rows.length > input.limit,
		};
	});
}

export async function deleteExpiredShareContent(db: Database): Promise<number> {
	return db.transaction(async (transaction) => {
		const links = await transaction
			.select({ id: shareLinks.id })
			.from(shareLinks)
			.where(
				and(
					isNull(shareLinks.contentDeletedAt),
					lte(shareLinks.expiresAt, sql`now() - interval '30 days'`),
				),
			)
			.orderBy(asc(shareLinks.expiresAt))
			.limit(100)
			.for("update", { skipLocked: true });
		for (const link of links) {
			await transaction
				.update(shareReplies)
				.set({ content: null })
				.where(eq(shareReplies.linkId, link.id));
			await transaction
				.update(shareLinks)
				.set({ content: null, contentDeletedAt: sql`now()` })
				.where(eq(shareLinks.id, link.id));
			await writeAudit(transaction, {
				actorKind: "system",
				actorId: null,
				action: "link.content_deleted",
				resourceType: "share_link",
				resourceId: link.id,
			});
		}
		return links.length;
	});
}
