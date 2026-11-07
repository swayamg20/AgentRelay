import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearLastUsedDebounce } from "../auth/middleware.js";
import { loadConfig } from "../config.js";
import {
	agents,
	auditLog,
	mailboxEvents,
	messages,
	shareEvents,
	shareLinks,
	shareReplies,
} from "../db/schema.js";
import { type TestDb, truncateAll, tryConnect } from "../db/test-utils.js";
import { createLogger } from "../logger.js";
import { createServer } from "../server.js";
import { deleteExpiredShareContent } from "../services/shares.js";

const conn = await tryConnect();
const databaseDescribe = conn.available ? describe : describe.skip;
if (!conn.available) console.warn(`[shares.test] skipping: ${conn.reason}`);

const TEST_ENV = {
	RELAY_DATABASE_URL: process.env.RELAY_TEST_DATABASE_URL ?? "postgres://x:y@localhost/x",
	RELAY_PEPPER: "p".repeat(32),
	RELAY_ENCRYPTION_KEY: "e".repeat(16),
	RELAY_INVITE_SECRET: "i".repeat(32),
	RELAY_ADMIN_TOKEN: "admin-token-secret",
	RELAY_METRICS_TOKEN: "metrics-token",
	RELAY_PUBLIC_URL: "https://relay.example",
	RELAY_ENV: "dev",
	RELAY_LOG_LEVEL: "fatal",
};

interface Sender {
	agent_id: string;
	api_key: string;
}
interface Link {
	link_id: string;
	expires_at: string;
	url: string;
	replayed: boolean;
}

databaseDescribe("handoff link routes", () => {
	let handle: TestDb;
	let app: ReturnType<typeof createServer>;
	let sender: Sender;
	let other: Sender;
	let nextIp = 1;

	beforeAll(() => {
		if (!conn.handle) throw new Error("expected database handle");
		handle = conn.handle;
	});
	beforeEach(async () => {
		await truncateAll(handle.sql);
		clearLastUsedDebounce();
		nextIp = 1;
		const config = loadConfig(TEST_ENV);
		app = createServer({ config, logger: createLogger(config), db: handle.db });
		sender = await register("sender@acme");
		other = await register("other@acme");
	});
	afterAll(async () => {
		await handle?.close();
	});

	async function register(agentHandle: string): Promise<Sender> {
		const response = await app.request("/admin/agents", {
			method: "POST",
			headers: {
				authorization: `Bearer ${TEST_ENV.RELAY_ADMIN_TOKEN}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				handle: agentHandle,
				email: `${agentHandle}.example`,
				display_name: agentHandle,
				role: "lead",
			}),
		});
		expect(response.status).toBe(201);
		return (await response.json()) as Sender;
	}

	async function createLink(input: Record<string, unknown> = {}, owner = sender): Promise<Link> {
		const response = await createResponse(input, owner);
		expect(response.status).toBe(201);
		return (await response.json()) as Link;
	}
	function createResponse(input: Record<string, unknown>, owner = sender) {
		return app.request("/shares", {
			method: "POST",
			headers: { authorization: `Bearer ${owner.api_key}`, "content-type": "application/json" },
			body: JSON.stringify({
				content: "sender published proposal",
				idempotency_key: randomUUID(),
				...input,
			}),
		});
	}
	function reply(link: Link, input: Record<string, unknown> = {}, ip?: string) {
		return app.request(`/l/${link.link_id}/replies`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-forwarded-for": ip ?? `192.0.2.${nextIp++}`,
			},
			body: JSON.stringify({ content: "external held reply", ...input }),
		});
	}
	function answer(link: Link, input: Record<string, unknown> = {}, owner = sender) {
		return app.request(`/shares/${link.link_id}/answers`, {
			method: "POST",
			headers: { authorization: `Bearer ${owner.api_key}`, "content-type": "application/json" },
			body: JSON.stringify({ content: "public answer", idempotency_key: randomUUID(), ...input }),
		});
	}
	function listReplies(link: Link, owner = sender) {
		return app.request(`/shares/${link.link_id}/replies`, {
			headers: { authorization: `Bearer ${owner.api_key}` },
		});
	}

	it("lists external replies only for the sender, without releasing or verifying them", async () => {
		const link = await createLink();
		await reply(link, { content: "untrusted external body" });
		expect((await answer(link)).status).toBe(201);
		expect((await listReplies(link, other)).status).toBe(404);
		expect((await app.request(`/shares/${link.link_id}/replies`)).status).toBe(401);
		const response = await listReplies(link);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toMatchObject({
			link_id: link.link_id,
			replies: [
				{
					sequence: 1,
					channel: "api",
					content: "untrusted external body",
					released_at: null,
					origin: "external_unverified",
				},
			],
		});
		expect(await handle.db.select().from(mailboxEvents)).toHaveLength(0);
		expect(await handle.db.select().from(messages)).toHaveLength(0);
	});

	it("publishes sender answers once with ordered, content-free audit and measurement", async () => {
		const link = await createLink();
		await reply(link, { content: "never publish this external body" });
		const input = { content: "sender selected answer", idempotency_key: randomUUID() };
		const responses = await Promise.all([answer(link, input), answer(link, input)]);
		expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
		const receipts = await Promise.all(responses.map((response) => response.json()));
		expect(receipts[0]).toMatchObject({ link_id: link.link_id, sequence: 2 });
		expect(receipts[0].answer_id).toBe(receipts[1].answer_id);
		expect((await answer(link, { ...input, content: "changed answer" })).status).toBe(409);
		const page = await (await app.request(`/l/${link.link_id}`)).text();
		expect(page).toContain(input.content);
		expect(page).not.toContain("never publish this external body");
		const events = await handle.db
			.select()
			.from(shareEvents)
			.where(eq(shareEvents.kind, "answer.posted"));
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			actorKind: "agent",
			actorAgentId: sender.agent_id,
			metadata: {},
		});
		const audits = await handle.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.action, "answer.posted"));
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({ actorKind: "agent", actorId: sender.agent_id });
		expect(
			JSON.stringify({ events, audits }, (_key, value) =>
				typeof value === "bigint" ? value.toString() : value,
			),
		).not.toContain(input.content);
	});

	it("validates sender answer identity and bytes and requires active sender-owned links", async () => {
		const link = await createLink();
		expect((await answer(link, {}, other)).status).toBe(404);
		expect((await app.request(`/shares/${link.link_id}/answers`, { method: "POST" })).status).toBe(
			401,
		);
		for (const input of [
			{ content: "" },
			{ content: "\u0000" },
			{ content: "é".repeat(8193) },
			{ idempotency_key: "invalid" },
			{ idempotency_key: undefined },
			{ channel: "form" },
		]) {
			expect((await answer(link, input)).status).toBe(400);
		}
		expect((await answer(link, { content: "é".repeat(8192) })).status).toBe(201);
		await app.request(`/shares/${link.link_id}/revoke`, {
			method: "POST",
			headers: { authorization: `Bearer ${sender.api_key}` },
		});
		expect((await answer(link)).status).toBe(404);
		expect((await listReplies(link)).status).toBe(200);
		const expired = await createLink();
		await handle.db
			.update(shareLinks)
			.set({ createdAt: new Date(Date.now() - 86_400_000), expiresAt: new Date(Date.now() - 1000) })
			.where(eq(shareLinks.publicId, expired.link_id));
		expect((await answer(expired)).status).toBe(404);
		await handle.db
			.update(agents)
			.set({ status: "disabled" })
			.where(eq(agents.id, sender.agent_id));
		expect((await answer(expired)).status).toBe(403);
		expect((await listReplies(expired)).status).toBe(403);
	});

	it("serializes aggregate published UTF-8 content at 64 KiB without counting external replies", async () => {
		const link = await createLink({ content: "é".repeat(24 * 1024) });
		await reply(link, { content: "x".repeat(16 * 1024) });
		const input = { content: "é".repeat(8192), idempotency_key: randomUUID() };
		const responses = await Promise.all([
			answer(link, input),
			answer(link, { ...input, idempotency_key: randomUUID() }),
		]);
		expect(responses.map((response) => response.status).sort()).toEqual([201, 400]);
		const successful = responses.find((response) => response.status === 201);
		const receipt = await successful?.json();
		const [stored] = await handle.db
			.select()
			.from(shareReplies)
			.where(eq(shareReplies.id, receipt.answer_id));
		expect(
			(await answer(link, { content: input.content, idempotency_key: stored?.idempotencyKey }))
				.status,
		).toBe(200);
		expect((await answer(link, { content: "a" })).status).toBe(400);
	});

	it("rolls back a sender answer and measurement when its audit insert fails", async () => {
		const link = await createLink();
		await handle.sql.unsafe(
			"CREATE FUNCTION share_test_reject_answer_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'answer.posted' THEN RAISE EXCEPTION 'answer failure'; END IF; RETURN NEW; END $$",
		);
		await handle.sql.unsafe(
			"CREATE TRIGGER share_test_reject_answer_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION share_test_reject_answer_audit()",
		);
		try {
			expect((await answer(link)).status).toBe(500);
			expect(await handle.db.select().from(shareReplies)).toHaveLength(0);
			expect(
				await handle.db.select().from(shareEvents).where(eq(shareEvents.kind, "answer.posted")),
			).toHaveLength(0);
		} finally {
			await handle.sql.unsafe("DROP TRIGGER share_test_reject_answer_audit ON audit_log");
			await handle.sql.unsafe("DROP FUNCTION share_test_reject_answer_audit()");
		}
	});

	it("creates an unguessable capability with default expiry and content-free atomic audit", async () => {
		const before = Date.now();
		const link = await createLink();
		expect(link.link_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(link.url).toBe(`https://relay.example/l/${link.link_id}`);
		expect(new Date(link.expires_at).getTime()).toBeGreaterThanOrEqual(before + 7 * 86_400_000);
		const [stored] = await handle.db.select().from(shareLinks);
		expect(stored?.id).not.toBe(link.link_id);
		const events = await handle.db.select().from(shareEvents);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			kind: "link.created",
			actorKind: "agent",
			actorAgentId: sender.agent_id,
			metadata: {},
		});
		const audits = await handle.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.action, "link.created"));
		expect(audits).toHaveLength(1);
		const auditText = JSON.stringify(
			audits.map(({ id, ...entry }) => ({ ...entry, id: String(id) })),
		);
		expect(auditText).not.toContain(link.link_id);
		expect(auditText).not.toContain("sender published proposal");
	});

	it("requires active agent credentials and validates expiry, caps, and strict create input", async () => {
		const missing = await app.request("/shares", { method: "POST", body: "{}" });
		expect(missing.status).toBe(401);
		for (const input of [
			{ content: "🙂".repeat(16385) },
			{ expires_in_days: 31 },
			{ expires_in_days: 0 },
			{ idempotency_key: "not-a-uuid" },
			{ sender_id: other.agent_id },
			{ content: "\u0000" },
		]) {
			expect((await createResponse(input)).status).toBe(400);
		}
		expect(await handle.db.select().from(shareLinks)).toHaveLength(0);
		const max = await createLink({ content: "a".repeat(65536), expires_in_days: 30 });
		const [stored] = await handle.db
			.select()
			.from(shareLinks)
			.where(eq(shareLinks.publicId, max.link_id));
		expect(stored!.expiresAt.getTime() - stored!.createdAt.getTime()).toBe(30 * 86_400_000);
	});

	it("serializes create retries, rejects changed input, and scopes keys to the sender", async () => {
		const idempotency_key = randomUUID();
		const responses = await Promise.all([
			createResponse({ idempotency_key }),
			createResponse({ idempotency_key }),
		]);
		expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
		const receipts = await Promise.all(
			responses.map((response) => response.json() as Promise<Link>),
		);
		expect(receipts[0]!.link_id).toBe(receipts[1]!.link_id);
		expect((await createResponse({ idempotency_key, content: "changed" })).status).toBe(409);
		expect((await createResponse({ idempotency_key, expires_in_days: 8 })).status).toBe(409);
		const otherLink = await createLink({ idempotency_key }, other);
		expect(otherLink.link_id).not.toBe(receipts[0]!.link_id);
		expect(await handle.db.select().from(shareEvents)).toHaveLength(2);
	});

	it("negotiates public reads, uses canonical reply URLs, and counts fetches without bodies or IPs", async () => {
		await handle.db
			.update(agents)
			.set({ companyDomain: "acme.example" })
			.where(eq(agents.id, sender.agent_id));
		const link = await createLink({ content: "<script>alert('x')</script> sender" });
		const markdown = await app.request(`/l/${link.link_id}`, {
			headers: { host: "attacker.example" },
		});
		expect(markdown.status).toBe(200);
		expect(markdown.headers.get("content-type")).toContain("text/markdown");
		const text = await markdown.text();
		expect(text).toContain(`POST https://relay.example/l/${link.link_id}/replies`);
		expect(text).toContain("acme.example (admin-attested");
		expect(text).not.toContain("attacker.example");
		const html = await app.request(`/l/${link.link_id}`, {
			headers: { accept: "text/html", "user-agent": "Slackbot 1.0" },
		});
		expect(html.headers.get("content-type")).toContain("text/html");
		const page = await html.text();
		expect(page).not.toContain("<script>");
		expect(page).toContain("&lt;script&gt;");
		expect(page).toContain('<form method="post"');
		for (const response of [markdown, html]) {
			expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
			expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
			expect(response.headers.get("x-robots-tag")).toContain("noindex");
			expect(response.headers.get("referrer-policy")).toBe("no-referrer");
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(response.headers.get("vary")).toBe("Accept");
		}
		const fetched = await handle.db
			.select()
			.from(shareEvents)
			.where(eq(shareEvents.kind, "link.fetched"))
			.orderBy(asc(shareEvents.id));
		expect(fetched.map((event) => event.metadata)).toEqual([
			{ format: "markdown", known_bot: false },
			{ format: "html", known_bot: true },
		]);
		expect(
			fetched.every((event) => event.actorKind === "external" && event.actorAgentId === null),
		).toBe(true);
	});

	it("holds replies outside the mailbox and never publicly displays held or released external text", async () => {
		const link = await createLink();
		const response = await reply(link);
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({ stored: true, held: true, replayed: false });
		const [stored] = await handle.db.select().from(shareReplies);
		expect(stored).toMatchObject({
			authorKind: "external",
			channel: "api",
			releasedAt: null,
			releasedByAgentId: null,
			seq: 1,
		});
		expect(await handle.db.select().from(messages)).toHaveLength(0);
		expect(await handle.db.select().from(mailboxEvents)).toHaveLength(0);
		const [linkRow] = await handle.db.select().from(shareLinks);
		await handle.db.insert(shareReplies).values({
			linkId: linkRow!.id,
			seq: 2,
			authorKind: "sender",
			channel: "api",
			content: "public sender answer",
			idempotencyKey: randomUUID(),
		});
		for (const released of [false, true]) {
			if (released)
				await handle.db
					.update(shareReplies)
					.set({ releasedAt: new Date(), releasedByAgentId: sender.agent_id })
					.where(eq(shareReplies.id, stored!.id));
			for (const accept of ["text/markdown", "text/html"]) {
				const page = await app.request(`/l/${link.link_id}`, { headers: { accept } });
				const body = await page.text();
				expect(body).not.toContain("external held reply");
				expect(body).toContain("public sender answer");
			}
		}
		const [event] = await handle.db
			.select()
			.from(shareEvents)
			.where(eq(shareEvents.kind, "reply.posted"));
		expect(event).toMatchObject({
			actorKind: "external",
			actorAgentId: null,
			metadata: { channel: "api" },
		});
	});

	it("serializes reply retries and keeps exactly one mutation and audit fact", async () => {
		const link = await createLink();
		const idempotency_key = randomUUID();
		const responses = await Promise.all([
			reply(link, { idempotency_key }),
			reply(link, { idempotency_key }),
		]);
		expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
		expect((await reply(link, { idempotency_key, content: "changed" })).status).toBe(409);
		expect(await handle.db.select().from(shareReplies)).toHaveLength(1);
		expect(
			await handle.db.select().from(shareEvents).where(eq(shareEvents.kind, "reply.posted")),
		).toHaveLength(1);
		expect(
			await handle.db.select().from(auditLog).where(eq(auditLog.action, "reply.posted")),
		).toHaveLength(1);
	});

	it("enforces ten external replies under contention while replaying a key at the limit", async () => {
		const link = await createLink();
		const keys = Array.from({ length: 11 }, () => randomUUID());
		const responses = await Promise.all(
			keys.map((idempotency_key) => reply(link, { idempotency_key })),
		);
		expect(responses.filter((response) => response.status === 201)).toHaveLength(10);
		expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
		const stored = await handle.db.select().from(shareReplies).orderBy(asc(shareReplies.seq));
		expect(stored.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect((await reply(link, { idempotency_key: stored[0]!.idempotencyKey })).status).toBe(200);
	});

	it("accepts the fallback form with retry identity and rejects duplicate fields and injection", async () => {
		const link = await createLink();
		const page = await app.request(`/l/${link.link_id}`, { headers: { accept: "text/html" } });
		const html = await page.text();
		const key = html.match(/name="idempotency_key" value="([^"]+)"/)?.[1];
		expect(key).toBeTruthy();
		const body = new URLSearchParams({
			content: "form reply <script>not public</script>",
			idempotency_key: key!,
		});
		const submit = () =>
			app.request(`/l/${link.link_id}/replies`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: body.toString(),
			});
		const first = await submit();
		expect(first.status).toBe(201);
		expect(first.headers.get("content-type")).toContain("text/html");
		expect(await first.text()).not.toContain("<script>");
		expect((await submit()).status).toBe(200);
		const duplicate = await app.request(`/l/${link.link_id}/replies`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: "content=first&content=second",
		});
		expect(duplicate.status).toBe(400);
		expect((await reply(link, { author_kind: "sender" })).status).toBe(400);
		const [stored] = await handle.db.select().from(shareReplies);
		expect(stored?.channel).toBe("form");
	});

	it("validates reply bytes, raw body size, and accepted content types before storage", async () => {
		const link = await createLink();
		expect((await reply(link, { content: "🙂".repeat(4096) })).status).toBe(201);
		for (const content of ["a".repeat(16385), "🙂".repeat(4097), "", "\u0000"]) {
			expect((await reply(link, { content })).status).toBe(400);
		}
		const large = await app.request(`/l/${link.link_id}/replies`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "a".repeat(100001),
		});
		expect(large.status).toBe(400);
		const plain = await app.request(`/l/${link.link_id}/replies`, {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: "reply",
		});
		expect(plain.status).toBe(400);
		expect(await handle.db.select().from(shareReplies)).toHaveLength(1);
	});

	it("revokes only sender-owned links, closes public reads and writes, and audits once", async () => {
		const link = await createLink();
		const revoke = (owner: Sender) =>
			app.request(`/shares/${link.link_id}/revoke`, {
				method: "POST",
				headers: { authorization: `Bearer ${owner.api_key}` },
			});
		expect((await revoke(other)).status).toBe(404);
		expect((await app.request(`/l/${link.link_id}`)).status).toBe(200);
		const responses = await Promise.all([revoke(sender), revoke(sender)]);
		expect(responses.every((response) => response.status === 200)).toBe(true);
		expect((await app.request(`/l/${link.link_id}`)).status).toBe(404);
		expect((await reply(link)).status).toBe(404);
		expect(
			await handle.db.select().from(auditLog).where(eq(auditLog.action, "link.revoked")),
		).toHaveLength(1);
	});

	it("rejects unknown, expired, or disabled-sender links without content leakage", async () => {
		const link = await createLink();
		for (const id of ["bad-id", "z".repeat(43)]) {
			const response = await app.request(`/l/${id}`);
			expect(response.status).toBe(404);
			expect(await response.text()).not.toContain("sender published proposal");
		}
		const yesterday = new Date(Date.now() - 86_400_000);
		await handle.db
			.update(shareLinks)
			.set({ createdAt: new Date(yesterday.getTime() - 7 * 86_400_000), expiresAt: yesterday })
			.where(eq(shareLinks.publicId, link.link_id));
		expect((await app.request(`/l/${link.link_id}`)).status).toBe(404);
		expect((await reply(link)).status).toBe(404);
		const activeLink = await createLink();
		await handle.db
			.update(agents)
			.set({ status: "disabled" })
			.where(eq(agents.id, sender.agent_id));
		expect((await app.request(`/l/${activeLink.link_id}`)).status).toBe(404);
		expect((await reply(activeLink)).status).toBe(404);
		expect((await createResponse({})).status).toBe(403);
	});

	it("limits public reads by IP and by link and does not record denied fetches", async () => {
		const link = await createLink();
		for (let index = 0; index < 120; index++) {
			const response = await app.request(`/l/${link.link_id}`, {
				headers: { "x-forwarded-for": `198.51.100.${Math.floor(index / 60)}` },
			});
			expect(response.status).toBe(200);
		}
		for (const ip of ["198.51.100.0", "198.51.100.2"]) {
			const denied = await app.request(`/l/${link.link_id}`, {
				headers: { "x-forwarded-for": ip },
			});
			expect(denied.status).toBe(429);
			expect(denied.headers.get("retry-after")).toBe("60");
			expect(denied.headers.get("x-robots-tag")).toContain("noindex");
		}
		expect(
			await handle.db.select().from(shareEvents).where(eq(shareEvents.kind, "link.fetched")),
		).toHaveLength(120);
	});

	it("rolls back replies and measurement if the transaction's audit insert fails", async () => {
		const link = await createLink();
		await handle.sql.unsafe(
			"CREATE FUNCTION share_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'reply.posted' THEN RAISE EXCEPTION 'sensitive reply failure'; END IF; RETURN NEW; END $$",
		);
		await handle.sql.unsafe(
			"CREATE TRIGGER share_test_reject_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION share_test_reject_audit()",
		);
		try {
			const response = await reply(link);
			expect(response.status).toBe(500);
			expect(await response.text()).not.toContain("sensitive reply");
			expect(await handle.db.select().from(shareReplies)).toHaveLength(0);
			expect(
				await handle.db.select().from(shareEvents).where(eq(shareEvents.kind, "reply.posted")),
			).toHaveLength(0);
		} finally {
			await handle.sql.unsafe("DROP TRIGGER share_test_reject_audit ON audit_log");
			await handle.sql.unsafe("DROP FUNCTION share_test_reject_audit()");
		}
	});

	it("deletes all link, reply, and answer bodies thirty days after expiry while retaining facts", async () => {
		const oldLink = await createLink();
		await reply(oldLink);
		const [old] = await handle.db.select().from(shareLinks);
		await handle.db.insert(shareReplies).values({
			linkId: old!.id,
			seq: 2,
			authorKind: "sender",
			channel: "api",
			content: "sender answer",
			idempotencyKey: randomUUID(),
		});
		const expiry = new Date(Date.now() - 31 * 86_400_000);
		await handle.db
			.update(shareLinks)
			.set({ createdAt: new Date(expiry.getTime() - 7 * 86_400_000), expiresAt: expiry })
			.where(eq(shareLinks.id, old!.id));
		const recent = await createLink();
		const recentExpiry = new Date(Date.now() - 29 * 86_400_000);
		await handle.db
			.update(shareLinks)
			.set({
				createdAt: new Date(recentExpiry.getTime() - 7 * 86_400_000),
				expiresAt: recentExpiry,
			})
			.where(eq(shareLinks.publicId, recent.link_id));
		expect(await deleteExpiredShareContent(handle.db)).toBe(1);
		expect(await deleteExpiredShareContent(handle.db)).toBe(0);
		const [deleted] = await handle.db.select().from(shareLinks).where(eq(shareLinks.id, old!.id));
		expect(deleted?.content).toBeNull();
		expect(deleted?.contentDeletedAt).toBeInstanceOf(Date);
		const replies = await handle.db
			.select()
			.from(shareReplies)
			.where(eq(shareReplies.linkId, old!.id));
		expect(replies).toHaveLength(2);
		expect(replies.every((row) => row.content === null)).toBe(true);
		expect(
			await handle.db.select().from(shareEvents).where(eq(shareEvents.linkId, old!.id)),
		).toHaveLength(2);
		const audits = await handle.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.action, "link.content_deleted"));
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({ actorKind: "system", actorId: null, metadata: {} });
		const [retained] = await handle.db
			.select()
			.from(shareLinks)
			.where(eq(shareLinks.publicId, recent.link_id));
		expect(retained?.content).toBe("sender published proposal");
	});
});
