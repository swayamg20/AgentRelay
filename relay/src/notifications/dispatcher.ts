import { randomUUID } from "node:crypto";
import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";
import {
	type NotificationOutboxJob,
	agentCards,
	agents,
	notificationOutbox,
} from "../db/schema.js";
import type { Logger } from "../logger.js";
import { decryptWebhook } from "./crypto.js";
import {
	type SlackPostResult,
	type SlackPoster,
	defaultSlackPoster,
	isSlackWebhookUrl,
	renderSlackBlocks,
} from "./slack.js";

const LEASE_MS = 30_000;
const POST_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 4;
const RETENTION_DAYS = 7;
const CLEANUP_BATCH_SIZE = 100;
const MAX_RETRY_AFTER_SECONDS = 86_400;

const notificationPayloadSchema = z
	.object({
		kind: z.enum([
			"notify.handoff.created",
			"notify.message.appended",
			"notify.handoff.completed",
			"notify.handoff.cancelled",
		]),
		recipientAgentId: z.string().uuid(),
		threadId: z.string().uuid(),
		senderHandle: z.string(),
		senderName: z.string(),
		summary: z.string().max(240),
		publicUrl: z.string().url(),
		enqueuedAt: z.number().finite().nonnegative(),
	})
	.strict();

export interface DispatcherOptions {
	db: Database;
	encryptionKey: string;
	logger: Logger;
	slackPoster?: SlackPoster;
	backoffSchedule?: [number, number, number];
	pollIntervalMs?: number;
}

export class NotificationDispatcher {
	private readonly db: Database;
	private readonly encryptionKey: string;
	private readonly logger: Logger;
	private readonly slackPoster: SlackPoster;
	private readonly backoff: [number, number, number];
	private readonly pollIntervalMs: number;
	private stopped = true;
	private worker: Promise<void> | null = null;
	private wake: (() => void) | null = null;

	constructor(options: DispatcherOptions) {
		this.db = options.db;
		this.encryptionKey = options.encryptionKey;
		this.logger = options.logger;
		this.slackPoster = options.slackPoster ?? defaultSlackPoster;
		this.backoff = options.backoffSchedule ?? [1_000, 4_000, 16_000];
		this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
	}

	start(): void {
		if (this.worker) return;
		this.stopped = false;
		this.worker = this.run();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.wake?.();
		await this.worker;
		this.worker = null;
	}

	async claimDueJob(): Promise<NotificationOutboxJob | null> {
		return this.db.transaction(async (transaction) => {
			const [job] = await transaction
				.select()
				.from(notificationOutbox)
				.where(
					or(
						and(
							eq(notificationOutbox.status, "pending"),
							lte(notificationOutbox.availableAt, sql`now()`),
						),
						and(
							eq(notificationOutbox.status, "leased"),
							lte(notificationOutbox.leaseExpiresAt, sql`now()`),
						),
					),
				)
				.orderBy(asc(notificationOutbox.availableAt), asc(notificationOutbox.id))
				.limit(1)
				.for("update", { skipLocked: true });
			if (!job) return null;
			if (job.attempts >= MAX_ATTEMPTS) {
				const [failed] = await transaction
					.update(notificationOutbox)
					.set({
						status: "failed",
						reason: "max_attempts",
						terminalAt: sql`now()`,
						encryptedPayload: null,
						leaseToken: null,
						leaseExpiresAt: null,
					})
					.where(eq(notificationOutbox.id, job.id))
					.returning();
				return failed ?? null;
			}
			const [claimed] = await transaction
				.update(notificationOutbox)
				.set({
					status: "leased",
					attempts: job.attempts + 1,
					leaseToken: randomUUID(),
					leaseExpiresAt: sql`now() + ${LEASE_MS} * interval '1 millisecond'`,
				})
				.where(eq(notificationOutbox.id, job.id))
				.returning();
			return claimed ?? null;
		});
	}

	async processDueJob(): Promise<boolean> {
		const job = await this.claimDueJob();
		if (!job) return false;
		if (job.status === "failed") return true;

		let payload: z.infer<typeof notificationPayloadSchema>;
		try {
			payload = notificationPayloadSchema.parse(
				JSON.parse(decryptWebhook(job.encryptedPayload ?? "", this.encryptionKey)),
			);
			if (
				payload.recipientAgentId !== job.recipientAgentId ||
				payload.threadId !== job.threadId ||
				payload.kind !== job.kind
			)
				throw new Error("notification identity mismatch");
		} catch {
			await this.finish(job, "failed", "invalid_payload");
			return true;
		}

		const [destination] = await this.db
			.select({
				url: agentCards.notificationWebhookUrl,
				status: agents.status,
			})
			.from(agents)
			.leftJoin(agentCards, eq(agentCards.agentId, agents.id))
			.where(eq(agents.id, job.recipientAgentId));
		if (!destination?.url || destination.status !== "active") {
			await this.finish(job, "skipped", "no_webhook");
			return true;
		}
		let webhookUrl: string;
		try {
			webhookUrl = decryptWebhook(destination.url, this.encryptionKey);
		} catch {
			await this.finish(job, "failed", "decrypt_failed");
			return true;
		}
		if (!isSlackWebhookUrl(webhookUrl)) {
			await this.finish(job, "failed", "invalid_webhook");
			return true;
		}

		const [owned] = await this.db
			.select({ id: notificationOutbox.id })
			.from(notificationOutbox)
			.where(this.ownedLease(job));
		if (!owned) return true;
		let result: SlackPostResult | undefined;
		try {
			result = await this.post(webhookUrl, renderSlackBlocks(payload));
		} catch {
			this.logger.warn({ event: "notify.post_error", jobId: job.id }, "notification post failed");
		}
		const status = result?.status;
		if (result?.ok) {
			await this.finish(job, "succeeded", "delivered", status);
			return true;
		}
		if (status === 429) {
			if (job.rateLimitRetried || job.attempts >= MAX_ATTEMPTS) {
				await this.finish(job, "failed", "rate_limited", status);
			} else {
				const retryAfter = result?.retryAfterSeconds;
				const seconds =
					retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter >= 0
						? Math.min(retryAfter, MAX_RETRY_AFTER_SECONDS)
						: 1;
				await this.retry(job, seconds * 1_000, status, true);
			}
			return true;
		}
		if (status !== undefined && status >= 400 && status < 500) {
			await this.finish(job, "failed", "permanent_http", status);
			return true;
		}
		if (job.attempts >= MAX_ATTEMPTS) {
			await this.finish(job, "failed", "max_attempts", status);
		} else {
			await this.retry(job, this.backoff[job.attempts - 1] ?? 16_000, status);
		}
		return true;
	}

	async cleanupTerminalJobs(): Promise<number> {
		const result = await this.db.execute(sql`
			DELETE FROM notification_outbox WHERE id IN (
				SELECT id FROM notification_outbox
				WHERE terminal_at < now() - ${RETENTION_DAYS} * interval '1 day'
				ORDER BY terminal_at, id LIMIT ${CLEANUP_BATCH_SIZE} FOR UPDATE SKIP LOCKED
			) RETURNING id
		`);
		return result.length;
	}

	private ownedLease(job: NotificationOutboxJob) {
		return and(
			eq(notificationOutbox.id, job.id),
			eq(notificationOutbox.status, "leased"),
			eq(notificationOutbox.leaseToken, job.leaseToken ?? ""),
			sql`${notificationOutbox.leaseExpiresAt} > now()`,
		);
	}

	private async finish(
		job: NotificationOutboxJob,
		status: "succeeded" | "failed" | "skipped",
		reason: string,
		httpStatus?: number,
	): Promise<void> {
		const updated = await this.db
			.update(notificationOutbox)
			.set({
				status,
				reason,
				lastStatus: httpStatus ?? null,
				terminalAt: sql`now()`,
				encryptedPayload: null,
				leaseToken: null,
				leaseExpiresAt: null,
			})
			.where(this.ownedLease(job))
			.returning({ id: notificationOutbox.id });
		if (updated.length)
			this.logger.info(
				{ event: "notify.terminal", jobId: job.id, status, reason, attempts: job.attempts },
				"notification attempt settled",
			);
	}

	private async retry(
		job: NotificationOutboxJob,
		delayMs: number,
		status?: number,
		rateLimitRetried = job.rateLimitRetried,
	): Promise<void> {
		await this.db
			.update(notificationOutbox)
			.set({
				status: "pending",
				availableAt: sql`now() + ${delayMs} * interval '1 millisecond'`,
				lastStatus: status ?? null,
				rateLimitRetried,
				reason: "retry",
				leaseToken: null,
				leaseExpiresAt: null,
			})
			.where(this.ownedLease(job));
	}

	private async post(url: string, payload: unknown) {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				this.slackPoster(url, payload, controller.signal),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						controller.abort();
						reject(new Error("notification post timed out"));
					}, POST_TIMEOUT_MS);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	private async run(): Promise<void> {
		let nextCleanupAt = 0;
		while (!this.stopped) {
			try {
				if (Date.now() >= nextCleanupAt) {
					await this.cleanupTerminalJobs();
					nextCleanupAt = Date.now() + 60_000;
				}
				if (await this.processDueJob()) continue;
			} catch {
				this.logger.error({ event: "notify.worker_error" }, "notification worker will retry");
			}
			if (this.stopped) break;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					this.wake = null;
					resolve();
				}, this.pollIntervalMs);
				this.wake = () => {
					clearTimeout(timer);
					this.wake = null;
					resolve();
				};
			});
		}
	}
}
