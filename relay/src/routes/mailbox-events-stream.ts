import { and, eq, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Database } from "../db/client.js";
import { agents, apiKeys } from "../db/schema.js";
import { RelayError } from "../errors.js";
import type { MailboxSignal, MailboxSignalHub } from "../events/mailbox-signal.js";
import type { AppEnv } from "../types.js";

export interface MailboxEventStreamOptions {
	db: Database;
	hub: MailboxSignalHub;
	heartbeatMs?: number;
	maxStreamsPerCredential?: number;
}

/** Register the content-free live hint path on an already authenticated agent router. */
export function registerMailboxEventStream(
	router: Hono<AppEnv>,
	opts: MailboxEventStreamOptions,
): void {
	const activeStreams = new Map<string, number>();
	const maxStreamsPerCredential = opts.maxStreamsPerCredential ?? 2;

	router.get("/me/mailbox/events/stream", (c) => {
		const me = c.get("agent");
		if (!me) throw new RelayError("unauthenticated", "Auth required");
		const active = activeStreams.get(me.apiKeyId) ?? 0;
		if (active >= maxStreamsPerCredential) {
			throw new RelayError("rate_limited", "Too many active mailbox streams");
		}
		activeStreams.set(me.apiKeyId, active + 1);
		let released = false;
		const releaseStream = () => {
			if (released) return;
			released = true;
			const remaining = (activeStreams.get(me.apiKeyId) ?? 1) - 1;
			if (remaining <= 0) activeStreams.delete(me.apiKeyId);
			else activeStreams.set(me.apiKeyId, remaining);
		};
		const heartbeatMs = opts.heartbeatMs ?? 20_000;

		try {
			return streamSSE(c, async (stream) => {
				const pending = new Set<MailboxSignal>();
				let releaseWait: (() => void) | null = null;
				let aborted = false;
				let unsubscribe: () => void = () => undefined;
				const wake = (signal: MailboxSignal) => {
					pending.add(signal);
					releaseWait?.();
				};

				try {
					unsubscribe = opts.hub.subscribe(me.id, wake);
					stream.onAbort(() => {
						aborted = true;
						unsubscribe();
						releaseStream();
						releaseWait?.();
					});
					await stream.writeSSE({
						event: "ready",
						data: JSON.stringify({ type: "ready" }),
					});

					while (!aborted) {
						const signaled =
							pending.size > 0 ||
							(await waitForWake(heartbeatMs, (wake) => {
								releaseWait = wake;
								// Close the gap between the pending check above and
								// installing this wake callback.
								if (pending.size > 0) wake();
							}));
						releaseWait = null;
						if (aborted) break;
						if (pending.delete("closed")) break;

						if (!(await credentialRemainsActive(opts.db, me.apiKeyId, me.id)) || aborted) break;
						if (pending.delete("closed")) break;
						if (!signaled) {
							await stream.writeSSE({
								event: "heartbeat",
								data: JSON.stringify({ type: "heartbeat" }),
							});
							continue;
						}

						const event = pending.delete("resync") ? "resync" : "mailbox.changed";
						pending.delete("changed");
						await stream.writeSSE({ event, data: JSON.stringify({ type: event }) });
					}
				} finally {
					unsubscribe();
					releaseStream();
					if (!stream.closed) await stream.close().catch(() => undefined);
				}
			});
		} catch (error) {
			releaseStream();
			throw error;
		}
	});
}

async function credentialRemainsActive(
	db: Database,
	apiKeyId: string,
	agentId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ keyId: apiKeys.id })
		.from(apiKeys)
		.innerJoin(agents, eq(agents.id, apiKeys.agentId))
		.where(
			and(
				eq(apiKeys.id, apiKeyId),
				eq(apiKeys.agentId, agentId),
				isNull(apiKeys.revokedAt),
				eq(agents.status, "active"),
			),
		)
		.limit(1);
	return row !== undefined;
}

function waitForWake(timeoutMs: number, setWake: (wake: () => void) => void): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (signaled: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(signaled);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		setWake(() => finish(true));
	});
}
