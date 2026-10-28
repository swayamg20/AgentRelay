import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { loadConfig } from "../config.js";
import {
	type MailboxEvent,
	type MailboxEventClient,
	MailboxEventHttpError,
	createMailboxEventClient,
} from "./event-client.js";

const cursorSchema = z
	.string()
	.regex(/^[1-9][0-9]*$/)
	.max(19)
	.refine((cursor) => cursor.length < 19 || cursor <= "9223372036854775807")
	.nullable()
	.default(null);

export type StdoutMailboxEvent = MailboxEvent & {
	kind: "thread.created" | "message.appended";
};

export type StdoutWatchStatus = { type: "connected" } | { type: "reconnecting"; delayMs: number };

export interface StdoutWatchOptions {
	client: MailboxEventClient;
	signal: AbortSignal;
	afterCursor?: string | null;
	once?: boolean;
	onEvent: (event: StdoutMailboxEvent) => Promise<void>;
	onStatus?: (status: StdoutWatchStatus) => void;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

class StdoutWatchError extends Error {}

export function parseStdoutWatchCursor(value: unknown): string | null {
	const parsed = cursorSchema.safeParse(value);
	if (!parsed.success) {
		throw new Error("--after-cursor must be a positive decimal Postgres bigint cursor");
	}
	return parsed.data;
}

export async function runStdoutMailboxWatch(opts: StdoutWatchOptions): Promise<void> {
	let cursor = parseStdoutWatchCursor(opts.afterCursor);
	const sleep = opts.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
	const drain = async () => {
		while (!opts.signal.aborted) {
			const page = await opts.client.list(cursor, 100, opts.signal);
			if (page.events.length === 0) return;
			if (page.events.length > 100)
				throw new StdoutWatchError("Mailbox replay exceeded its page limit");
			const startingCursor = cursor;
			let previous = 0n;
			for (const event of page.events) {
				if (opts.signal.aborted) return;
				const next = BigInt(event.cursor);
				if (next < previous) throw new StdoutWatchError("Mailbox replay was not cursor ordered");
				previous = next;
				if (cursor !== null && next <= BigInt(cursor)) continue;
				if (event.kind === "thread.created" || event.kind === "message.appended") {
					try {
						await opts.onEvent({
							event_id: event.event_id,
							cursor: event.cursor,
							thread_id: event.thread_id,
							actor_handle: event.actor_handle,
							kind: event.kind,
							created_at: event.created_at,
						});
					} catch {
						throw new StdoutWatchError("Could not write mailbox event to stdout");
					}
				}
				cursor = event.cursor;
			}
			if (page.events.length < 100) return;
			if (cursor === startingCursor)
				throw new StdoutWatchError("Mailbox replay made no cursor progress");
		}
	};

	if (opts.once) {
		try {
			await drain();
		} catch (error) {
			if (!opts.signal.aborted) throw error;
		}
		return;
	}

	let initialReplayComplete = false;
	let retryMs = 250;
	while (!opts.signal.aborted) {
		try {
			if (!initialReplayComplete) {
				await drain();
				initialReplayComplete = true;
			}
			if (opts.signal.aborted) return;
			await opts.client.stream(opts.signal, async (signal) => {
				if (signal.type === "heartbeat") return;
				await drain();
				if (signal.type === "ready") {
					retryMs = 250;
					opts.onStatus?.({ type: "connected" });
				}
			});
		} catch (error) {
			if (opts.signal.aborted) return;
			if (error instanceof StdoutWatchError || error instanceof z.ZodError) throw error;
			if (
				error instanceof MailboxEventHttpError &&
				error.status >= 400 &&
				error.status < 500 &&
				error.status !== 408 &&
				error.status !== 429
			) {
				throw error;
			}
		}
		if (opts.signal.aborted) return;
		opts.onStatus?.({ type: "reconnecting", delayMs: retryMs });
		try {
			await sleep(retryMs, opts.signal);
		} catch (error) {
			if (opts.signal.aborted) return;
			throw error;
		}
		retryMs = Math.min(retryMs * 2, 10_000);
	}
}

export async function watchConfiguredStdout(
	opts: Omit<StdoutWatchOptions, "client" | "sleep">,
): Promise<void> {
	const afterCursor = parseStdoutWatchCursor(opts.afterCursor);
	const configResult = await loadConfig();
	if (!configResult.ok) {
		throw new Error(
			`AgentRelay configuration is ${configResult.reason}; check it with agentrelay doctor`,
		);
	}
	await runStdoutMailboxWatch({
		...opts,
		afterCursor,
		client: createMailboxEventClient({
			relayUrl: configResult.config.relay_url,
			apiKey: configResult.config.api_key,
		}),
	});
}
