import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createShareClient } from "./share-client.js";

const LINK = "a".repeat(43);
const lifecycle = {
	link_id: LINK,
	expires_at: "2026-11-14T00:00:00.000Z",
	revoked_at: null,
	content_deleted_at: null,
};
const created = { ...lifecycle, url: `https://public.example/l/${LINK}`, replayed: false };

function fixture() {
	const httpFetch = vi.fn<typeof fetch>();
	const sleep = vi.fn().mockResolvedValue(undefined);
	const client = createShareClient({
		relayUrl: "https://relay.example/",
		apiKey: "opaque-local-key",
		fetch: httpFetch,
		sleep,
	});
	return { client, httpFetch, sleep };
}

describe("share HTTP client", () => {
	it("creates through the authenticated route, accepting the Relay's separate canonical public URL", async () => {
		const { client, httpFetch } = fixture();
		httpFetch.mockResolvedValue(Response.json(created, { status: 201 }));
		const key = randomUUID();
		expect(await client.create("selected body", 7, key)).toEqual(created);
		expect(httpFetch).toHaveBeenCalledWith(
			"https://relay.example/shares",
			expect.objectContaining({
				method: "POST",
				redirect: "error",
				signal: expect.any(AbortSignal),
				headers: { authorization: "Bearer opaque-local-key", "content-type": "application/json" },
				body: JSON.stringify({
					content: "selected body",
					expires_in_days: 7,
					idempotency_key: key,
				}),
			}),
		);
	});

	it("retries network/5xx failures with the exact same bytes and mutation identity", async () => {
		const { client, httpFetch, sleep } = fixture();
		httpFetch
			.mockRejectedValueOnce(new Error("sensitive upstream diagnostic"))
			.mockResolvedValueOnce(Response.json({ body: "sensitive failure" }, { status: 503 }))
			.mockResolvedValueOnce(Response.json(created));
		await client.create("selected body", 7, randomUUID());
		expect(httpFetch).toHaveBeenCalledTimes(3);
		expect(new Set(httpFetch.mock.calls.map((call) => call[1]?.body)).size).toBe(1);
		expect(sleep.mock.calls).toEqual([[100], [400]]);
	});

	it("does not retry 4xx responses or display error bodies", async () => {
		const { client, httpFetch, sleep } = fixture();
		httpFetch.mockResolvedValue(
			Response.json(
				{ secret: "opaque-local-key", content: "private response content" },
				{ status: 409 },
			),
		);
		await expect(client.create("body", 7, randomUUID())).rejects.toThrow("HTTP 409");
		expect(httpFetch).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
		try {
			await client.create("body", 7, randomUUID());
		} catch (error) {
			expect(String(error)).not.toContain("opaque-local-key");
			expect(String(error)).not.toContain("private response content");
		}
	});

	it("hides final network diagnostics and avoids redirects even on authenticated requests", async () => {
		const { client, httpFetch } = fixture();
		httpFetch.mockRejectedValue(
			new Error(`upstream https://relay.example/l/${LINK} opaque-local-key`),
		);
		await expect(client.create("body", 7, randomUUID())).rejects.toThrow(
			"retry with the same preview token",
		);
		try {
			await client.create("body", 7, randomUUID());
		} catch (error) {
			expect(String(error)).not.toContain(LINK);
			expect(String(error)).not.toContain("opaque-local-key");
		}
		expect(httpFetch.mock.calls.every((call) => call[1]?.redirect === "error")).toBe(true);
	});

	it.each([
		{ ...created, link_id: "invalid" },
		{ ...created, url: "https://user:password@public.example/l/invalid" },
		{ ...created, url: "javascript:alert(1)" },
		{ ...created, url: "https://public.example/other" },
		{ ...created, url: `https://public.example/l/${LINK}?content=private` },
	])("rejects invalid link receipts without exposing returned content", async (receipt) => {
		const { client, httpFetch } = fixture();
		httpFetch.mockResolvedValue(Response.json({ ...receipt, secret: "private receipt field" }));
		await expect(client.create("body", 7, randomUUID())).rejects.toThrow("invalid Relay");
	});

	it("bounds response streaming and rejects invalid JSON without echoing it", async () => {
		const { client, httpFetch } = fixture();
		for (const body of ["private invalid JSON", "a".repeat(1_000_001)]) {
			httpFetch.mockResolvedValueOnce(new Response(body));
			await expect(client.create("body", 7, randomUUID())).rejects.toThrow("invalid Relay receipt");
		}
	});

	it("posts sender answers and checks returned link identity", async () => {
		const { client, httpFetch } = fixture();
		const answer = {
			link_id: LINK,
			answer_id: randomUUID(),
			sequence: 2,
			created_at: "2026-11-07T00:00:00.000Z",
			replayed: false,
		};
		httpFetch.mockResolvedValueOnce(Response.json(answer));
		expect(await client.answer(LINK, "selected answer", randomUUID())).toEqual(answer);
		expect(httpFetch.mock.calls[0]?.[0]).toBe(`https://relay.example/shares/${LINK}/answers`);
		httpFetch.mockResolvedValueOnce(Response.json({ ...answer, link_id: "b".repeat(43) }));
		await expect(client.answer(LINK, "selected answer", randomUUID())).rejects.toThrow(
			"invalid Relay answer receipt",
		);
	});

	it("lists only sender-authenticated external replies and validates the wire origin", async () => {
		const { client, httpFetch } = fixture();
		const reply = {
			reply_id: randomUUID(),
			sequence: 1,
			channel: "form",
			content: "external text",
			created_at: "2026-11-07T00:00:00.000Z",
			released_at: null,
			origin: "external_unverified",
		};
		httpFetch.mockResolvedValueOnce(Response.json({ ...lifecycle, replies: [reply] }));
		expect((await client.replies(LINK)).replies).toEqual([reply]);
		expect(httpFetch).toHaveBeenCalledWith(
			`https://relay.example/shares/${LINK}/replies`,
			expect.objectContaining({ method: "GET", body: undefined }),
		);
		httpFetch.mockResolvedValueOnce(
			Response.json({ ...lifecycle, replies: [{ ...reply, origin: "trusted" }] }),
		);
		await expect(client.replies(LINK)).rejects.toThrow("invalid Relay receipt");
	});

	it("rejects invalid local configuration and capability paths before network activity", async () => {
		const { client, httpFetch } = fixture();
		await expect(client.answer("../escape", "body", randomUUID())).rejects.toThrow();
		await expect(client.replies("invalid")).rejects.toThrow();
		expect(httpFetch).not.toHaveBeenCalled();
		for (const relayUrl of [
			"file:///tmp/relay",
			"https://user:password@relay.example",
			"https://relay.example?secret=value",
		]) {
			expect(() => createShareClient({ relayUrl, apiKey: "opaque-local-key" })).toThrow(
				"invalid local Relay configuration",
			);
		}
	});
});
