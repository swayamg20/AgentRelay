import { describe, expect, it, vi } from "vitest";
import {
	type MailboxEvent,
	type MailboxEventClient,
	MailboxEventHttpError,
} from "./event-client.js";
import { parseWatchOptions, runStdoutWatch } from "./stdout-watch.js";

const EVENT: MailboxEvent = {
	event_id: "11111111-1111-4111-8111-111111111111",
	cursor: "1",
	kind: "thread.created",
	thread_id: "22222222-2222-4222-8222-222222222222",
	actor_handle: "alice@example",
	created_at: "2026-10-28T10:00:00.000Z",
};

function event(cursor: number, kind: MailboxEvent["kind"] = "message.appended"): MailboxEvent {
	return {
		...EVENT,
		cursor: String(cursor),
		event_id: `11111111-1111-4111-8111-${String(cursor).padStart(12, "0")}`,
		kind,
	};
}

function clientWith(events: MailboxEvent[]): MailboxEventClient {
	return {
		list: vi.fn(async () => ({ events, next_cursor: events.at(-1)?.cursor ?? null })),
		stream: vi.fn(async () => undefined),
	};
}

describe("stdout watch options", () => {
	it("preserves attention defaults and accepts exact bigint cursor strings", () => {
		expect(parseWatchOptions({})).toEqual({ stdout: false, once: false });
		expect(parseWatchOptions({ stdout: true, afterCursor: "9223372036854775807" })).toEqual({
			stdout: true,
			once: false,
			afterCursor: "9223372036854775807",
		});
	});

	it.each(["", "0", "-1", "01", "1.5", "1e2", " 1", "9223372036854775808", 1, ["1"]])(
		"rejects invalid cursors before making a request: %j",
		async (afterCursor) => {
			const client = clientWith([]);
			await expect(
				runStdoutWatch({
					client,
					signal: new AbortController().signal,
					once: true,
					afterCursor: afterCursor as string,
					writeLine: vi.fn(),
				}),
			).rejects.toThrow("Invalid watch options");
			expect(client.list).not.toHaveBeenCalled();
			expect(client.stream).not.toHaveBeenCalled();
		},
	);

	it("does not permit a custom cursor to replace attention checkpoints", () => {
		expect(() => parseWatchOptions({ afterCursor: "1" })).toThrow("requires --stdout");
	});
});

describe("passive stdout mailbox replay", () => {
	it("writes only six-field NDJSON references and skips lifecycle events", async () => {
		const lines: string[] = [];
		const withExtraContent = { ...EVENT, body: "must not print", api_key: "must not print" };
		const client = clientWith([withExtraContent, event(2, "thread.accepted"), event(3)]);
		await runStdoutWatch({
			client,
			signal: new AbortController().signal,
			once: true,
			writeLine: (line) => {
				lines.push(line);
			},
		});
		expect(lines).toHaveLength(2);
		expect(lines.map((line) => JSON.parse(line))).toEqual([
			{
				event_id: EVENT.event_id,
				cursor: "1",
				thread_id: EVENT.thread_id,
				actor_handle: EVENT.actor_handle,
				kind: "thread.created",
				created_at: EVENT.created_at,
			},
			event(3),
		]);
		for (const line of lines) expect(line.split("\n")).toHaveLength(2);
		expect(lines.join("")).not.toContain("must not print");
		expect(client.list).toHaveBeenCalledWith(null, 100, expect.any(AbortSignal));
		expect(client.stream).not.toHaveBeenCalled();
	});

	it("uses bounded pages and advances over filtered lifecycle events", async () => {
		const firstPage = Array.from({ length: 100 }, (_, index) =>
			event(index + 1, "thread.accepted"),
		);
		const client = clientWith([]);
		vi.mocked(client.list)
			.mockResolvedValueOnce({ events: firstPage, next_cursor: "100" })
			.mockResolvedValueOnce({ events: [event(101)], next_cursor: "101" });
		const writeLine = vi.fn();
		await runStdoutWatch({ client, signal: new AbortController().signal, once: true, writeLine });
		expect(client.list).toHaveBeenNthCalledWith(1, null, 100, expect.any(AbortSignal));
		expect(client.list).toHaveBeenNthCalledWith(2, "100", 100, expect.any(AbortSignal));
		expect(writeLine).toHaveBeenCalledOnce();
		expect(JSON.parse(writeLine.mock.calls[0]?.[0]).cursor).toBe("101");
	});

	it("treats the supplied cursor as exclusive and suppresses duplicate replay", async () => {
		const client = clientWith([EVENT, event(2), event(2), event(3)]);
		const lines: string[] = [];
		await runStdoutWatch({
			client,
			signal: new AbortController().signal,
			once: true,
			afterCursor: "1",
			writeLine: (line) => {
				lines.push(line);
			},
		});
		expect(lines.map((line) => JSON.parse(line).cursor)).toEqual(["2", "3"]);
		expect(client.list).toHaveBeenCalledWith("1", 100, expect.any(AbortSignal));
	});

	it("rejects out-of-order new events rather than silently losing an event", async () => {
		const writeLine = vi.fn();
		await expect(
			runStdoutWatch({
				client: clientWith([event(3), event(2)]),
				signal: new AbortController().signal,
				once: true,
				writeLine,
			}),
		).rejects.toThrow("not cursor ordered");
		expect(writeLine).not.toHaveBeenCalled();
	});

	it("replays from the beginning again on a fresh process without a supplied cursor", async () => {
		const client = clientWith([EVENT]);
		const writeLine = vi.fn();
		const options = { client, signal: new AbortController().signal, once: true, writeLine };
		await runStdoutWatch(options);
		await runStdoutWatch(options);
		expect(writeLine).toHaveBeenCalledTimes(2);
		expect(writeLine.mock.calls[0]).toEqual(writeLine.mock.calls[1]);
		expect(client.list).toHaveBeenNthCalledWith(2, null, 100, expect.any(AbortSignal));
	});

	it("stops on output failure without retrying transports or exposing the error", async () => {
		const client = clientWith([EVENT]);
		await expect(
			runStdoutWatch({
				client,
				signal: new AbortController().signal,
				writeLine: () => {
					throw new Error("secret output error");
				},
			}),
		).rejects.toThrow("Could not write mailbox event references to stdout");
		expect(client.list).toHaveBeenCalledOnce();
		expect(client.stream).not.toHaveBeenCalled();
	});
});

describe("stdout watch live hints", () => {
	it("replays on ready, changed, resync and reconnect; heartbeat is not polling", async () => {
		const controller = new AbortController();
		const lines: string[] = [];
		const client = clientWith([]);
		vi.mocked(client.list)
			.mockResolvedValueOnce({ events: [EVENT], next_cursor: "1" })
			.mockResolvedValueOnce({ events: [], next_cursor: null })
			.mockResolvedValueOnce({ events: [EVENT, event(2)], next_cursor: "2" })
			.mockResolvedValueOnce({ events: [event(3)], next_cursor: "3" })
			.mockResolvedValueOnce({ events: [event(3), event(4)], next_cursor: "4" });
		vi.mocked(client.stream)
			.mockImplementationOnce(async (_signal, onSignal) => {
				await onSignal({ type: "ready" });
				await onSignal({ type: "heartbeat" });
				await onSignal({ type: "mailbox.changed" });
				await onSignal({ type: "resync" });
				throw new Error("secret upstream disconnect");
			})
			.mockImplementationOnce(async (_signal, onSignal) => {
				await onSignal({ type: "ready" });
				controller.abort();
			});
		const onStatus = vi.fn();
		const sleep = vi.fn(async () => undefined);
		await runStdoutWatch({
			client,
			signal: controller.signal,
			writeLine: (line) => {
				lines.push(line);
			},
			onStatus,
			sleep,
		});
		expect(lines.map((line) => JSON.parse(line).cursor)).toEqual(["1", "2", "3", "4"]);
		expect(client.list).toHaveBeenCalledTimes(5);
		expect(client.list).toHaveBeenNthCalledWith(5, "3", 100, controller.signal);
		expect(sleep).toHaveBeenCalledOnce();
		expect(onStatus.mock.calls.map(([status]) => status)).toEqual([
			{ type: "connected" },
			{ type: "reconnecting", delayMs: 250 },
			{ type: "connected" },
		]);
		expect(JSON.stringify(onStatus.mock.calls)).not.toContain("secret");
	});

	it.each([401, 403, 404, 501])(
		"does not fall back to replay polling after HTTP %i",
		async (status) => {
			const controller = new AbortController();
			const client = clientWith([]);
			vi.mocked(client.stream).mockRejectedValue(
				new MailboxEventHttpError("mailbox stream", status),
			);
			const sleep = vi.fn(async () => {
				controller.abort();
			});
			const task = runStdoutWatch({ client, signal: controller.signal, writeLine: vi.fn(), sleep });
			if (status < 500) await expect(task).rejects.toThrow(`HTTP ${status}`);
			else await task;
			expect(client.list).toHaveBeenCalledOnce();
			expect(client.stream).toHaveBeenCalledOnce();
		},
	);

	it("fails a permanent authentication error in initial replay without opening a stream", async () => {
		const client = clientWith([]);
		vi.mocked(client.list).mockRejectedValue(new MailboxEventHttpError("mailbox replay", 401));
		await expect(
			runStdoutWatch({ client, signal: new AbortController().signal, writeLine: vi.fn() }),
		).rejects.toThrow("HTTP 401");
		expect(client.list).toHaveBeenCalledOnce();
		expect(client.stream).not.toHaveBeenCalled();
	});

	it("aborts an in-flight replay and does not print its late result", async () => {
		const controller = new AbortController();
		const client = clientWith([EVENT]);
		vi.mocked(client.list).mockImplementationOnce(async () => {
			controller.abort();
			return { events: [EVENT], next_cursor: "1" };
		});
		const writeLine = vi.fn();
		await runStdoutWatch({ client, signal: controller.signal, once: true, writeLine });
		expect(writeLine).not.toHaveBeenCalled();
		expect(client.stream).not.toHaveBeenCalled();
	});

	it("aborts reconnect backoff without making another request", async () => {
		const controller = new AbortController();
		const client = clientWith([]);
		vi.mocked(client.stream).mockRejectedValue(new Error("disconnected"));
		await runStdoutWatch({
			client,
			signal: controller.signal,
			writeLine: vi.fn(),
			onStatus: () => {
				controller.abort();
			},
		});
		expect(client.list).toHaveBeenCalledOnce();
		expect(client.stream).toHaveBeenCalledOnce();
	});
});
