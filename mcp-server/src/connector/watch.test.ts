import { describe, expect, it, vi } from "vitest";
import type { AgentRelayConfig } from "../config.js";
import type { TrustFile } from "../trust.js";
import { type MailboxEventClient, MailboxEventHttpError } from "./event-client.js";
import type { RuntimeAttentionAdapter } from "./runtime.js";
import { EMPTY_CONNECTOR_STATE } from "./state.js";
import {
	ConnectorBindingChangedError,
	assertCodexBindingCurrent,
	runMailboxWatch,
} from "./watch.js";

const EVENT = {
	event_id: "11111111-1111-4111-8111-111111111111",
	cursor: "1",
	kind: "thread.created" as const,
	thread_id: "22222222-2222-4222-8222-222222222222",
	actor_handle: "alice@example",
	created_at: "2026-09-04T10:00:00.000Z",
};

function clientWithEvent(): MailboxEventClient {
	return {
		list: vi.fn(async () => ({ events: [EVENT], next_cursor: "1" })),
		stream: vi.fn(async () => undefined),
	};
}

function trust(autoPickup: boolean): TrustFile {
	return {
		version: 1,
		teammates: { "alice@example": { auto_pickup: autoPickup, auto_read: true } },
		unknown_teammates: { policy: "reject" },
		blocked: [],
		defaults: {},
	};
}

describe("runMailboxWatch", () => {
	it("queues content-free attention after exact-sender consent, then checkpoints", async () => {
		const enqueueAttention = vi.fn(async () => ({
			state: "runtime_queued" as const,
			runtime: "fake",
			targetId: "local-session",
		}));
		const persistProgress = vi.fn(async () => undefined);
		await runMailboxWatch({
			relayUrl: "https://relay.example",
			agentId: "receiver-id",
			client: clientWithEvent(),
			adapter: { enqueueAttention },
			signal: new AbortController().signal,
			once: true,
			loadTrust: async () => ({ ok: true, trust: trust(true), path: "/trust", source: "file" }),
			loadState: async () => structuredClone(EMPTY_CONNECTOR_STATE),
			persistProgress: persistProgress as never,
		});

		expect(enqueueAttention).toHaveBeenCalledWith({
			eventId: EVENT.event_id,
			threadId: EVENT.thread_id,
		});
		expect(persistProgress).toHaveBeenCalledOnce();
		expect(persistProgress.mock.calls[0]?.[0]).toMatchObject({
			cursor: "1",
			pickup: {
				eventId: EVENT.event_id,
				threadId: EVENT.thread_id,
				senderHandle: EVENT.actor_handle,
			},
		});
	});

	it("checkpoints an event without touching the runtime when consent is absent", async () => {
		const adapter: RuntimeAttentionAdapter = { enqueueAttention: vi.fn() };
		const persistProgress = vi.fn(async () => undefined);
		await runMailboxWatch({
			relayUrl: "https://relay.example",
			agentId: "receiver-id",
			client: clientWithEvent(),
			adapter,
			signal: new AbortController().signal,
			once: true,
			loadTrust: async () => ({ ok: true, trust: trust(false), path: "/trust", source: "file" }),
			loadState: async () => structuredClone(EMPTY_CONNECTOR_STATE),
			persistProgress: persistProgress as never,
		});

		expect(adapter.enqueueAttention).not.toHaveBeenCalled();
		expect(persistProgress.mock.calls[0]?.[0]).toMatchObject({ cursor: "1" });
		expect(persistProgress.mock.calls[0]?.[0]).not.toHaveProperty("pickup");
	});

	it("does not advance the cursor when runtime enqueue fails", async () => {
		const persistProgress = vi.fn(async () => undefined);
		await expect(
			runMailboxWatch({
				relayUrl: "https://relay.example",
				agentId: "receiver-id",
				client: clientWithEvent(),
				adapter: {
					enqueueAttention: async () => {
						throw new Error("runtime unavailable");
					},
				},
				signal: new AbortController().signal,
				once: true,
				loadTrust: async () => ({
					ok: true,
					trust: trust(true),
					path: "/trust",
					source: "file",
				}),
				loadState: async () => structuredClone(EMPTY_CONNECTOR_STATE),
				persistProgress: persistProgress as never,
			}),
		).rejects.toThrow("runtime unavailable");
		expect(persistProgress).not.toHaveBeenCalled();
	});

	it("does not advance the cursor while the trust file is invalid", async () => {
		const persistProgress = vi.fn(async () => undefined);
		const enqueueAttention = vi.fn();
		await expect(
			runMailboxWatch({
				relayUrl: "https://relay.example",
				agentId: "receiver-id",
				client: clientWithEvent(),
				adapter: { enqueueAttention },
				signal: new AbortController().signal,
				once: true,
				loadTrust: async () => ({
					ok: false,
					reason: "malformed",
					path: "/trust",
				}),
				loadState: async () => structuredClone(EMPTY_CONNECTOR_STATE),
				persistProgress: persistProgress as never,
			}),
		).rejects.toThrow("pickup will retry");
		expect(enqueueAttention).not.toHaveBeenCalled();
		expect(persistProgress).not.toHaveBeenCalled();
	});

	it("revalidates the local target before enqueue and preserves the event if it changed", async () => {
		const persistProgress = vi.fn(async () => undefined);
		const enqueueAttention = vi.fn();
		await expect(
			runMailboxWatch({
				relayUrl: "https://relay.example",
				agentId: "receiver-id",
				client: clientWithEvent(),
				adapter: { enqueueAttention },
				signal: new AbortController().signal,
				once: true,
				loadTrust: async () => ({ ok: true, trust: trust(true), path: "/trust", source: "file" }),
				loadState: async () => structuredClone(EMPTY_CONNECTOR_STATE),
				persistProgress: persistProgress as never,
				validateTarget: async () => {
					throw new ConnectorBindingChangedError("binding changed");
				},
			}),
		).rejects.toThrow("binding changed");
		expect(enqueueAttention).not.toHaveBeenCalled();
		expect(persistProgress).not.toHaveBeenCalled();
	});

	it("fails instead of falling back to polling when the live route is unsupported", async () => {
		const sleep = vi.fn(async () => undefined);
		const client: MailboxEventClient = {
			list: vi.fn(async () => ({ events: [], next_cursor: null })),
			stream: vi.fn(async () => {
				throw new MailboxEventHttpError("mailbox stream", 404);
			}),
		};

		await expect(
			runMailboxWatch({
				relayUrl: "https://relay.example",
				agentId: "receiver-id",
				client,
				adapter: {
					enqueueAttention: vi.fn(async () => ({
						state: "runtime_queued",
						runtime: "fake",
						targetId: "local-session",
					})),
				},
				signal: new AbortController().signal,
				loadState: async () => structuredClone(EMPTY_CONNECTOR_STATE),
				sleep,
			}),
		).rejects.toThrow("HTTP 404");
		expect(client.list).toHaveBeenCalledOnce();
		expect(sleep).not.toHaveBeenCalled();
	});

	it("does not replay on a reconnect until the replacement stream is ready", async () => {
		const controller = new AbortController();
		const order: string[] = [];
		let streamAttempt = 0;
		const client: MailboxEventClient = {
			list: vi.fn(async () => {
				order.push("list");
				return { events: [], next_cursor: null };
			}),
			stream: vi.fn(async (_signal, onSignal) => {
				order.push("stream");
				streamAttempt += 1;
				if (streamAttempt === 1) {
					throw new MailboxEventHttpError("mailbox stream", 503);
				}
				await onSignal({ type: "ready" });
				controller.abort();
			}),
		};
		await runMailboxWatch({
			relayUrl: "https://relay.example",
			agentId: "receiver-id",
			client,
			adapter: { enqueueAttention: vi.fn() },
			signal: controller.signal,
			loadState: async () => structuredClone(EMPTY_CONNECTOR_STATE),
			sleep: async () => {
				order.push("sleep");
			},
		});

		expect(order).toEqual(["list", "stream", "sleep", "stream", "list"]);
	});
});

describe("assertCodexBindingCurrent", () => {
	const expected = {
		relayUrl: "https://relay.example",
		agentId: "receiver-id",
		threadId: "22222222-2222-4222-8222-222222222222",
	};
	const config: AgentRelayConfig = {
		relay_url: expected.relayUrl,
		agent_handle: "receiver@example",
		agent_id: expected.agentId,
		api_key: "secret",
		default_session_id: null,
		connector_binding: { runtime: "codex", thread_id: expected.threadId },
	};

	it("accepts only the same mailbox and locally bound Codex thread", async () => {
		await expect(
			assertCodexBindingCurrent(expected, async () => ({
				ok: true,
				config,
				path: "/config",
			})),
		).resolves.toBeUndefined();

		await expect(
			assertCodexBindingCurrent(expected, async () => ({
				ok: true,
				config: { ...config, connector_binding: null },
				path: "/config",
			})),
		).rejects.toThrow("connector stopped");
	});
});
