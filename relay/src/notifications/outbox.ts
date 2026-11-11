import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { agents, notificationOutbox } from "../db/schema.js";
import { encryptWebhook } from "./crypto.js";
import type { NotificationJob, NotificationKind } from "./types.js";

export type NotificationTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface NotificationContext {
	encryptionKey: string;
	publicUrl: string;
}

export async function appendNotification(
	transaction: NotificationTransaction,
	context: NotificationContext,
	input: {
		kind: NotificationKind;
		recipientAgentId: string;
		actorAgentId: string;
		threadId: string;
		sourceId: string;
		summary: string;
	},
): Promise<void> {
	const [sender] = await transaction
		.select({ handle: agents.handle, name: agents.displayName })
		.from(agents)
		.where(eq(agents.id, input.actorAgentId));
	if (!sender) throw new Error("notification sender is missing");
	const job: NotificationJob = {
		kind: input.kind,
		recipientAgentId: input.recipientAgentId,
		threadId: input.threadId,
		senderHandle: sender.handle,
		senderName: sender.name,
		summary: input.summary.slice(0, 240),
		publicUrl: context.publicUrl,
		enqueuedAt: Date.now(),
	};
	await transaction.insert(notificationOutbox).values({
		recipientAgentId: input.recipientAgentId,
		threadId: input.threadId,
		kind: input.kind,
		sourceId: input.sourceId,
		encryptedPayload: encryptWebhook(JSON.stringify(job), context.encryptionKey),
	});
}
