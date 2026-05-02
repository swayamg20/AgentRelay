import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearLastUsedDebounce } from "../auth/middleware.js";
import { loadConfig } from "../config.js";
import { type TestDb, truncateAll, tryConnect } from "../db/test-utils.js";
import { createLogger } from "../logger.js";
import { createServer } from "../server.js";

const conn = await tryConnect();
const d = conn.available ? describe : describe.skip;
if (!conn.available) {
	// biome-ignore lint/suspicious/noConsoleLog: integration tests self-skip without DB
	console.warn(`[blocks.test] skipping: ${conn.reason}`);
}

const TEST_ENV = {
	RELAY_DATABASE_URL: process.env.RELAY_TEST_DATABASE_URL ?? "postgres://x:y@localhost/x",
	RELAY_PEPPER: "p".repeat(32),
	RELAY_ENCRYPTION_KEY: "e".repeat(16),
	RELAY_INVITE_SECRET: "i".repeat(32),
	RELAY_ADMIN_TOKEN: "admin-token-secret",
	RELAY_METRICS_TOKEN: "metrics-token",
	RELAY_PUBLIC_URL: "http://localhost:8080",
	RELAY_ENV: "dev" as const,
	RELAY_LOG_LEVEL: "fatal" as const,
};

d("block-sync REST endpoints", () => {
	let handle: TestDb;
	let app: ReturnType<typeof createServer>;

	beforeAll(() => {
		if (!conn.handle) throw new Error("expected db handle");
		handle = conn.handle;
		const config = loadConfig({ ...TEST_ENV } as NodeJS.ProcessEnv);
		const logger = createLogger(config);
		app = createServer({ config, logger, db: handle.db });
	});

	beforeEach(async () => {
		await truncateAll(handle.sql);
		clearLastUsedDebounce();
	});

	afterAll(async () => {
		if (handle) await handle.close();
	});

	function adminHeaders(): HeadersInit {
		return {
			authorization: `Bearer ${TEST_ENV.RELAY_ADMIN_TOKEN}`,
			"content-type": "application/json",
		};
	}
	function bearer(token: string): HeadersInit {
		return { authorization: `Bearer ${token}`, "content-type": "application/json" };
	}

	async function register(handleStr: string): Promise<{ id: string; key: string }> {
		const res = await app.request("/admin/agents", {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify({
				handle: handleStr,
				email: `${handleStr.split("@")[0]}@a.com`,
				display_name: handleStr,
				role: "r",
			}),
		});
		const body = (await res.json()) as { agent_id: string; api_key: string };
		return { id: body.agent_id, key: body.api_key };
	}

	it("round-trip: block → list shows it → message/send -32013 → unblock → message/send accepted", async () => {
		const bob = await register("bob@acme");
		const frank = await register("frank@acme");

		// frank blocks bob
		const blockRes = await app.request("/agents/me/block", {
			method: "POST",
			headers: bearer(frank.key),
			body: JSON.stringify({ handle: "bob@acme", reason: "spam" }),
		});
		expect(blockRes.status).toBe(201);

		// list shows it
		const list = await app.request("/agents/me/block", { headers: bearer(frank.key) });
		expect(list.status).toBe(200);
		const listBody = (await list.json()) as {
			blocked: Array<{ handle: string; name: string; role: string; blocked_at: string }>;
		};
		expect(listBody.blocked).toHaveLength(1);
		expect(listBody.blocked[0]?.handle).toBe("bob@acme");

		// bob's message/send → -32013
		const send1 = await app.request("/a2a", {
			method: "POST",
			headers: bearer(bob.key),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "message/send",
				params: {
					recipient: "frank@acme",
					intent: "inform",
					message: { parts: [{ type: "text", text: "hi" }] },
				},
			}),
		});
		const send1Body = (await send1.json()) as { error: { code: number; data: { code: string } } };
		expect(send1Body.error.data.code).toBe("teammate_blocked");
		expect(send1Body.error.code).toBe(-32013);

		// frank unblocks bob
		const unblock = await app.request("/agents/me/block/bob@acme", {
			method: "DELETE",
			headers: bearer(frank.key),
		});
		expect(unblock.status).toBe(204);

		// bob's message/send → succeeds
		const send2 = await app.request("/a2a", {
			method: "POST",
			headers: bearer(bob.key),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "message/send",
				params: {
					recipient: "frank@acme",
					intent: "inform",
					message: { parts: [{ type: "text", text: "hi again" }] },
				},
			}),
		});
		const send2Body = (await send2.json()) as { result: { status: { state: string } } };
		expect(send2Body.result.status.state).toBe("pending");

		// list now empty
		const list2 = await app.request("/agents/me/block", { headers: bearer(frank.key) });
		const list2Body = (await list2.json()) as { blocked: unknown[] };
		expect(list2Body.blocked).toHaveLength(0);
	});

	it("double-block is a no-op (still 201)", async () => {
		await register("bob@acme");
		const frank = await register("frank@acme");
		const a = await app.request("/agents/me/block", {
			method: "POST",
			headers: bearer(frank.key),
			body: JSON.stringify({ handle: "bob@acme" }),
		});
		expect(a.status).toBe(201);
		const b = await app.request("/agents/me/block", {
			method: "POST",
			headers: bearer(frank.key),
			body: JSON.stringify({ handle: "bob@acme" }),
		});
		expect(b.status).toBe(201);
		const list = await app.request("/agents/me/block", { headers: bearer(frank.key) });
		const listBody = (await list.json()) as { blocked: unknown[] };
		expect(listBody.blocked).toHaveLength(1);
	});

	it("unblock-of-not-blocked is a no-op (204)", async () => {
		await register("bob@acme");
		const frank = await register("frank@acme");
		const res = await app.request("/agents/me/block/bob@acme", {
			method: "DELETE",
			headers: bearer(frank.key),
		});
		expect(res.status).toBe(204);
	});

	it("unknown handle on block returns -32004 / 404", async () => {
		const frank = await register("frank@acme");
		const res = await app.request("/agents/me/block", {
			method: "POST",
			headers: bearer(frank.key),
			body: JSON.stringify({ handle: "ghost@acme" }),
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("recipient_not_found");
	});

	it("cannot block yourself", async () => {
		const frank = await register("frank@acme");
		const res = await app.request("/agents/me/block", {
			method: "POST",
			headers: bearer(frank.key),
			body: JSON.stringify({ handle: "frank@acme" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string; message: string };
		expect(body.code).toBe("invalid_params");
		expect(body.message).toMatch(/yourself/);
	});

	it("block endpoints require agent bearer (not admin token)", async () => {
		const res = await app.request("/agents/me/block", {
			method: "POST",
			headers: {
				authorization: `Bearer ${TEST_ENV.RELAY_ADMIN_TOKEN}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ handle: "x" }),
		});
		expect(res.status).toBe(401);
	});

	it("unblock of vanished agent still 204 (lenient)", async () => {
		const frank = await register("frank@acme");
		const res = await app.request("/agents/me/block/never-existed@a", {
			method: "DELETE",
			headers: bearer(frank.key),
		});
		expect(res.status).toBe(204);
	});
});
