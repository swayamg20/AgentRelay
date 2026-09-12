import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { A2AHttpError, A2ARpcError } from "../a2a-client.js";
import { type MailboxEventClient, MailboxEventHttpError } from "../connector/event-client.js";
import {
	type LiveRuntime,
	LiveSessionError,
	hostReceiptSchema,
	liveReplySchema,
} from "./contracts.js";
import { type LiveMailbox, assertLiveThread, liveTurnContent } from "./mailbox.js";
import type { LiveStore } from "./store.js";

export interface LiveBridgeOptions {
	store: LiveStore;
	mailbox: LiveMailbox;
	events: Pick<MailboxEventClient, "stream">;
	runtime: LiveRuntime;
	signal: AbortSignal;
	assertAuthority(): Promise<void>;
	onStatus?: (status: {
		type: "ready" | "starting" | "completed" | "replied" | "no_reply" | "reconnecting";
		messageId?: string;
	}) => void;
	now?: () => number;
	once?: boolean;
}

/** Ordered mailbox replay; transport hints and host acceptance are never receipts. */
export async function runLiveBridge(options: LiveBridgeOptions): Promise<void> {
	const now = options.now ?? Date.now;
	const expiry = AbortSignal.timeout(Math.max(1, options.store.read().expiresAt - now()));
	const signal = AbortSignal.any([options.signal, expiry]);
	const authorize = async () => {
		signal.throwIfAborted();
		if (now() >= options.store.read().expiresAt)
			throw new LiveSessionError("expired", "Live session consent expired");
		await options.assertAuthority();
		signal.throwIfAborted();
	};
	const publishPending = async () => {
		const state = options.store.read();
		const pending = state.pending;
		if (!pending) return;
		if (pending.phase === "running") {
			throw new LiveSessionError(
				"uncertain_turn",
				"A previous model turn has an unknown outcome. Automatic replay is stopped; inspect the live journal and Relay thread before continuing.",
			);
		}
		await authorize();
		// This fetch is a fresh lifecycle/participant check, not another model turn.
		const thread = await options.mailbox.read(signal);
		assertLiveThread(thread, state.scope);
		const source = thread.messages.find((message) => message.id === pending.messageId);
		if (
			!source ||
			source.sequence_no !== pending.sequence ||
			source.from !== state.scope.peerHandle ||
			digest(liveTurnContent(thread, pending.sequence)) !== pending.inputDigest
		) {
			throw new LiveSessionError(
				"source_changed",
				"The saved reply no longer matches its original peer input",
			);
		}
		await authorize();
		const replyMessageId =
			pending.reply === null
				? null
				: await options.mailbox.reply(
						{
							body: pending.reply,
							messageId: pending.messageId,
							idempotencyKey: pending.idempotencyKey,
						},
						signal,
					);
		// Record a completed HTTP result even if stop races after Relay commit.
		const disposition = replyMessageId === null ? "no_reply" : "replied";
		await options.store.save({
			...state,
			lastSequence: pending.sequence,
			pending: null,
			receipts: [
				...state.receipts,
				{
					messageId: pending.messageId,
					sequence: pending.sequence,
					disposition,
					replyMessageId,
					host: pending.host,
				},
			],
		});
		options.onStatus?.({ type: disposition, messageId: pending.messageId });
	};
	const drain = async () => {
		await authorize();
		await publishPending();
		const thread = await options.mailbox.read(signal);
		assertLiveThread(thread, options.store.read().scope);
		for (const message of thread.messages) {
			const state = options.store.read();
			if (message.sequence_no <= state.lastSequence) continue;
			await authorize();
			if (message.from === state.scope.localHandle) {
				await options.store.save({ ...state, lastSequence: message.sequence_no });
				continue;
			}
			if (state.turnsStarted >= state.maxTurns) return;
			const content = liveTurnContent(thread, message.sequence_no);
			const pending = {
				phase: "running" as const,
				messageId: message.id,
				sequence: message.sequence_no,
				inputDigest: digest(content),
				idempotencyKey: randomUUID(),
			};
			await options.store.save({ ...state, pending, turnsStarted: state.turnsStarted + 1 });
			await authorize();
			options.onStatus?.({ type: "starting", messageId: message.id });
			const result = await options.runtime.runTurn({ messageId: message.id, content }, signal);
			const reply = liveReplySchema.parse(result.reply);
			const host = hostReceiptSchema.parse(result.host);
			await options.store.save({
				...options.store.read(),
				pending: { ...pending, phase: "reply_ready", reply, host },
			});
			options.onStatus?.({ type: "completed", messageId: message.id });
			await publishPending();
		}
	};
	const exhausted = () => {
		const state = options.store.read();
		return state.turnsStarted >= state.maxTurns && state.pending === null;
	};
	let retryMs = 250;
	let replayed = false;
	try {
		while (!signal.aborted && !exhausted()) {
			try {
				if (!replayed) {
					await drain();
					replayed = true;
				}
				if (options.once || exhausted()) return;
				const connection = new AbortController();
				const connectionSignal = AbortSignal.any([signal, connection.signal]);
				await options.events.stream(connectionSignal, async (hint) => {
					await authorize();
					if (hint.type === "heartbeat") return;
					await drain();
					if (exhausted()) {
						connection.abort();
						return;
					}
					if (hint.type === "ready") {
						retryMs = 250;
						options.onStatus?.({ type: "ready" });
					}
				});
			} catch (error) {
				if (signal.aborted || exhausted()) return;
				if (!isRetryable(error)) throw error;
				options.onStatus?.({ type: "reconnecting" });
			}
			if (!signal.aborted && !exhausted()) {
				await delay(retryMs, undefined, { signal });
				retryMs = Math.min(10_000, retryMs * 2);
			}
		}
	} catch (error) {
		if (!signal.aborted) throw error;
	} finally {
		await options.runtime.close();
	}
}

function digest(content: string) {
	return createHash("sha256").update(content).digest("hex");
}

function isRetryable(error: unknown): boolean {
	if (error instanceof LiveSessionError || error instanceof A2ARpcError) return false;
	if (error instanceof A2AHttpError || error instanceof MailboxEventHttpError) {
		return error.status >= 500 || error.status === 408 || error.status === 429;
	}
	return (
		error instanceof TypeError ||
		(error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))
	);
}
