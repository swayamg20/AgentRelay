import { loadConfig, unavailableMessage } from "../config.js";
import { loadTrust } from "../trust.js";
import { createCodexAttentionAdapter } from "./codex.js";
import {
	type MailboxEvent,
	type MailboxEventClient,
	MailboxEventHttpError,
	createMailboxEventClient,
} from "./event-client.js";
import { acquireConnectorLock } from "./lock.js";
import { planAutoPickup } from "./pickup.js";
import type { RuntimeAttentionAdapter } from "./runtime.js";
import {
	connectorCursor,
	connectorPickupDecision,
	loadConnectorState,
	persistConnectorProgress,
} from "./state.js";

const ACTIVATION_EVENT_KINDS = new Set<MailboxEvent["kind"]>([
	"thread.created",
	"message.appended",
]);

export type MailboxWatchStatus =
	| { type: "connected" }
	| {
			type: "queued";
			eventId: string;
			threadId: string;
			senderHandle: string;
	  }
	| {
			type: "skipped";
			cursor: string;
			reason: "not_activation" | "not_consented" | "duplicate" | "coalesced";
	  }
	| { type: "reconnecting"; delayMs: number; error: string };

export class ConnectorBindingChangedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConnectorBindingChangedError";
	}
}

export interface MailboxWatchOptions {
	relayUrl: string;
	agentId: string;
	client: MailboxEventClient;
	adapter: RuntimeAttentionAdapter;
	signal: AbortSignal;
	onStatus?: (status: MailboxWatchStatus) => void;
	once?: boolean;
	loadTrust?: typeof loadTrust;
	loadState?: typeof loadConnectorState;
	persistProgress?: typeof persistConnectorProgress;
	validateTarget?: () => Promise<void>;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	coalesceMs?: number;
}

export async function runMailboxWatch(opts: MailboxWatchOptions): Promise<void> {
	const loadState = opts.loadState ?? loadConnectorState;
	const persistProgress = opts.persistProgress ?? persistConnectorProgress;
	const readTrust = opts.loadTrust ?? loadTrust;
	const sleep = opts.sleep ?? abortableSleep;
	let cursor = connectorCursor(await loadState(), opts.relayUrl, opts.agentId);

	const persistCursor = async (
		event: MailboxEvent,
		pickup?: { senderHandle: string; threadId: string; eventId: string },
	) => {
		await persistProgress({
			relayUrl: opts.relayUrl,
			agentId: opts.agentId,
			cursor: event.cursor,
			...(pickup ? { pickup } : {}),
		});
		cursor = event.cursor;
	};

	const processEvent = async (event: MailboxEvent) => {
		if (cursor !== null && BigInt(event.cursor) <= BigInt(cursor)) return;
		if (!ACTIVATION_EVENT_KINDS.has(event.kind)) {
			await persistCursor(event);
			opts.onStatus?.({ type: "skipped", cursor: event.cursor, reason: "not_activation" });
			return;
		}

		const trustResult = await readTrust();
		if (!trustResult.ok) {
			throw new Error(
				`AgentRelay trust policy is ${trustResult.reason}; pickup will retry after it is fixed`,
			);
		}
		const pickup = planAutoPickup(trustResult.trust, {
			eventId: event.event_id,
			threadId: event.thread_id,
			senderHandle: event.actor_handle,
		});
		if (!pickup) {
			await persistCursor(event);
			opts.onStatus?.({ type: "skipped", cursor: event.cursor, reason: "not_consented" });
			return;
		}

		const reference = {
			relayUrl: opts.relayUrl,
			agentId: opts.agentId,
			senderHandle: event.actor_handle,
			threadId: event.thread_id,
			eventId: event.event_id,
		};
		await opts.validateTarget?.();
		const state = await loadState();
		const decision = connectorPickupDecision(state, reference, {
			coalesceMs: opts.coalesceMs,
		});
		if (decision !== "queue") {
			await persistCursor(event);
			opts.onStatus?.({ type: "skipped", cursor: event.cursor, reason: decision });
			return;
		}

		// Codex cannot currently apply a narrower per-turn tool envelope to a
		// queued follow-up. This first adapter therefore carries references only.
		await opts.adapter.enqueueAttention(pickup);
		await persistCursor(event, {
			senderHandle: event.actor_handle,
			threadId: event.thread_id,
			eventId: event.event_id,
		});
		opts.onStatus?.({
			type: "queued",
			eventId: event.event_id,
			threadId: event.thread_id,
			senderHandle: event.actor_handle,
		});
	};

	const drain = async () => {
		while (!opts.signal.aborted) {
			const page = await opts.client.list(cursor, 100, opts.signal);
			if (page.events.length === 0) return;
			let previous = cursor === null ? 0n : BigInt(cursor);
			for (const event of page.events) {
				const next = BigInt(event.cursor);
				if (next <= previous) {
					throw new Error("AgentRelay mailbox replay was not strictly cursor ordered");
				}
				previous = next;
				await processEvent(event);
			}
			if (page.events.length < 100) return;
		}
	};

	if (opts.once) {
		await drain();
		return;
	}

	let retryMs = 250;
	let initialReplayComplete = false;
	while (!opts.signal.aborted) {
		try {
			// Replay once before the first connection. Later reconnects replay only
			// after the server says the stream is ready, so a rejected or unsupported
			// stream can never degrade into interval polling.
			if (!initialReplayComplete) {
				await drain();
				initialReplayComplete = true;
			}
			await opts.client.stream(opts.signal, async (signal) => {
				await opts.validateTarget?.();
				if (signal.type === "heartbeat") return;
				await drain();
				if (signal.type === "ready") {
					retryMs = 250;
					opts.onStatus?.({ type: "connected" });
				}
			});
		} catch (error) {
			if (opts.signal.aborted) return;
			if (error instanceof ConnectorBindingChangedError) throw error;
			if (error instanceof MailboxEventHttpError && isPermanentClientError(error.status)) {
				throw error;
			}
			opts.onStatus?.({
				type: "reconnecting",
				delayMs: retryMs,
				error: error instanceof Error ? error.message : String(error),
			});
		}

		if (opts.signal.aborted) return;
		await sleep(retryMs, opts.signal);
		retryMs = Math.min(retryMs * 2, 10_000);
	}
}

function isPermanentClientError(status: number): boolean {
	return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export async function watchConfiguredCodex(opts: {
	signal: AbortSignal;
	once?: boolean;
	onStatus?: (status: MailboxWatchStatus) => void;
}): Promise<void> {
	const lock = await acquireConnectorLock();
	try {
		const configResult = await loadConfig();
		if (!configResult.ok) throw new Error(unavailableMessage(configResult));
		const binding = configResult.config.connector_binding;
		if (!binding || binding.runtime !== "codex") {
			throw new Error(
				"No Codex session is bound. From the receiving Codex chat, run `agentrelay bind codex` first.",
			);
		}
		await runMailboxWatch({
			relayUrl: configResult.config.relay_url,
			agentId: configResult.config.agent_id,
			client: createMailboxEventClient({
				relayUrl: configResult.config.relay_url,
				apiKey: configResult.config.api_key,
			}),
			adapter: createCodexAttentionAdapter({ threadId: binding.thread_id }),
			validateTarget: () =>
				assertCodexBindingCurrent({
					relayUrl: configResult.config.relay_url,
					agentId: configResult.config.agent_id,
					threadId: binding.thread_id,
				}),
			signal: opts.signal,
			once: opts.once,
			onStatus: opts.onStatus,
		});
	} finally {
		await lock.release();
	}
}

export async function assertCodexBindingCurrent(
	expected: { relayUrl: string; agentId: string; threadId: string },
	readConfig: typeof loadConfig = loadConfig,
): Promise<void> {
	const current = await readConfig();
	if (!current.ok) {
		throw new ConnectorBindingChangedError(
			"AgentRelay configuration changed or became unavailable; restart the connector after checking it",
		);
	}
	const binding = current.config.connector_binding;
	if (
		current.config.relay_url !== expected.relayUrl ||
		current.config.agent_id !== expected.agentId ||
		binding?.runtime !== "codex" ||
		binding.thread_id !== expected.threadId
	) {
		throw new ConnectorBindingChangedError(
			"The bound Codex thread changed; this connector stopped before queueing attention",
		);
	}
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});
}
