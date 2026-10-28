import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type MailboxEvent,
	type MailboxEventClient,
	MailboxEventHttpError,
} from "./event-client.js";
import {
	type StdoutWatchOptions,
	parseStdoutWatchCursor,
	runStdoutMailboxWatch,
} from "./stdout-watch.js";

function event(sequence: number, kind: MailboxEvent["kind"] = "message.appended"): MailboxEvent {
	return {
		event_id: `10000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
		cursor: String(sequence),
		thread_id: "20000000-0000-4000-8000-000000000000",
		actor_handle: "sender@team",
		kind,
		created_at: "2026-10-28T00:00:00.000Z",
	};
}

function replayClient(events: MailboxEvent[]) {
	return {
		list: vi.fn(async (cursor: string | null, limit = 100) => {
			const page = events
				.filter((item) => BigInt(item.cursor) > BigInt(cursor ?? "0"))
				.slice(0, limit);
			return { events: page, next_cursor: page.at(-1)?.cursor ?? cursor };
		}),
		stream: vi.fn<MailboxEventClient["stream"]>(),
	};
}

afterEach(() => vi.restoreAllMocks());

describe("passive stdout mailbox replay", () => {
	it("drains bounded ordered pages from the beginning and emits only explicit metadata references", async () => {
		const events = Array.from({ length: 105 }, (_, index) => event(index + 1));
		events[0] = event(1, "thread.created");
		events[1] = event(2, "thread.accepted");
		events[2] = event(3, "thread.completed");
		events[3] = event(4, "thread.cancelled");
		Object.assign(events[0]!, {
			body: "must not be emitted",
			extra: { secret: "not event metadata" },
		});
		const client = replayClient(events);
		const onEvent = vi.fn<StdoutWatchOptions["onEvent"]>(async () => undefined);
		await runStdoutMailboxWatch({
			client,
			signal: new AbortController().signal,
			once: true,
			onEvent,
		});
		expect(client.list.mock.calls.map(([cursor, limit]) => [cursor, limit])).toEqual([
			[null, 100],
			["100", 100],
		]);
		expect(client.stream).not.toHaveBeenCalled();
		expect(onEvent).toHaveBeenCalledTimes(102);
		expect(onEvent.mock.calls[0]?.[0]).toEqual(event(1, "thread.created"));
		expect(onEvent.mock.calls.at(-1)?.[0]).toEqual(event(105));
		expect(JSON.stringify(onEvent.mock.calls)).not.toContain("must not be emitted");
	});

	it("treats an explicit cursor as exclusive and has no saved checkpoint across runs", async () => {
		const client = replayClient([event(1), event(2), event(3)]);
		const onEvent = vi.fn<StdoutWatchOptions["onEvent"]>(async () => undefined);
		await runStdoutMailboxWatch({
			client,
			signal: new AbortController().signal,
			once: true,
			afterCursor: "2",
			onEvent,
		});
		expect(onEvent).toHaveBeenCalledExactlyOnceWith(event(3));
		onEvent.mockClear();
		await runStdoutMailboxWatch({
			client,
			signal: new AbortController().signal,
			once: true,
			onEvent,
		});
		expect(onEvent.mock.calls.map(([item]) => item.cursor)).toEqual(["1", "2", "3"]);
	});

	it.each([
		"",
		"0",
		"-1",
		"01",
		"1.0",
		" 1",
		"1 ",
		"1e3",
		"9223372036854775808",
		"10000000000000000000",
		1,
		false,
		{},
	])("rejects invalid cursor %j before any replay or stream request", async (cursor) => {
		const client = replayClient([]);
		await expect(
			runStdoutMailboxWatch({
				client,
				signal: new AbortController().signal,
				once: true,
				afterCursor: cursor as never,
				onEvent: async () => undefined,
			}),
		).rejects.toThrow("--after-cursor");
		expect(client.list).not.toHaveBeenCalled();
		expect(client.stream).not.toHaveBeenCalled();
	});

	it("accepts omitted, null, and maximum bigint cursors without numeric conversion", () => {
		expect(parseStdoutWatchCursor(undefined)).toBeNull();
		expect(parseStdoutWatchCursor(null)).toBeNull();
		expect(parseStdoutWatchCursor("9223372036854775807")).toBe("9223372036854775807");
	});

	it("suppresses repeated events in one page and later replay", async () => {
		const controller = new AbortController();
		const client = replayClient([]);
		client.list.mockResolvedValueOnce({ events: [event(1), event(1), event(2)], next_cursor: "2" });
		client.list.mockResolvedValueOnce({ events: [event(1), event(2), event(3)], next_cursor: "3" });
		client.stream.mockImplementation(async (_, onSignal) => {
			await onSignal({ type: "ready" });
			controller.abort();
		});
		const onEvent = vi.fn<StdoutWatchOptions["onEvent"]>(async () => undefined);
		await runStdoutMailboxWatch({ client, signal: controller.signal, onEvent });
		expect(onEvent.mock.calls.map(([item]) => item.cursor)).toEqual(["1", "2", "3"]);
	});

	it.each([
		{ events: [event(2), event(1)], next_cursor: "1", error: "not cursor ordered" },
		{
			events: Array.from({ length: 101 }, (_, index) => event(index + 1)),
			next_cursor: "101",
			error: "page limit",
		},
		{
			events: Array.from({ length: 100 }, () => event(1)),
			next_cursor: "1",
			error: "no cursor progress",
		},
	])(
		"fails rather than silently accepting malformed replay: $error",
		async ({ events, next_cursor, error }) => {
			const client = replayClient([]);
			client.list.mockResolvedValue({ events, next_cursor });
			await expect(
				runStdoutMailboxWatch({
					client,
					signal: new AbortController().signal,
					afterCursor: error === "no cursor progress" ? "1" : null,
					once: true,
					onEvent: async () => undefined,
				}),
			).rejects.toThrow(error);
		},
	);

	it("does not retry output failure or expose the output error's sensitive detail", async () => {
		const client = replayClient([event(1)]);
		const sleep = vi.fn();
		await expect(
			runStdoutMailboxWatch({
				client,
				signal: new AbortController().signal,
				onEvent: async () => {
					throw new Error("private output detail");
				},
				sleep,
			}),
		).rejects.toThrow("Could not write mailbox event to stdout");
		expect(client.list).toHaveBeenCalledTimes(1);
		expect(client.stream).not.toHaveBeenCalled();
		expect(sleep).not.toHaveBeenCalled();
	});

	it("stops between events when aborted and does not start a live stream", async () => {
		const controller = new AbortController();
		const client = replayClient([event(1), event(2)]);
		const onEvent = vi.fn(async () => controller.abort());
		await runStdoutMailboxWatch({ client, signal: controller.signal, onEvent });
		expect(onEvent).toHaveBeenCalledTimes(1);
		expect(client.stream).not.toHaveBeenCalled();
	});

	it.each([true, false])("cancels an in-flight replay cleanly (once=%s)", async (once) => {
		const controller = new AbortController();
		const client = replayClient([]);
		client.list.mockImplementation(async () => {
			controller.abort();
			throw new Error("request aborted");
		});
		await expect(
			runStdoutMailboxWatch({
				client,
				signal: controller.signal,
				once,
				onEvent: async () => undefined,
			}),
		).resolves.toBeUndefined();
		expect(client.stream).not.toHaveBeenCalled();
	});

	it("makes no requests when already aborted", async () => {
		const client = replayClient([]);
		await runStdoutMailboxWatch({
			client,
			signal: AbortSignal.abort(),
			once: true,
			onEvent: async () => undefined,
		});
		expect(client.list).not.toHaveBeenCalled();
	});
});

describe("passive stdout live hints and reconnection", () => {
	it("replays on ready, changed, and resync hints, not heartbeat or hint payloads", async () => {
		const controller = new AbortController();
		const events = [event(1)];
		const client = replayClient(events);
		client.stream.mockImplementation(async (_, onSignal) => {
			events.push(event(2));
			await onSignal({ type: "ready" });
			await onSignal({ type: "heartbeat" });
			events.push(event(3));
			await onSignal({ type: "resync" });
			await onSignal({ type: "mailbox.changed" });
			controller.abort();
		});
		const onEvent = vi.fn<StdoutWatchOptions["onEvent"]>(async () => undefined);
		await runStdoutMailboxWatch({ client, signal: controller.signal, onEvent });
		expect(client.list.mock.calls.map(([cursor]) => cursor)).toEqual([null, "1", "2", "3"]);
		expect(onEvent.mock.calls.map(([item]) => item.cursor)).toEqual(["1", "2", "3"]);
	});

	it("replays only after successful stream reconnection with bounded backoff and safe diagnostics", async () => {
		const controller = new AbortController();
		const client = replayClient([]);
		let connections = 0;
		client.stream.mockImplementation(async (_, onSignal) => {
			connections += 1;
			if (connections === 8) await onSignal({ type: "ready" });
			if (connections === 9) {
				await onSignal({ type: "resync" });
				controller.abort();
				return;
			}
			throw new TypeError("sensitive transport detail");
		});
		const sleep = vi.fn<NonNullable<StdoutWatchOptions["sleep"]>>(async () => undefined);
		const onStatus = vi.fn();
		await runStdoutMailboxWatch({
			client,
			signal: controller.signal,
			onEvent: async () => undefined,
			sleep,
			onStatus,
		});
		expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
			250, 500, 1000, 2000, 4000, 8000, 10000, 250,
		]);
		expect(client.list).toHaveBeenCalledTimes(3);
		expect(JSON.stringify(onStatus.mock.calls)).not.toContain("sensitive transport detail");
	});

	it.each([400, 401, 403, 404])(
		"fails permanently on stream HTTP %s without polling fallback",
		async (status) => {
			const client = replayClient([]);
			client.stream.mockRejectedValue(new MailboxEventHttpError("mailbox stream", status));
			const sleep = vi.fn();
			await expect(
				runStdoutMailboxWatch({
					client,
					signal: new AbortController().signal,
					onEvent: async () => undefined,
					sleep,
				}),
			).rejects.toMatchObject({ status });
			expect(client.list).toHaveBeenCalledTimes(1);
			expect(client.stream).toHaveBeenCalledTimes(1);
			expect(sleep).not.toHaveBeenCalled();
		},
	);

	it("fails immediately on replay authentication error", async () => {
		const client = replayClient([]);
		client.list.mockRejectedValue(new MailboxEventHttpError("mailbox replay", 401));
		await expect(
			runStdoutMailboxWatch({
				client,
				signal: new AbortController().signal,
				onEvent: async () => undefined,
			}),
		).rejects.toMatchObject({ status: 401 });
		expect(client.stream).not.toHaveBeenCalled();
	});

	it.each([408, 429, 500, 503])(
		"retries transient stream HTTP %s and cancels retry sleep",
		async (status) => {
			const controller = new AbortController();
			const client = replayClient([]);
			client.stream.mockRejectedValue(new MailboxEventHttpError("mailbox stream", status));
			const onStatus = vi.fn(() => controller.abort());
			await expect(
				runStdoutMailboxWatch({
					client,
					signal: controller.signal,
					onEvent: async () => undefined,
					onStatus,
				}),
			).resolves.toBeUndefined();
			expect(client.stream).toHaveBeenCalledTimes(1);
			expect(onStatus).toHaveBeenCalledExactlyOnceWith({ type: "reconnecting", delayMs: 250 });
		},
	);
});
