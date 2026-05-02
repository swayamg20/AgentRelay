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
	console.warn(`[admin.test] skipping: ${conn.reason}`);
}

const TEST_ENV = {
	RELAY_DATABASE_URL: process.env.RELAY_TEST_DATABASE_URL ?? "postgres://x:y@localhost/x",
	RELAY_PEPPER: "p".repeat(32),
	RELAY_ENCRYPTION_KEY: "e".repeat(16),
	RELAY_ADMIN_TOKEN: "admin-token-secret",
	RELAY_METRICS_TOKEN: "metrics-token",
	RELAY_PUBLIC_URL: "http://localhost:8080",
	RELAY_ENV: "dev" as const,
	RELAY_LOG_LEVEL: "fatal" as const,
};

d("admin + auth integration", () => {
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

	function adminHeaders(token = TEST_ENV.RELAY_ADMIN_TOKEN): HeadersInit {
		return { authorization: `Bearer ${token}`, "content-type": "application/json" };
	}

	function bearer(token: string): HeadersInit {
		return { authorization: `Bearer ${token}`, "content-type": "application/json" };
	}

	async function createAgent(handleStr = "frank@acme"): Promise<{ id: string; key: string }> {
		const res = await app.request("/admin/agents", {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify({
				handle: handleStr,
				email: `${handleStr.split("@")[0]}@acme.com`,
				display_name: "Frank",
				role: "frontend",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { agent_id: string; api_key: string };
		return { id: body.agent_id, key: body.api_key };
	}

	it("rejects /admin/* without admin bearer", async () => {
		const res = await app.request("/admin/agents", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("unauthenticated");
	});

	it("rejects /admin/* with wrong admin bearer", async () => {
		const res = await app.request("/admin/agents", {
			method: "POST",
			headers: adminHeaders("wrong-token-but-same-len"),
			body: "{}",
		});
		expect([401, 403]).toContain(res.status);
	});

	it("POST /admin/agents creates agent + returns one-time key", async () => {
		const { id, key } = await createAgent();
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
		expect(key).toMatch(/^ah_test_[a-z2-7]{32}$/);
	});

	it("rejects duplicate handle on POST /admin/agents", async () => {
		await createAgent("dup@acme");
		const res = await app.request("/admin/agents", {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify({
				handle: "dup@acme",
				email: "dup2@acme.com",
				display_name: "Dup",
				role: "r",
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("invalid_params");
	});

	it("GET /agents lists active agents (auth required)", async () => {
		await createAgent("frank@acme");
		const { key } = await createAgent("bob@acme");

		const noAuth = await app.request("/agents");
		expect(noAuth.status).toBe(401);

		const ok = await app.request("/agents", { headers: bearer(key) });
		expect(ok.status).toBe(200);
		const body = (await ok.json()) as { teammates: Array<{ handle: string }> };
		const handles = body.teammates.map((t) => t.handle).sort();
		expect(handles).toEqual(["bob@acme", "frank@acme"]);
	});

	it("PUT /agents/me/card upserts skills/repos", async () => {
		const { key } = await createAgent("frank@acme");
		const res = await app.request("/agents/me/card", {
			method: "PUT",
			headers: bearer(key),
			body: JSON.stringify({
				skills: ["react", "tailwind"],
				repos_owned: ["apps/web/"],
			}),
		});
		expect(res.status).toBe(200);

		const list = await app.request("/agents", { headers: bearer(key) });
		const body = (await list.json()) as {
			teammates: Array<{ handle: string; skills: string[]; repos_owned: string[] }>;
		};
		const me = body.teammates.find((t) => t.handle === "frank@acme");
		expect(me?.skills).toEqual(["react", "tailwind"]);
		expect(me?.repos_owned).toEqual(["apps/web/"]);
	});

	it("rotate-key revokes old key and issues new one", async () => {
		const { id, key: oldKey } = await createAgent("frank@acme");

		const rotateRes = await app.request(`/admin/agents/${id}/keys/rotate`, {
			method: "POST",
			headers: adminHeaders(),
		});
		expect(rotateRes.status).toBe(200);
		const rotated = (await rotateRes.json()) as { api_key: string };
		expect(rotated.api_key).not.toBe(oldKey);

		// old key denied
		const denied = await app.request("/agents", { headers: bearer(oldKey) });
		expect(denied.status).toBe(401);

		// new key works
		const ok = await app.request("/agents", { headers: bearer(rotated.api_key) });
		expect(ok.status).toBe(200);
	});

	it("DELETE /admin/agents/:id soft-disables and revokes keys", async () => {
		const { id, key } = await createAgent("frank@acme");
		const res = await app.request(`/admin/agents/${id}`, {
			method: "DELETE",
			headers: adminHeaders(),
		});
		expect(res.status).toBe(204);

		// key now invalid (revoked) and agent disabled
		const denied = await app.request("/agents", { headers: bearer(key) });
		expect(denied.status).toBe(401);
	});

	it("rejects malformed bearer tokens", async () => {
		const res = await app.request("/agents", {
			headers: { authorization: "Bearer not-a-real-key" },
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("unauthenticated");
	});
});
