import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { agents, shareEvents, shareLinks, shareReplies } from "../db/schema.js";
import { RelayError } from "../errors.js";
import type { CreateShareInput, ShareReplyInput } from "../share-schemas.js";
import { writeAudit } from "./audit.js";
import { lockAgentLifecycle } from "./node-enrollment.js";

type ShareTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type ShareLink = typeof shareLinks.$inferSelect;

function requireActive(link: ShareLink): void {
	if (link.revokedAt || link.contentDeletedAt || link.expiresAt.getTime() <= Date.now()) {
		throw new RelayError("thread_not_found", "Link unavailable");
	}
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
			return { stored: true, held: true, replayed: true };
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
		return { stored: true, held: true, replayed: false };
	});
}

export async function revokeShare(
	db: Database,
	senderId: string,
	publicId: string,
	requestId: string,
) {
	return db.transaction(async (transaction) => {
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
