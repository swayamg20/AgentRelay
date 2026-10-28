import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { loadConfig } from "../config.js";
import {
	type MailboxEventClient,
	MailboxEventHttpError,
	createMailboxEventClient,
} from "./event-client.js";

const afterCursorSchema = z
	.string()
	.regex(/^[1-9][0-9]*$/)
	.max(19)
	.refine((cursor) => cursor.length < 19 || cursor <= "9223372036854775807");

const watchOptionsSchema = z.object({
	stdout: z.boolean().default(false),
	once: z.boolean().default(false),
	afterCursor: afterCursorSchema.optional(),
});

class StdoutWatchError extends Error {}

export function parseWatchOptions(raw: unknown): z.infer<typeof watchOptionsSchema> {
	const result = watchOptionsSchema.safeParse(raw);
	if (!result.success) {
		throw new StdoutWatchError(
			"Invalid watch options; --after-cursor must be a positive decimal cursor within Postgres bigint range",
		);
	}
	if (result.data.afterCursor !== undefined && !result.data.stdout) {
		throw new StdoutWatchError(
			"--after-cursor requires --stdout; attention watch uses its saved cursor",
		);
	}
	return result.data;
}

export type StdoutWatchStatus = { type: "connected" } | { type: "reconnecting"; delayMs: number };

interface StdoutWatchOptions {
	signal: AbortSignal;
	once?: boolean;
	afterCursor?: string;
	writeLine: (line: string) => void | Promise<void>;
	onStatus?: (status: StdoutWatchStatus) => void;
}

export async function runStdoutWatch(
	opts: StdoutWatchOptions & {
		client: MailboxEventClient;
		sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	},
): Promise<void> {
	const parsed = parseWatchOptions({
		stdout: true,
		once: opts.once,
		afterCursor: opts.afterCursor,
	});
	let cursor = parsed.afterCursor ?? null;
	const sleep = opts.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));

	const drain = async () => {
		while (!opts.signal.aborted) {
			const page = await opts.client.list(cursor, 100, opts.signal);
			if (opts.signal.aborted || page.events.length === 0) return;
			const replayFloor = cursor === null ? 0n : BigInt(cursor);
			let previous = replayFloor;
			for (const event of page.events) {
				const next = BigInt(event.cursor);
				if (next <= replayFloor) continue;
				if (next < previous) throw new StdoutWatchError("Mailbox replay was not cursor ordered");
				previous = next;
			}
			for (const event of page.events) {
				if (opts.signal.aborted) return;
				if (cursor !== null && BigInt(event.cursor) <= BigInt(cursor)) continue;
				if (event.kind === "thread.created" || event.kind === "message.appended") {
					const reference = {
						event_id: event.event_id,
						cursor: event.cursor,
						thread_id: event.thread_id,
						actor_handle: event.actor_handle,
						kind: event.kind,
						created_at: event.created_at,
					};
					try {
						await opts.writeLine(`${JSON.stringify(reference)}\n`);
					} catch {
						throw new StdoutWatchError("Could not write mailbox event references to stdout");
					}
				}
				cursor = event.cursor;
			}
			if (page.events.length < 100) return;
		}
	};

	if (parsed.once) {
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

export async function watchConfiguredStdout(opts: StdoutWatchOptions): Promise<void> {
	const configResult = await loadConfig();
	if (!configResult.ok) {
		throw new StdoutWatchError("AgentRelay configuration is unavailable; run agentrelay doctor");
	}
	try {
		await runStdoutWatch({
			...opts,
			client: createMailboxEventClient({
				relayUrl: configResult.config.relay_url,
				apiKey: configResult.config.api_key,
			}),
		});
	} catch (error) {
		if (error instanceof StdoutWatchError || error instanceof MailboxEventHttpError) throw error;
		throw new StdoutWatchError(
			"Mailbox observation stopped; check Relay connectivity and event compatibility",
		);
	}
}
