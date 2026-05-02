import { describe, expect, it, vi } from "vitest";
import { A2AHttpError, A2ARpcError, createA2AClient } from "./a2a-client.js";

type FetchSig = Parameters<typeof createA2AClient>[0]["fetch"];

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function makeClient(fetchImpl: NonNullable<FetchSig>, overrides: Record<string, unknown> = {}) {
	let counter = 0;
	const sleep = vi.fn().mockResolvedValue(undefined);
	const uuid = vi.fn(() => `uuid-${++counter}`);
	const client = createA2AClient({
		relayUrl: "https://relay.test",
		apiKey: "ah_test_secret",
		fetch: fetchImpl,
		sleep,
		uuid,
		backoffBaseMs: 1,
		...overrides,
	});
	return { client, sleep, uuid };
}

describe("a2a-client.request", () => {
	it("posts JSON-RPC envelope with bearer auth and idempotency key", async () => {
		const fetchImpl = vi.fn(async (_url: unknown, init: any) => {
			const parsed = JSON.parse(init.body as string);
			expect(parsed.jsonrpc).toBe("2.0");
			expect(parsed.method).toBe("message/send");
			expect(parsed.params.recipient).toBe("frank@acme");
			expect(parsed.params.metadata.client_idempotency_key).toBe("uuid-1");
			expect(init.headers.authorization).toBe("Bearer ah_test_secret");
			expect(init.headers["idempotency-key"]).toBe("uuid-1");
			return jsonResponse({ jsonrpc: "2.0", id: parsed.id, result: { task_id: "t1" } });
		}) as unknown as NonNullable<FetchSig>;

		const { client } = makeClient(fetchImpl);
		const result = await client.request<{ task_id: string }>("message/send", {
			recipient: "frank@acme",
		});
		expect(result).toEqual({ task_id: "t1" });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("retries 5xx with exponential backoff", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(new Response("boom", { status: 500 }))
			.mockResolvedValueOnce(new Response("again", { status: 503 }))
			.mockResolvedValueOnce(
				jsonResponse({ jsonrpc: "2.0", id: "x", result: { ok: true } }),
			) as unknown as NonNullable<FetchSig>;

		const { client, sleep } = makeClient(fetchImpl);
		const result = await client.request<{ ok: boolean }>("tasks/list", {});
		expect(result).toEqual({ ok: true });
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenCalledTimes(2);
		// Backoff: 1ms, then 4ms (base * 4^(attempt-1)).
		expect(sleep.mock.calls[0]?.[0]).toBe(1);
		expect(sleep.mock.calls[1]?.[0]).toBe(4);
	});

	it("gives up after maxAttempts on persistent 5xx", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response("nope", { status: 502 })) as unknown as NonNullable<FetchSig>;
		const { client } = makeClient(fetchImpl, { maxAttempts: 2 });
		await expect(client.request("tasks/list", {})).rejects.toBeInstanceOf(A2AHttpError);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("does not retry on 4xx", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response("bad", { status: 400 })) as unknown as NonNullable<FetchSig>;
		const { client } = makeClient(fetchImpl);
		await expect(client.request("tasks/list", {})).rejects.toMatchObject({
			name: "A2AHttpError",
			status: 400,
		});
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("surfaces JSON-RPC errors as A2ARpcError", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				jsonrpc: "2.0",
				id: "x",
				error: { code: -32004, message: "recipient_not_found" },
			}),
		) as unknown as NonNullable<FetchSig>;
		const { client } = makeClient(fetchImpl);
		await expect(client.request("message/send", { recipient: "ghost" })).rejects.toBeInstanceOf(
			A2ARpcError,
		);
	});

	it("preserves caller-supplied idempotency key on retry", async () => {
		const seen: string[] = [];
		const fetchImpl = vi.fn(async (_url: unknown, init: any) => {
			const parsed = JSON.parse(init.body as string);
			seen.push(parsed.params.metadata.client_idempotency_key as string);
			if (seen.length === 1) return new Response("", { status: 500 });
			return jsonResponse({ jsonrpc: "2.0", id: parsed.id, result: { ok: 1 } });
		}) as unknown as NonNullable<FetchSig>;
		const { client } = makeClient(fetchImpl);
		await client.request("message/send", { recipient: "x" }, { idempotencyKey: "my-stable-key" });
		expect(seen).toEqual(["my-stable-key", "my-stable-key"]);
	});
});
