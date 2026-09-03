import type { Sql } from "postgres";
import { z } from "zod";
import { MAILBOX_EVENT_NOTIFY_CHANNEL } from "../services/mailbox-events.js";

export type MailboxSignal = "changed" | "resync" | "closed";
export type MailboxSignalListener = (signal: MailboxSignal) => void;

interface ListenHandle {
	unlisten(): Promise<void>;
}

interface NotificationSource {
	listen(
		channel: string,
		onNotify: (payload: string) => void,
		onListen?: () => void,
	): Promise<ListenHandle>;
}

/**
 * One PostgreSQL LISTEN connection per Relay process. It fans out only
 * content-free wake hints; consumers always replay durable mailbox_events.
 */
export class MailboxSignalHub {
	private readonly listeners = new Map<string, Set<MailboxSignalListener>>();
	private listenHandle: ListenHandle | null = null;
	private startPromise: Promise<void> | null = null;
	private stopped = false;

	constructor(private readonly source: NotificationSource) {}

	start(): Promise<void> {
		if (this.stopped) return Promise.reject(new Error("Mailbox signal hub is stopped"));
		if (this.startPromise) return this.startPromise;

		this.startPromise = this.source
			.listen(
				MAILBOX_EVENT_NOTIFY_CHANNEL,
				(payload) => {
					if (!z.string().uuid().safeParse(payload).success) return;
					this.emit(payload, "changed");
				},
				() => this.emitAll("resync"),
			)
			.then(async (handle) => {
				if (this.stopped) {
					await handle.unlisten();
					return;
				}
				this.listenHandle = handle;
			});
		return this.startPromise;
	}

	subscribe(recipientAgentId: string, listener: MailboxSignalListener): () => void {
		if (this.stopped) throw new Error("Mailbox signal hub is stopped");
		const existing = this.listeners.get(recipientAgentId);
		if (existing) existing.add(listener);
		else this.listeners.set(recipientAgentId, new Set([listener]));

		return () => {
			const current = this.listeners.get(recipientAgentId);
			if (!current) return;
			current.delete(listener);
			if (current.size === 0) this.listeners.delete(recipientAgentId);
		};
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.emitAll("closed");
		this.listeners.clear();
		const listenHandle = this.listenHandle;
		this.listenHandle = null;
		// A broken or half-open LISTEN socket must not make Relay shutdown wait
		// forever. If startup resolves later, start() observes `stopped` and
		// unlistens that late handle itself.
		await listenHandle?.unlisten();
	}

	private emit(recipientAgentId: string, signal: MailboxSignal): void {
		for (const listener of this.listeners.get(recipientAgentId) ?? []) {
			try {
				listener(signal);
			} catch {
				// A disconnected stream must not prevent other local subscribers waking.
			}
		}
	}

	private emitAll(signal: MailboxSignal): void {
		for (const listeners of this.listeners.values()) {
			for (const listener of listeners) {
				try {
					listener(signal);
				} catch {
					// A disconnected stream must not prevent other local subscribers waking.
				}
			}
		}
	}
}

export function createMailboxSignalHub(sql: Sql): MailboxSignalHub {
	return new MailboxSignalHub(sql);
}
