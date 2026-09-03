import { Response } from "undici";
import { describe, expect, it, vi } from "vitest";
import { consumeSse, createMailboxEventClient } from "./event-client.js";

describe("mailbox event client", () => {
	it("authenticates replay and rejects peer content in an event envelope", async () => {
		const fetch = vi.fn(async (_input: unknown, init?: { headers?: Record<string, string> }) => {
			expect(init?.headers?.authorization).toBe("Bearer secret-key");
			return new Response(
				JSON.stringify({
					events: [
						{
							event_id: "11111111-1111-4111-8111-111111111111",
							cursor: "1",
							kind: "thread.created",
							thread_id: "22222222-2222-4222-8222-222222222222",
							actor_handle: "alice@example",
							created_at: "2026-09-04T10:00:00.000Z",
							body: "peer-controlled content",
						},
					],
					next_cursor: "1",
				}),
				{ headers: { "content-type": "application/json" } },
			);
		});
		const client = createMailboxEventClient({
			relayUrl: "https://relay.example/",
			apiKey: "secret-key",
			fetch: fetch as never,
		});

		await expect(client.list(null)).rejects.toThrow();
	});

	it("parses chunked SSE data and ignores comments and unknown payloads", async () => {
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(": keepalive\n\nevent: ready\ndata:"));
				controller.enqueue(encoder.encode(' {"type":"ready"}\n\ndata: {"type":"future"}\n\n'));
				controller.enqueue(
					encoder.encode('event: mailbox.changed\ndata: {"type":"mailbox.changed"}\n\n'),
				);
				controller.close();
			},
		});
		const seen: string[] = [];
		await consumeSse(body, async (signal) => {
			seen.push(signal.type);
		});
		expect(seen).toEqual(["ready", "mailbox.changed"]);
	});

	it("rejects an invalid replay limit before making a request", async () => {
		const fetch = vi.fn();
		const client = createMailboxEventClient({
			relayUrl: "https://relay.example/",
			apiKey: "secret-key",
			fetch: fetch as never,
		});

		await expect(client.list(null, 201)).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
	});
});
