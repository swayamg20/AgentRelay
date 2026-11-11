import { and, eq, gt, isNull } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { agentCards, agents, shareLinks } from "../db/schema.js";
import type { Logger } from "../logger.js";
import { decryptWebhook } from "./crypto.js";
import { type SlackPoster, defaultSlackPoster, isSlackWebhookUrl } from "./slack.js";

export interface ShareHintOptions {
	encryptionKey: string;
	logger: Logger;
	slackPoster?: SlackPoster;
}

export async function sendShareReplyHint(
	db: Database,
	publicId: string,
	options: ShareHintOptions,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const [destination] = await db
			.select({ webhook: agentCards.notificationWebhookUrl })
			.from(shareLinks)
			.innerJoin(agents, eq(agents.id, shareLinks.senderId))
			.innerJoin(agentCards, eq(agentCards.agentId, agents.id))
			.where(
				and(
					eq(shareLinks.publicId, publicId),
					eq(agents.status, "active"),
					isNull(shareLinks.revokedAt),
					isNull(shareLinks.contentDeletedAt),
					gt(shareLinks.expiresAt, new Date()),
				),
			);
		if (!destination?.webhook) return;
		const url = decryptWebhook(destination.webhook, options.encryptionKey);
		if (!isSlackWebhookUrl(url)) throw new Error("invalid share notification destination");
		const controller = new AbortController();
		await Promise.race([
			(options.slackPoster ?? defaultSlackPoster)(
				url,
				{
					text: "AgentRelay: an unverified handoff-link reply is waiting for owner review. It is held until you explicitly release it; this hint does not mean agent processing.",
				},
				controller.signal,
			),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new Error("share notification timed out"));
				}, 5_000);
			}),
		]);
	} catch {
		options.logger.warn({ event: "share.hint_failed" }, "optional share hint failed");
	} finally {
		clearTimeout(timer);
	}
}
