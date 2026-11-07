import type { Database } from "../db/client.js";
import type { Logger } from "../logger.js";
import { deleteExpiredShareContent } from "./shares.js";

export class ShareRetentionSweep {
	private worker: Promise<void> | null = null;
	private stopped = true;
	private wake: (() => void) | null = null;

	constructor(
		private readonly db: Database,
		private readonly logger: Logger,
		private readonly intervalMs = 60_000,
	) {}

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

	private async run(): Promise<void> {
		while (!this.stopped) {
			try {
				let deleted: number;
				do {
					deleted = await deleteExpiredShareContent(this.db);
				} while (!this.stopped && deleted === 100);
			} catch {
				this.logger.warn({ event: "share.retention_failed" }, "share retention sweep failed");
			}
			if (this.stopped) break;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(finish, this.intervalMs);
				timer.unref();
				this.wake = finish;
				function finish() {
					clearTimeout(timer);
					resolve();
				}
			});
			this.wake = null;
		}
	}
}
