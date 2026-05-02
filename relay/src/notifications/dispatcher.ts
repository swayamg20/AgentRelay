import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { agentCards } from "../db/schema.js";
import type { Logger } from "../logger.js";
import { decryptWebhook } from "./crypto.js";
import { type SlackPoster, defaultSlackPoster, renderSlackBlocks } from "./slack.js";
import type { DispatchOutcome, NotificationJob } from "./types.js";

export interface DispatcherMetrics {
	enqueued: number;
	dispatched: number;
	succeeded: number;
	failed: number;
	retries: number;
	dropped: number; // queue overflow
}

export interface DispatcherOptions {
	db: Database;
	encryptionKey: string;
	publicUrl: string;
	logger: Logger;
	slackPoster?: SlackPoster;
	/** Max queue depth (lld §9.2: bounded at 10k). */
	maxQueueDepth?: number;
	/** Backoff schedule in ms (lld §9.3: 1s, 4s, 16s). */
	backoffSchedule?: number[];
	/** Override timer (test injection). */
	delay?: (ms: number) => Promise<void>;
}

const DEFAULT_BACKOFF = [1_000, 4_000, 16_000];

export class NotificationDispatcher {
	private readonly db: Database;
	private readonly encryptionKey: string;
	private readonly publicUrl: string;
	private readonly logger: Logger;
	private readonly slackPoster: SlackPoster;
	private readonly maxQueueDepth: number;
	private readonly backoff: number[];
	private readonly delay: (ms: number) => Promise<void>;

	private readonly queue: NotificationJob[] = [];
	private worker: Promise<void> | null = null;
	private stopped = false;
	private notify: (() => void) | null = null;

	readonly metrics: DispatcherMetrics = {
		enqueued: 0,
		dispatched: 0,
		succeeded: 0,
		failed: 0,
		retries: 0,
		dropped: 0,
	};

	constructor(opts: DispatcherOptions) {
		this.db = opts.db;
		this.encryptionKey = opts.encryptionKey;
		this.publicUrl = opts.publicUrl;
		this.logger = opts.logger.child({ component: "notifications" });
		this.slackPoster = opts.slackPoster ?? defaultSlackPoster;
		this.maxQueueDepth = opts.maxQueueDepth ?? 10_000;
		this.backoff = opts.backoffSchedule ?? DEFAULT_BACKOFF;
		this.delay = opts.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	}

	start(): void {
		if (this.worker) return;
		this.stopped = false;
		this.worker = this.run();
	}

	/** Enqueue a job. Drops with audit log if queue is full (lld §9.2 backpressure). */
	enqueue(job: NotificationJob): void {
		if (this.queue.length >= this.maxQueueDepth) {
			this.metrics.dropped += 1;
			this.logger.error(
				{ event: "notify.dropped", kind: job.kind, threadId: job.threadId },
				"notification queue overflow — job dropped",
			);
			return;
		}
		this.queue.push(job);
		this.metrics.enqueued += 1;
		if (this.notify) {
			const fn = this.notify;
			this.notify = null;
			fn();
		}
	}

	async drain(): Promise<void> {
		// Use a real timer here — NOT this.delay, which can be mocked to a
		// no-op (Promise.resolve()) by retry-backoff tests. With a no-op delay
		// this loop becomes a tight microtask chain that never yields to the
		// worker, hanging forever. setTimeout(_, 1) guarantees a macrotask
		// yield so the worker can pull from the queue.
		while (this.queue.length > 0) {
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
		}
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.notify) {
			const fn = this.notify;
			this.notify = null;
			fn();
		}
		if (this.worker) await this.worker;
	}

	/** Dispatch one job; exposed for tests. */
	async dispatchOne(job: NotificationJob): Promise<DispatchOutcome> {
		const started = Date.now();
		const [card] = await this.db
			.select({ url: agentCards.notificationWebhookUrl })
			.from(agentCards)
			.where(eq(agentCards.agentId, job.recipientAgentId));

		if (!card?.url) {
			this.logger.info(
				{ event: "notify.skip", threadId: job.threadId, kind: job.kind },
				"no webhook configured for recipient — skipping",
			);
			return { ok: true, attempts: 0, durationMs: Date.now() - started, reason: "no_webhook" };
		}

		let webhookUrl: string;
		try {
			webhookUrl = decryptWebhook(card.url, this.encryptionKey);
		} catch (err) {
			this.logger.error(
				{ err, event: "notify.decrypt_failed", threadId: job.threadId },
				"webhook decryption failed",
			);
			this.metrics.failed += 1;
			return {
				ok: false,
				attempts: 0,
				durationMs: Date.now() - started,
				reason: "decrypt_failed",
			};
		}

		const payload = renderSlackBlocks(job);

		const maxAttempts = this.backoff.length + 1;
		let attempt = 0;
		let lastStatus: number | undefined;
		let rateLimitedRetried = false;

		while (attempt < maxAttempts) {
			attempt += 1;
			try {
				const result = await this.slackPoster(webhookUrl, payload);
				lastStatus = result.status;
				if (result.ok) {
					this.metrics.succeeded += 1;
					return {
						ok: true,
						attempts: attempt,
						durationMs: Date.now() - started,
						status: result.status,
					};
				}
				// 429: respect Retry-After, retry once, then give up.
				if (result.status === 429) {
					if (rateLimitedRetried) break;
					rateLimitedRetried = true;
					const wait = (result.retryAfterSeconds ?? 1) * 1000;
					this.metrics.retries += 1;
					await this.delay(wait);
					continue;
				}
				// 4xx (other than 429): no retry.
				if (result.status >= 400 && result.status < 500) {
					this.logger.warn(
						{ status: result.status, event: "notify.4xx", threadId: job.threadId },
						"webhook returned 4xx — not retrying",
					);
					break;
				}
				// 5xx: backoff retry.
				if (attempt <= this.backoff.length) {
					const wait = this.backoff[attempt - 1] ?? this.backoff[this.backoff.length - 1] ?? 1000;
					this.metrics.retries += 1;
					await this.delay(wait);
					continue;
				}
				break;
			} catch (err) {
				// network/timeout errors: backoff retry like 5xx
				this.logger.warn(
					{ err, attempt, event: "notify.error", threadId: job.threadId },
					"webhook post errored",
				);
				if (attempt <= this.backoff.length) {
					const wait = this.backoff[attempt - 1] ?? 1000;
					this.metrics.retries += 1;
					await this.delay(wait);
					continue;
				}
				break;
			}
		}

		this.metrics.failed += 1;
		return {
			ok: false,
			attempts: attempt,
			durationMs: Date.now() - started,
			status: lastStatus,
			reason: "max_attempts",
		};
	}

	private async run(): Promise<void> {
		while (!this.stopped) {
			const job = this.queue.shift();
			if (!job) {
				if (this.stopped) return;
				await new Promise<void>((resolve) => {
					this.notify = resolve;
				});
				continue;
			}
			this.metrics.dispatched += 1;
			try {
				await this.dispatchOne(job);
			} catch (err) {
				this.metrics.failed += 1;
				this.logger.error(
					{ err, kind: job.kind, threadId: job.threadId },
					"unexpected dispatcher error",
				);
			}
		}
	}
}
