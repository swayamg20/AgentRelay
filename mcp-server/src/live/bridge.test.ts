import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MailboxEventHttpError } from "../connector/event-client.js";
import { wrap } from "../provenance.js";
import type { ViewThreadResult } from "../tools/view-thread.js";
import { type LiveBridgeOptions, runLiveBridge } from "./bridge.js";
import { type LiveJournal, LiveSessionError, liveJournalSchema } from "./contracts.js";

function fixture() {
	const scope = {
		relayUrl: "https://relay.example",
		agentId: randomUUID(),
		localHandle: "bob@team",
		peerHandle: "alice@team",
		threadId: randomUUID(),
	};
	let state: LiveJournal = {
		version: 1,
		scope,
		maxTurns: 6,
		expiresAt: Date.now() + 60_000,
		lastSequence: 0,
		turnsStarted: 0,
		pending: null,
		receipts: [],
	};
	const thread: ViewThreadResult = {
		thread_id: scope.threadId,
		intent: "inform",
		summary: wrap({ senderHandle: scope.peerHandle, content: "hello" }),
		sender: { handle: scope.peerHandle, name: "Alice", role: "developer" },
		recipient: { handle: scope.localHandle, name: "Bob", role: "developer" },
		artifacts: [],
		metadata: {},
		completion_artifacts: [],
		completed_at: null,
		cancelled_at: null,
		messages: [
			{
				id: randomUUID(),
				sequence_no: 1,
				from: scope.peerHandle,
				body: wrap({ senderHandle: scope.peerHandle, content: "hello" }),
				artifacts: [],
				created_at: new Date().toISOString(),
			},
		],
	};
	const controller = new AbortController();
	const keys: string[] = [];
	const storedReplies = new Map<string, string>();
	const options: LiveBridgeOptions = {
		store: {
			read: () => structuredClone(state),
			save: async (next) => {
				state = liveJournalSchema.parse(next);
			},
		},
		mailbox: {
			read: vi.fn(async () => structuredClone(thread)),
			reply: vi.fn(async (input) => {
				keys.push(input.idempotencyKey);
				const existing = storedReplies.get(input.idempotencyKey);
				if (existing) return existing;
				const id = randomUUID();
				storedReplies.set(input.idempotencyKey, id);
				thread.messages.push({
					id,
					sequence_no: thread.messages.length + 1,
					from: scope.localHandle,
					body: input.body,
					artifacts: [],
					created_at: new Date().toISOString(),
				});
				return id;
			}),
		},
		events: {
			stream: vi.fn(async (_signal, onSignal) => {
				await onSignal({ type: "ready" });
				await onSignal({ type: "mailbox.changed" });
				controller.abort();
			}),
		},
		runtime: {
			prepare: vi.fn(async () => {}),
			runTurn: vi.fn(async () => ({
				reply: "hello back",
				host: { threadId: "owned-host", turnId: randomUUID() },
			})),
			close: vi.fn(async () => {}),
		},
		signal: controller.signal,
		assertAuthority: vi.fn(async () => {}),
	};
	return { options, thread, keys, storedReplies, controller };
}

describe("live Relay bridge", () => {
	it("automatically receives and replies, deduplicates hints and never responds to itself", async () => {
		const { options } = fixture();
		const statuses: string[] = [];
		options.onStatus = (event) => statuses.push(event.type);
		await runLiveBridge(options);
		expect(options.runtime.runTurn).toHaveBeenCalledTimes(1);
		expect(options.mailbox.reply).toHaveBeenCalledTimes(1);
		expect(options.store.read()).toMatchObject({ turnsStarted: 1, lastSequence: 2, pending: null });
		expect(statuses).toEqual(["starting", "completed", "replied", "ready"]);
		expect(options.runtime.close).toHaveBeenCalledOnce();
	});

	it("persists intent before starting and replies only after runtime completion", async () => {
		const { options } = fixture();
		options.once = true;
		options.runtime.prepare = vi.fn(async () => {
			expect(options.store.read().pending).toBeNull();
			expect(options.store.read().turnsStarted).toBe(0);
		});
		options.runtime.runTurn = vi.fn(async () => {
			expect(options.store.read().pending?.phase).toBe("running");
			expect(options.mailbox.reply).not.toHaveBeenCalled();
			return { reply: "answer", host: { threadId: "h", turnId: "t" } };
		});
		await runLiveBridge(options);
		expect(options.store.read().receipts[0]).toMatchObject({
			disposition: "replied",
			host: { threadId: "h", turnId: "t" },
		});
	});

	it("keeps setup failures retryable without consuming a turn or recording uncertainty", async () => {
		const { options } = fixture();
		options.once = true;
		options.runtime.prepare = vi
			.fn(async () => {})
			.mockRejectedValueOnce(new LiveSessionError("codex_version", "wrong Codex version"));
		await expect(runLiveBridge(options)).rejects.toThrow("wrong Codex version");
		expect(options.store.read()).toMatchObject({ pending: null, turnsStarted: 0, lastSequence: 0 });
		expect(options.runtime.runTurn).not.toHaveBeenCalled();
		await runLiveBridge(options);
		expect(options.runtime.runTurn).toHaveBeenCalledOnce();
		expect(options.mailbox.reply).toHaveBeenCalledOnce();
	});

	it("rechecks local authority after host preparation and before recording intent", async () => {
		const { options } = fixture();
		options.runtime.prepare = vi.fn(async () => {
			options.assertAuthority = async () => {
				throw new LiveSessionError("blocked", "locally blocked");
			};
		});
		await expect(runLiveBridge(options)).rejects.toThrow("locally blocked");
		expect(options.runtime.runTurn).not.toHaveBeenCalled();
		expect(options.store.read()).toMatchObject({ pending: null, turnsStarted: 0 });
	});

	it("recovers a lost Relay response with the same outbox key, without rerunning the model", async () => {
		const { options, storedReplies, keys } = fixture();
		options.once = true;
		const publish = options.mailbox.reply;
		options.mailbox.reply = vi.fn(async (input, signal) => {
			await publish(input, signal);
			throw new LiveSessionError("simulated_process_loss", "stop at lost response");
		});
		await expect(runLiveBridge(options)).rejects.toThrow("lost response");
		expect(options.store.read().pending?.phase).toBe("reply_ready");
		options.mailbox.reply = publish;
		options.runtime.prepare = vi.fn(async () => {
			throw new LiveSessionError("codex_missing", "host unavailable during reply recovery");
		});
		await runLiveBridge(options);
		expect(options.runtime.prepare).not.toHaveBeenCalled();
		expect(options.runtime.runTurn).toHaveBeenCalledOnce();
		expect(keys).toHaveLength(2);
		expect(keys[0]).toBe(keys[1]);
		expect(storedReplies.size).toBe(1);
		expect(options.store.read().pending).toBeNull();
	});

	it("does not replay an uncertain model start after restart", async () => {
		const { options } = fixture();
		options.runtime.runTurn = vi.fn(async () => {
			throw new LiveSessionError("host_lost", "host gone");
		});
		await expect(runLiveBridge(options)).rejects.toThrow("host gone");
		await expect(runLiveBridge(options)).rejects.toThrow("unknown outcome");
		expect(options.runtime.runTurn).toHaveBeenCalledOnce();
		expect(options.mailbox.reply).not.toHaveBeenCalled();
	});

	it("rechecks revocation after model completion and before publication", async () => {
		const { options } = fixture();
		options.runtime.runTurn = vi.fn(async () => {
			options.assertAuthority = async () => {
				throw new LiveSessionError("blocked", "locally blocked");
			};
			return { reply: "must not publish", host: { threadId: "h", turnId: "t" } };
		});
		await expect(runLiveBridge(options)).rejects.toThrow("locally blocked");
		expect(options.mailbox.reply).not.toHaveBeenCalled();
		expect(options.store.read().pending?.phase).toBe("reply_ready");
	});

	it("does not read or activate another participant pair", async () => {
		const { options, thread } = fixture();
		thread.recipient!.handle = "mallory@team";
		await expect(runLiveBridge(options)).rejects.toThrow("participant pair");
		expect(options.runtime.runTurn).not.toHaveBeenCalled();
	});

	it("enforces the persisted turn limit across another run", async () => {
		const { options, thread } = fixture();
		await options.store.save({ ...options.store.read(), maxTurns: 1 });
		await runLiveBridge(options);
		thread.messages.push({ ...thread.messages[0]!, id: randomUUID(), sequence_no: 3 });
		await runLiveBridge(options);
		expect(options.runtime.runTurn).toHaveBeenCalledOnce();
		expect(options.events.stream).not.toHaveBeenCalled();
	});

	it("supports ending the conversation without a reply", async () => {
		const { options } = fixture();
		options.once = true;
		options.runtime.runTurn = vi.fn(async () => ({
			reply: null,
			host: { threadId: "h", turnId: "t" },
		}));
		await runLiveBridge(options);
		expect(options.mailbox.reply).not.toHaveBeenCalled();
		expect(options.store.read().receipts[0]?.disposition).toBe("no_reply");
	});

	it("refuses expired grants, oversized input and terminal threads before model use", async () => {
		for (const mode of ["expiry", "size", "terminal"]) {
			const { options, thread } = fixture();
			options.once = true;
			if (mode === "expiry") options.now = () => options.store.read().expiresAt + 1;
			if (mode === "size") thread.messages[0]!.body = "x".repeat(33_000);
			if (mode === "terminal") thread.completed_at = new Date().toISOString();
			await expect(runLiveBridge(options)).rejects.toBeInstanceOf(LiveSessionError);
			expect(options.runtime.runTurn).not.toHaveBeenCalled();
		}
	});

	it("does not fall back to polling when SSE is denied", async () => {
		const { options, thread } = fixture();
		thread.messages = [];
		options.events.stream = vi.fn(async () => {
			throw new MailboxEventHttpError("stream", 403);
		});
		await expect(runLiveBridge(options)).rejects.toThrow("403");
		expect(options.mailbox.read).toHaveBeenCalledOnce();
		expect(options.events.stream).toHaveBeenCalledOnce();
	});

	it("replays messages received while disconnected when the stream becomes ready", async () => {
		const { options, thread, controller } = fixture();
		const inbound = thread.messages[0]!;
		thread.messages = [];
		options.events.stream = vi.fn(async (_signal, hint) => {
			thread.messages.push(inbound);
			await hint({ type: "ready" });
			await hint({ type: "resync" });
			await hint({ type: "heartbeat" });
			controller.abort();
		});
		await runLiveBridge(options);
		expect(options.runtime.runTurn).toHaveBeenCalledOnce();
		expect(options.mailbox.reply).toHaveBeenCalledOnce();
	});
});
