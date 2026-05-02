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
	console.warn(`[me.test] skipping: ${conn.reason}`);
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

d("self-management endpoints", () => {
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
				role: "engineer",
			}),
		});
		const body = (await res.json()) as { agent_id: string; api_key: string };
		return { id: body.agent_id, key: body.api_key };
	}

	// ─── GET /agents/me ───────────────────────────────────────────────────────

	it("GET /agents/me returns caller identity (not someone else)", async () => {
		const bob = await register("bob@acme");
		const frank = await register("frank@acme");

		const bobMe = await app.request("/agents/me", { headers: bearer(bob.key) });
		expect(bobMe.status).toBe(200);
		const bobBody = (await bobMe.json()) as { id: string; handle: string };
		expect(bobBody.id).toBe(bob.id);
		expect(bobBody.handle).toBe("bob@acme");

		const frankMe = await app.request("/agents/me", { headers: bearer(frank.key) });
		const frankBody = (await frankMe.json()) as { id: string; handle: string };
		expect(frankBody.id).toBe(frank.id);
		expect(frankBody.handle).toBe("frank@acme");
	});

	it("GET /agents/me requires auth", async () => {
		const res = await app.request("/agents/me");
		expect(res.status).toBe(401);
	});

	it("GET /agents/me reflects card updates (skills, repos)", async () => {
		const frank = await register("frank@acme");
		await app.request("/agents/me/card", {
			method: "PUT",
			headers: bearer(frank.key),
			body: JSON.stringify({ skills: ["react"], repos_owned: ["apps/web/"] }),
		});
		const me = await app.request("/agents/me", { headers: bearer(frank.key) });
		const body = (await me.json()) as { skills: string[]; repos_owned: string[] };
		expect(body.skills).toEqual(["react"]);
		expect(body.repos_owned).toEqual(["apps/web/"]);
	});

	// ─── POST /agents/me/keys/rotate ──────────────────────────────────────────

	it("self-rotate revokes old key and issues new one", async () => {
		const bob = await register("bob@acme");
		const rot = await app.request("/agents/me/keys/rotate", {
			method: "POST",
			headers: bearer(bob.key),
		});
		expect(rot.status).toBe(200);
		const body = (await rot.json()) as { api_key: string; agent_id: string };
		expect(body.api_key).toMatch(/^ah_test_[a-z2-7]{32}$/);
		expect(body.api_key).not.toBe(bob.key);
		expect(body.agent_id).toBe(bob.id);

		// old denied
		const old = await app.request("/agents/me", { headers: bearer(bob.key) });
		expect(old.status).toBe(401);

		// new works
		const fresh = await app.request("/agents/me", { headers: bearer(body.api_key) });
		expect(fresh.status).toBe(200);
	});

	it("old key cannot rotate again after self-rotation", async () => {
		const bob = await register("bob@acme");
		await app.request("/agents/me/keys/rotate", {
			method: "POST",
			headers: bearer(bob.key),
		});
		const second = await app.request("/agents/me/keys/rotate", {
			method: "POST",
			headers: bearer(bob.key),
		});
		expect(second.status).toBe(401);
	});

	it("self-rotate cannot affect another agent", async () => {
		const bob = await register("bob@acme");
		const frank = await register("frank@acme");
		await app.request("/agents/me/keys/rotate", {
			method: "POST",
			headers: bearer(bob.key),
		});
		// frank's key still works
		const frankCheck = await app.request("/agents/me", { headers: bearer(frank.key) });
		expect(frankCheck.status).toBe(200);
	});

	it("self-rotate requires auth (no admin token)", async () => {
		const res = await app.request("/agents/me/keys/rotate", {
			method: "POST",
			headers: adminHeaders(),
		});
		expect(res.status).toBe(401);
	});

	// ─── GET /agents/me/audit ────────────────────────────────────────────────

	it("audit returns only caller events", async () => {
		const bob = await register("bob@acme");
		const frank = await register("frank@acme");

		// bob sends a handoff to frank → bob gets audit row, frank gets a different one when accepting
		const create = await app.request("/a2a", {
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
		const taskId = ((await create.json()) as any).result.task_id as string;

		await app.request("/a2a", {
			method: "POST",
			headers: bearer(frank.key),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tasks/update",
				params: { task_id: taskId, transition: "accept" },
			}),
		});

		const bobAudit = (await (
			await app.request("/agents/me/audit", { headers: bearer(bob.key) })
		).json()) as { events: Array<{ action: string; actor_handle: string }> };
		expect(bobAudit.events.length).toBeGreaterThan(0);
		for (const e of bobAudit.events) expect(e.actor_handle).toBe("bob@acme");
		expect(bobAudit.events.map((e) => e.action)).toContain("handoff.create");

		const frankAudit = (await (
			await app.request("/agents/me/audit", { headers: bearer(frank.key) })
		).json()) as { events: Array<{ action: string; actor_handle: string }> };
		for (const e of frankAudit.events) expect(e.actor_handle).toBe("frank@acme");
		expect(frankAudit.events.map((e) => e.action)).toContain("handoff.accept");
		// frank's audit must NOT contain bob's create
		expect(frankAudit.events.map((e) => e.action)).not.toContain("handoff.create");
	});

	it("audit filters by action", async () => {
		const bob = await register("bob@acme");
		await register("frank@acme");
		// generate a couple of distinct actions
		const c1 = await app.request("/a2a", {
			method: "POST",
			headers: bearer(bob.key),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "message/send",
				params: {
					recipient: "frank@acme",
					intent: "inform",
					message: { parts: [{ type: "text", text: "one" }] },
				},
			}),
		});
		const taskId = ((await c1.json()) as any).result.task_id as string;
		// bob cancels → another audit row (handoff.cancel)
		await app.request("/a2a", {
			method: "POST",
			headers: bearer(bob.key),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tasks/cancel",
				params: { task_id: taskId },
			}),
		});

		const filtered = (await (
			await app.request("/agents/me/audit?action=handoff.cancel", { headers: bearer(bob.key) })
		).json()) as { events: Array<{ action: string }> };
		expect(filtered.events.length).toBe(1);
		expect(filtered.events[0]?.action).toBe("handoff.cancel");
	});

	it("audit filters by since", async () => {
		const bob = await register("bob@acme");
		await register("frank@acme");
		await app.request("/a2a", {
			method: "POST",
			headers: bearer(bob.key),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "message/send",
				params: {
					recipient: "frank@acme",
					intent: "inform",
					message: { parts: [{ type: "text", text: "one" }] },
				},
			}),
		});
		const future = new Date(Date.now() + 60_000).toISOString();
		const noneRes = (await (
			await app.request(`/agents/me/audit?since=${encodeURIComponent(future)}`, {
				headers: bearer(bob.key),
			})
		).json()) as { events: unknown[] };
		expect(noneRes.events).toHaveLength(0);
	});

	it("audit `from` filter degenerates to empty when not caller", async () => {
		const bob = await register("bob@acme");
		await register("frank@acme");
		await app.request("/a2a", {
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
		const others = (await (
			await app.request("/agents/me/audit?from=frank@acme", { headers: bearer(bob.key) })
		).json()) as { events: unknown[] };
		expect(others.events).toHaveLength(0);
		const own = (await (
			await app.request("/agents/me/audit?from=bob@acme", { headers: bearer(bob.key) })
		).json()) as { events: unknown[] };
		expect(own.events.length).toBeGreaterThan(0);
	});

	it("audit limit is capped at 1000", async () => {
		const bob = await register("bob@acme");
		const tooBig = await app.request("/agents/me/audit?limit=5000", {
			headers: bearer(bob.key),
		});
		expect(tooBig.status).toBe(400);
		const body = (await tooBig.json()) as { code: string };
		expect(body.code).toBe("invalid_params");
	});

	it("audit requires auth", async () => {
		const res = await app.request("/agents/me/audit");
		expect(res.status).toBe(401);
	});
});
