import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearLastUsedDebounce } from "../auth/middleware.js";
import { loadConfig } from "../config.js";
import { agents, auditLog, invites } from "../db/schema.js";
import { type TestDb, truncateAll, tryConnect } from "../db/test-utils.js";
import { createLogger } from "../logger.js";
import { createServer } from "../server.js";
import { hashToken, mintInviteToken } from "../services/invite.js";

const conn = await tryConnect();
const d = conn.available ? describe : describe.skip;
if (!conn.available) {
	console.warn(`[invites.test] skipping: ${conn.reason}`);
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

type AgentResponse = {
	agent_id: string;
	handle: string;
	api_key: string;
};

type InviteResponse = {
	url: string;
	jti: string;
	expires_at: string;
};

type InviteErrorResponse = {
	error: string;
	message?: string;
};

d("invite REST endpoints", () => {
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
		return {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		};
	}

	async function register(handleStr: string, role = "lead"): Promise<AgentResponse> {
		const localPart = handleStr.split("@")[0] ?? "agent";
		const res = await app.request("/admin/agents", {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify({
				handle: handleStr,
				email: `${localPart}@acme.com`,
				display_name: handleStr,
				role,
			}),
		});
		expect(res.status).toBe(201);
		return (await res.json()) as AgentResponse;
	}

	async function mintInvite(input?: {
		inviterHandle?: string;
		handle?: string;
		role?: string;
		companyDomain?: string;
		expiresInSeconds?: number;
	}): Promise<InviteResponse> {
		const res = await app.request("/admin/invites", {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify({
				inviter_handle: input?.inviterHandle ?? "lead@acme",
				handle: input?.handle ?? "builder@acme",
				role: input?.role ?? "frontend",
				company_domain: input?.companyDomain,
				expires_in_seconds: input?.expiresInSeconds ?? 86_400,
			}),
		});
		expect(res.status).toBe(201);
		return (await res.json()) as InviteResponse;
	}

	function tokenFromUrl(url: string): string {
		const token = new URL(url).hash.slice(1);
		expect(token).toMatch(/^v1\./);
		return token;
	}

	function tamperPayload(token: string): string {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("unexpected invite token shape");
		const [version, encodedPayload, encodedSignature] = parts as [string, string, string];
		const replacement = encodedPayload[0] === "A" ? "B" : "A";
		return `${version}.${replacement}${encodedPayload.slice(1)}.${encodedSignature}`;
	}

	it("mint requires admin token", async () => {
		const body = JSON.stringify({
			inviter_handle: "lead@acme",
			handle: "builder@acme",
			role: "frontend",
		});

		const missing = await app.request("/admin/invites", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
		expect(missing.status).toBe(401);

		const wrong = await app.request("/admin/invites", {
			method: "POST",
			headers: adminHeaders("wrong-token-but-same-len"),
			body,
		});
		expect([401, 403]).toContain(wrong.status);
	});

	it("mint creates an invites row with token_hash", async () => {
		const inviter = await register("lead@acme");
		const invite = await mintInvite();
		const token = tokenFromUrl(invite.url);

		expect(invite.jti).toMatch(/^[0-9a-f-]{36}$/);
		expect(invite.expires_at).toEqual(expect.any(String));

		const rows = await handle.db.select().from(invites);
		expect(rows).toHaveLength(1);
		const row = rows[0];
		if (!row) throw new Error("expected invite row");
		expect(row.jti).toBe(invite.jti);
		expect(row.tokenHash).toBe(hashToken(token));
		expect(row.inviterId).toBe(inviter.agent_id);
		expect(row.usedAt).toBeNull();
		expect(row.companyDomain).toBeNull();
	});

	it("redeem with valid token creates agent and marks used_at", async () => {
		await register("lead@acme");
		const invite = await mintInvite({ handle: "worker@acme", role: "backend" });
		const token = tokenFromUrl(invite.url);

		const res = await app.request(`/invites/${invite.jti}/redeem`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				token,
				handle: "ignored@acme",
				role: "ignored",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as AgentResponse;
		expect(body.handle).toBe("worker@acme");
		expect(body.api_key).toMatch(/^ah_test_[a-z2-7]{32}$/);

		const [inviteRow] = await handle.db.select().from(invites).where(eq(invites.jti, invite.jti));
		if (!inviteRow) throw new Error("expected invite row");
		expect(inviteRow.usedAt).toBeInstanceOf(Date);
		expect(inviteRow.usedByAgentId).toBe(body.agent_id);

		const [agent] = await handle.db.select().from(agents).where(eq(agents.id, body.agent_id));
		if (!agent) throw new Error("expected redeemed agent row");
		expect(agent.handle).toBe("worker@acme");
		expect(agent.role).toBe("backend");
	});

	it("redeem second time returns 410", async () => {
		await register("lead@acme");
		const invite = await mintInvite();
		const token = tokenFromUrl(invite.url);

		const first = await app.request(`/invites/${invite.jti}/redeem`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token }),
		});
		expect(first.status).toBe(201);

		const second = await app.request(`/invites/${invite.jti}/redeem`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token }),
		});
		expect(second.status).toBe(410);
		const body = (await second.json()) as InviteErrorResponse;
		expect(body.error).toBe("already_used");
	});

	it("redeem with expired token returns 410", async () => {
		await register("lead@acme");
		const invite = await mintInvite({ handle: "expired@acme", role: "backend" });
		// Sign a same-jti token with a past exp so the route-level payload exp check runs without sleeping.
		const expiredToken = mintInviteToken({
			jti: invite.jti,
			payload: {
				relay_url: TEST_ENV.RELAY_PUBLIC_URL,
				handle: "expired@acme",
				role: "backend",
				inviter_handle: "lead@acme",
				jti: invite.jti,
				exp: Math.floor(Date.now() / 1000) - 1,
			},
			secret: TEST_ENV.RELAY_INVITE_SECRET,
		});

		const res = await app.request(`/invites/${invite.jti}/redeem`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: expiredToken }),
		});
		expect(res.status).toBe(410);
		const body = (await res.json()) as InviteErrorResponse;
		expect(body.error).toBe("expired");
	});

	it("redeem with tampered token returns 401", async () => {
		await register("lead@acme");
		const invite = await mintInvite();
		const token = tokenFromUrl(invite.url);

		const res = await app.request(`/invites/${invite.jti}/redeem`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: tamperPayload(token) }),
		});
		expect(res.status).toBe(401);
	});

	it("audit log written for both operations", async () => {
		await register("lead@acme");
		const invite = await mintInvite({ handle: "audit@acme", role: "reviewer" });
		const token = tokenFromUrl(invite.url);

		const afterMint = await handle.db
			.select({
				action: auditLog.action,
				actorKind: auditLog.actorKind,
				actorId: auditLog.actorId,
				resourceType: auditLog.resourceType,
				resourceId: auditLog.resourceId,
			})
			.from(auditLog)
			.orderBy(asc(auditLog.id));
		expect(afterMint).toHaveLength(1);
		expect(afterMint[0]).toMatchObject({
			action: "invite.minted",
			actorKind: "admin",
			actorId: null,
			resourceType: "invite",
			resourceId: invite.jti,
		});

		const redeem = await app.request(`/invites/${invite.jti}/redeem`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token }),
		});
		expect(redeem.status).toBe(201);
		const redeemed = (await redeem.json()) as AgentResponse;

		const afterRedeem = await handle.db
			.select({
				action: auditLog.action,
				actorId: auditLog.actorId,
				resourceType: auditLog.resourceType,
				resourceId: auditLog.resourceId,
			})
			.from(auditLog)
			.orderBy(asc(auditLog.id));
		expect(afterRedeem).toHaveLength(2);
		expect(afterRedeem[1]).toMatchObject({
			action: "invite.redeemed",
			actorId: redeemed.agent_id,
			resourceType: "invite",
			resourceId: invite.jti,
		});
	});

	it("stores a normalized admin attestation and redeems it from the invite, not receiver assertions", async () => {
		const inviter = await register("lead@acme");
		const response = await app.request("/admin/invites", {
			method: "POST",
			headers: { ...adminHeaders(), "x-request-id": "domain-attestation-test" },
			body: JSON.stringify({
				inviter_handle: "lead@acme",
				handle: "verified@acme",
				role: "reviewer",
				company_domain: "  Sub.Example.COM  ",
			}),
		});
		expect(response.status).toBe(201);
		const invite = (await response.json()) as InviteResponse;
		const [storedInvite] = await handle.db
			.select()
			.from(invites)
			.where(eq(invites.jti, invite.jti));
		expect(storedInvite?.companyDomain).toBe("sub.example.com");
		const [audit] = await handle.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.resourceId, invite.jti));
		expect(audit).toMatchObject({
			actorKind: "admin",
			actorId: null,
			action: "invite.minted",
			requestId: "domain-attestation-test",
			metadata: { company_domain: "sub.example.com", inviter_id: inviter.agent_id },
		});
		const redeemed = await app.request(`/invites/${invite.jti}/redeem`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: tokenFromUrl(invite.url), company_domain: "attacker.example" }),
		});
		expect(redeemed.status).toBe(201);
		const result = (await redeemed.json()) as AgentResponse;
		const [agent] = await handle.db.select().from(agents).where(eq(agents.id, result.agent_id));
		expect(agent?.companyDomain).toBe("sub.example.com");
		const [original] = await handle.db.select().from(agents).where(eq(agents.id, inviter.agent_id));
		expect(original?.companyDomain).toBeNull();
	});

	it("keeps omitted invite domains unknown instead of inferring from handle or email", async () => {
		await register("lead@acme");
		const invite = await mintInvite();
		const response = await app.request(`/invites/${invite.jti}/redeem`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: tokenFromUrl(invite.url), company_domain: "acme.com" }),
		});
		expect(response.status).toBe(201);
		const result = (await response.json()) as AgentResponse;
		const [agent] = await handle.db.select().from(agents).where(eq(agents.id, result.agent_id));
		expect(agent?.companyDomain).toBeNull();
	});

	it.each([
		"",
		"localhost",
		"https://example.com",
		"person@example.com",
		"*.example.com",
		"-bad.example",
		"127.0.0.1",
		`${"a".repeat(64)}.example`,
		"example.com.",
	])("rejects invalid company domain %j before minting or auditing", async (companyDomain) => {
		await register("lead@acme");
		const response = await app.request("/admin/invites", {
			method: "POST",
			headers: adminHeaders(),
			body: JSON.stringify({
				inviter_handle: "lead@acme",
				handle: "builder@acme",
				role: "frontend",
				company_domain: companyDomain,
			}),
		});
		expect(response.status).toBe(400);
		expect(await handle.db.select().from(invites)).toEqual([]);
		expect(await handle.db.select().from(auditLog)).toEqual([]);
	});

	it("rolls back the attested invite when its audit write fails", async () => {
		await register("lead@acme");
		await handle.sql`ALTER TABLE audit_log ADD CONSTRAINT reject_test_invite_mint CHECK (action != 'invite.minted')`;
		try {
			const response = await app.request("/admin/invites", {
				method: "POST",
				headers: adminHeaders(),
				body: JSON.stringify({
					inviter_handle: "lead@acme",
					handle: "builder@acme",
					role: "frontend",
					company_domain: "example.com",
				}),
			});
			expect(response.status).toBe(500);
			expect(await handle.db.select().from(invites)).toEqual([]);
			expect(await handle.db.select().from(auditLog)).toEqual([]);
		} finally {
			await handle.sql`ALTER TABLE audit_log DROP CONSTRAINT reject_test_invite_mint`;
		}
	});
});
