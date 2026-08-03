import type { fetch as undiciFetch } from "undici";
import { describe, expect, it } from "vitest";
import { RelayHttpError, createNodeRelayClient } from "./relay-client.js";

const NODE = {
	node_id: "40000000-0000-4000-8000-000000000001",
	agent_id: "40000000-0000-4000-8000-000000000002",
	name: "developer-mac",
	status: "active" as const,
	capabilities: ["fake-runtime"],
	last_seen_at: "2026-08-02T00:01:00.000Z",
	created_at: "2026-08-02T00:00:00.000Z",
	updated_at: "2026-08-02T00:01:00.000Z",
	revoked_at: null,
};

describe("Node Relay client", () => {
	it("refuses to send a device credential over remote plaintext HTTP", () => {
		expect(() =>
			createNodeRelayClient({
				relayUrl: "http://relay.example.com",
				credential: "device-secret",
			}),
		).toThrow(/must use HTTPS/);
	});

	it("uses the Node REST prefix and device bearer credential", async () => {
		let seenUrl = "";
		let seenAuthorization = "";
		const client = createNodeRelayClient({
			relayUrl: "https://relay.example.com/",
			credential: "device-secret",
			fetch: (async (url, init) => {
				seenUrl = String(url);
				seenAuthorization = String(new Headers(init?.headers).get("authorization"));
				return Response.json({ node: NODE });
			}) as typeof undiciFetch,
		});

		await expect(client.me()).resolves.toEqual({ node: NODE });
		expect(seenUrl).toBe("https://relay.example.com/node/v1/me");
		expect(seenAuthorization).toBe("Bearer device-secret");
	});

	it("encodes Mission assignment pagination in the query string", async () => {
		let seenUrl = "";
		const client = createNodeRelayClient({
			relayUrl: "https://relay.example.com",
			credential: "device-secret",
			fetch: (async (url) => {
				seenUrl = String(url);
				return Response.json({ missions: [], next_cursor: null });
			}) as typeof undiciFetch,
		});

		await expect(
			client.listAssignments("awaiting_acceptance", "40000000-0000-4000-8000-000000000003", 25),
		).resolves.toEqual({ missions: [], next_cursor: null });
		expect(seenUrl).toBe(
			"https://relay.example.com/node/v1/missions?limit=25&status=awaiting_acceptance&after_cursor=40000000-0000-4000-8000-000000000003",
		);
	});

	it("rejects an unexpected Relay response field", async () => {
		const client = createNodeRelayClient({
			relayUrl: "https://relay.example.com",
			credential: "device-secret",
			maxAttempts: 1,
			fetch: (async () =>
				Response.json({ node: NODE, local_path: "/secret" })) as typeof undiciFetch,
		});

		await expect(client.me()).rejects.toThrow();
	});

	it("retries a server error but surfaces a structured authorization failure", async () => {
		let calls = 0;
		const retried = createNodeRelayClient({
			relayUrl: "https://relay.example.com",
			credential: "device-secret",
			backoffBaseMs: 0,
			sleep: async () => undefined,
			fetch: (async () => {
				calls += 1;
				return calls === 1 ? new Response("down", { status: 503 }) : Response.json({ node: NODE });
			}) as typeof undiciFetch,
		});
		await retried.me();
		expect(calls).toBe(2);

		const denied = createNodeRelayClient({
			relayUrl: "https://relay.example.com",
			credential: "revoked-device-secret",
			fetch: (async () =>
				Response.json(
					{
						code: "unauthenticated",
						message: "Node credential revoked",
						request_id: "request-1",
						details: {},
					},
					{ status: 401 },
				)) as typeof undiciFetch,
		});
		const error = await denied.me().catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(RelayHttpError);
		expect(error).toMatchObject({ status: 401, code: "unauthenticated", requestId: "request-1" });
	});
});
