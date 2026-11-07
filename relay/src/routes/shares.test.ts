import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLastUsedDebounce } from "../auth/middleware.js";
import { loadConfig } from "../config.js";
import {
	agentCards,
	agents,
	auditLog,
	invites,
	mailboxEvents,
	messages,
	shareEvents,
	shareLinks,
	shareReplies,
} from "../db/schema.js";
import { type TestDb, truncateAll, tryConnect } from "../db/test-utils.js";
import { createLogger } from "../logger.js";
import { encryptWebhook } from "../notifications/crypto.js";
import { sendShareReplyHint } from "../notifications/share-hint.js";
import type { SlackPoster } from "../notifications/slack.js";
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
	const slackPoster = vi.fn<SlackPoster>();

	beforeAll(() => {
		if (!conn.handle) throw new Error("expected database handle");
		handle = conn.handle;
	});
	beforeEach(async () => {
		await truncateAll(handle.sql);
		clearLastUsedDebounce();
		nextIp = 1;
		const config = loadConfig(TEST_ENV);
		slackPoster.mockReset();
		slackPoster.mockResolvedValue({ status: 200, ok: true });
		app = createServer({
			config,
			logger: createLogger(config),
			db: handle.db,
			shareSlackPoster: slackPoster,
		});
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
	function release(replyId: string, owner = sender, confirmation: unknown = "release_to_inbox") {
		return app.request(`/shares/replies/${replyId}/release`, {
			method: "POST",
			headers: { authorization: `Bearer ${owner.api_key}`, "content-type": "application/json" },
			body: JSON.stringify({ confirmation }),
		});
	}
	function inbox(query = "", owner = sender) {
		return app.request(`/shares/inbox${query}`, {
			headers: { authorization: `Bearer ${owner.api_key}` },
		});
	}

	function inviteRequest(link: Link, input: Record<string, unknown> = {}, ip?: string) {
		return app.request(`/l/${link.link_id}/invite-requests`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-forwarded-for": ip ?? `192.0.2.${nextIp++}`,
			},
			body: JSON.stringify({ idempotency_key: randomUUID(), ...input }),
		});
	}

	it("records explicit external invite interest with audit, without identity, contact or account effects", async () => {
		const link = await createLink();
		const key = randomUUID();
		const response = await inviteRequest(link, { idempotency_key: key });
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({
			recorded: true,
			invite_issued: false,
			replayed: false,
		});
		expect(response.headers.get("x-robots-tag")).toContain("noindex");
		expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
		const events = await handle.db
			.select()
			.from(shareEvents)
			.where(eq(shareEvents.kind, "invite.requested"));
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			actorKind: "external",
			actorAgentId: null,
			replyId: null,
			metadata: { channel: "api", idempotency_key: key },
		});
		const audits = await handle.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.action, "invite.requested"));
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({
			actorKind: "external",
			actorId: null,
			resourceType: "share_link",
			resourceId: events[0]?.linkId,
			metadata: { channel: "api" },
		});
		const facts = JSON.stringify({ events, audits }, (_name, value) =>
			typeof value === "bigint" ? value.toString() : value,
		);
		expect(facts).not.toContain(link.link_id);
		expect(facts).not.toContain("sender published proposal");
		expect(facts).not.toContain("192.0.2.");
		expect(await handle.db.select().from(agents)).toHaveLength(2);
		expect(await handle.db.select().from(invites)).toHaveLength(0);
		expect(await handle.db.select().from(shareReplies)).toHaveLength(0);
		expect(await handle.db.select().from(messages)).toHaveLength(0);
		expect(await handle.db.select().from(mailboxEvents)).toHaveLength(0);
		expect(slackPoster).not.toHaveBeenCalled();
	});

	it("serializes invite request retries, scopes their keys to links, and rejects a changed channel", async () => {
		const link = await createLink();
		const key = randomUUID();
		const responses = await Promise.all(
			Array.from({ length: 3 }, () => inviteRequest(link, { idempotency_key: key })),
		);
		expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 201]);
		for (const response of responses) {
			expect(await response.json()).toMatchObject({ recorded: true, invite_issued: false });
		}
		expect(
			await handle.db.select().from(shareEvents).where(eq(shareEvents.kind, "invite.requested")),
		).toHaveLength(1);
		expect(
			await handle.db.select().from(auditLog).where(eq(auditLog.action, "invite.requested")),
		).toHaveLength(1);
		const conflicting = await app.request(`/l/${link.link_id}/invite-requests`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ idempotency_key: key }).toString(),
		});
		expect(conflicting.status).toBe(409);
		const second = await createLink();
		expect((await inviteRequest(second, { idempotency_key: key })).status).toBe(201);
		expect(
			await handle.db.select().from(shareEvents).where(eq(shareEvents.kind, "invite.requested")),
		).toHaveLength(2);
	});

	it("accepts the rendered optional HTML invite form and safely replays its key", async () => {
		const link = await createLink();
		const page = await app.request(`/l/${link.link_id}`, { headers: { accept: "text/html" } });
		const html = await page.text();
		const form = html.match(
			/<form method="post" action="([^"]+\/invite-requests)"><input type="hidden" name="idempotency_key" value="([^"]+)"/,
		);
		expect(form?.[1]).toBe(`${link.url}/invite-requests`);
		const post = () =>
			app.request(`/l/${link.link_id}/invite-requests`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ idempotency_key: form![2]! }).toString(),
			});
		const response = await post();
		expect(response.status).toBe(201);
		expect(await response.text()).toContain(
			"No account was created, no invite was issued, and no email was sent",
		);
		expect((await post()).status).toBe(200);
		const [event] = await handle.db
			.select()
			.from(shareEvents)
			.where(eq(shareEvents.kind, "invite.requested"));
		expect(event?.metadata).toEqual({ channel: "form", idempotency_key: form![2] });
	});

	it("rejects invalid, duplicate, oversized, and contact-bearing invite request payloads before measurement", async () => {
		const link = await createLink();
		const path = `/l/${link.link_id}/invite-requests`;
		for (const input of [
			{ idempotency_key: undefined },
			{ idempotency_key: "not-a-uuid" },
			{ email: "private@receiver.example" },
			{ content: "private external body" },
			{ actor_kind: "agent" },
		]) {
			expect((await inviteRequest(link, input)).status).toBe(400);
		}
		for (const [contentType, body] of [
			["application/json", "{"],
			["application/json", ` ${" ".repeat(1024)}`],
			["text/plain", "no"],
			[
				"application/x-www-form-urlencoded",
				`idempotency_key=${randomUUID()}&idempotency_key=${randomUUID()}`,
			],
		]) {
			const response = await app.request(path, {
				method: "POST",
				headers: { "content-type": contentType! },
				body,
			});
			expect(response.status).toBe(400);
		}
		expect(
			await handle.db.select().from(shareEvents).where(eq(shareEvents.kind, "invite.requested")),
		).toHaveLength(0);
		expect(
			await handle.db.select().from(auditLog).where(eq(auditLog.action, "invite.requested")),
		).toHaveLength(0);
	});

	it("does not record invite requests from reads or unavailable capabilities", async () => {
		const link = await createLink();
		expect((await app.request(`/l/${link.link_id}`)).status).toBe(200);
		expect(
			await handle.db.select().from(shareEvents).where(eq(shareEvents.kind, "invite.requested")),
		).toHaveLength(0);
		expect((await inviteRequest({ ...link, link_id: "a".repeat(43) })).status).toBe(404);
		expect((await inviteRequest({ ...link, link_id: "malformed" })).status).toBe(404);
		await handle.db
			.update(agents)
			.set({ status: "disabled" })
			.where(eq(agents.id, sender.agent_id));
		expect((await inviteRequest(link)).status).toBe(404);
		await handle.db.update(agents).set({ status: "active" }).where(eq(agents.id, sender.agent_id));
		await handle.db
			.update(shareLinks)
			.set({
				createdAt: new Date(Date.now() - 2 * 86_400_000),
				expiresAt: new Date(Date.now() - 86_400_000),
			})
			.where(eq(shareLinks.publicId, link.link_id));
		expect((await inviteRequest(link)).status).toBe(404);
		const revoked = await createLink();
		await handle.db
			.update(shareLinks)
			.set({ revokedAt: new Date() })
			.where(eq(shareLinks.publicId, revoked.link_id));
		expect((await inviteRequest(revoked)).status).toBe(404);
		const deleted = await createLink();
		await handle.db
			.update(shareLinks)
			.set({ content: null, contentDeletedAt: new Date() })
			.where(eq(shareLinks.publicId, deleted.link_id));
		expect((await inviteRequest(deleted)).status).toBe(404);
		expect(
			await handle.db.select().from(shareEvents).where(eq(shareEvents.kind, "invite.requested")),
		).toHaveLength(0);
	});

	it("shares IP write admission across replies and invite requests", async () => {
		const link = await createLink();
		const ip = "198.51.100.77";
		for (let count = 0; count < 5; count++) expect((await reply(link, {}, ip)).status).toBe(201);
		for (let count = 0; count < 5; count++)
			expect((await inviteRequest(link, {}, ip)).status).toBe(201);
		const denied = await inviteRequest(link, {}, ip);
		expect(denied.status).toBe(429);
		expect(denied.headers.get("retry-after")).toBe("60");
		expect(denied.headers.get("x-robots-tag")).toContain("noindex");
		expect((await reply(link, {}, ip)).status).toBe(429);
		expect(
			await handle.db.select().from(shareEvents).where(eq(shareEvents.kind, "invite.requested")),
		).toHaveLength(5);
	});

	it("limits invite requests per link without consuming the ten-reply budget", async () => {
		const link = await createLink();
		for (let count = 0; count < 20; count++) expect((await inviteRequest(link)).status).toBe(201);
		expect((await inviteRequest(link)).status).toBe(429);
		expect((await reply(link)).status).toBe(429);
		expect(
			await handle.db.select().from(shareEvents).where(eq(shareEvents.kind, "invite.requested")),
		).toHaveLength(20);
		expect(await handle.db.select().from(shareReplies)).toHaveLength(0);
	});

	it("rolls back invite-request measurement when its external audit fails", async () => {
		const link = await createLink();
		await handle.sql.unsafe(
			"CREATE FUNCTION share_test_reject_invite_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'invite.requested' THEN RAISE EXCEPTION 'private invite request diagnostic'; END IF; RETURN NEW; END $$",
		);
		await handle.sql.unsafe(
			"CREATE TRIGGER share_test_reject_invite_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION share_test_reject_invite_audit()",
		);
		try {
			const response = await inviteRequest(link);
			expect(response.status).toBe(500);
			expect(await response.text()).not.toContain("private invite request diagnostic");
			expect(
				await handle.db.select().from(shareEvents).where(eq(shareEvents.kind, "invite.requested")),
			).toHaveLength(0);
			expect(
				await handle.db.select().from(auditLog).where(eq(auditLog.action, "invite.requested")),
			).toHaveLength(0);
		} finally {
			await handle.sql.unsafe("DROP TRIGGER share_test_reject_invite_audit ON audit_log");
			await handle.sql.unsafe("DROP FUNCTION share_test_reject_invite_audit()");
		}
	});

	async function configureWebhook(value: string | null) {
		await handle.db
			.insert(agentCards)
			.values({ agentId: sender.agent_id, card: {}, notificationWebhookUrl: value })
			.onConflictDoUpdate({
				target: agentCards.agentId,
				set: { notificationWebhookUrl: value },
			});
	}

	it("sends only a constant waiting hint to the sender's configured Slack webhook", async () => {
		const webhook = "https://hooks.slack.com/services/T/B/private-webhook";
		await configureWebhook(encryptWebhook(webhook, TEST_ENV.RELAY_ENCRYPTION_KEY));
		const link = await createLink({ content: "private sender text" });
		const key = randomUUID();
		expect(
			(await reply(link, { content: "private external text", idempotency_key: key })).status,
		).toBe(201);
		expect(slackPoster).toHaveBeenCalledTimes(1);
		expect(slackPoster).toHaveBeenCalledWith(
			webhook,
			{
				text: "AgentRelay: an unverified handoff-link reply is waiting for owner review. It is held until you explicitly release it; this hint does not mean agent processing.",
			},
			expect.any(AbortSignal),
		);
		const payload = JSON.stringify(slackPoster.mock.calls[0]?.[1]);
		for (const privateValue of [
			link.link_id,
			link.url,
			sender.agent_id,
			"sender@acme",
			"private sender text",
			"private external text",
		]) {
			expect(payload).not.toContain(privateValue);
		}
		expect(
			(await reply(link, { content: "private external text", idempotency_key: key })).status,
		).toBe(200);
		expect(slackPoster).toHaveBeenCalledTimes(1);
		expect((await answer(link)).status).toBe(201);
		expect(slackPoster).toHaveBeenCalledTimes(1);
		const held = await handle.db.select().from(shareReplies);
		expect(held.find((row) => row.authorKind === "external")?.releasedAt).toBeNull();
	});

	it("sends the same content-free hint for an HTML form reply", async () => {
		await configureWebhook(
			encryptWebhook("https://hooks.slack.com/services/T/B/form", TEST_ENV.RELAY_ENCRYPTION_KEY),
		);
		const link = await createLink();
		const response = await app.request(`/l/${link.link_id}/replies`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				content: "untrusted form content",
				idempotency_key: randomUUID(),
			}).toString(),
		});
		expect(response.status).toBe(201);
		expect(slackPoster).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(slackPoster.mock.calls[0]?.[1])).not.toContain("untrusted form content");
	});

	it.each([
		null,
		"legacy-plaintext-url",
		encryptWebhook("https://127.0.0.1/internal", TEST_ENV.RELAY_ENCRYPTION_KEY),
		encryptWebhook("https://hooks.slack.com/services/T/B/wrong-key", "wrong-encryption-key"),
	])("stores replies without posting to an unusable webhook (%#)", async (value) => {
		await configureWebhook(value);
		const link = await createLink();
		expect((await reply(link)).status).toBe(201);
		expect(slackPoster).not.toHaveBeenCalled();
		expect(await handle.db.select().from(shareReplies)).toHaveLength(1);
	});

	it.each([
		new Error("sensitive webhook error"),
		{ status: 429, ok: false },
		{ status: 500, ok: false },
	])("does not retry or roll back a stored reply when Slack fails (%#)", async (result) => {
		await configureWebhook(
			encryptWebhook("https://hooks.slack.com/services/T/B/test", TEST_ENV.RELAY_ENCRYPTION_KEY),
		);
		if (result instanceof Error) slackPoster.mockRejectedValue(result);
		else slackPoster.mockResolvedValue(result);
		const link = await createLink();
		expect((await reply(link)).status).toBe(201);
		expect(slackPoster).toHaveBeenCalledTimes(1);
		expect(await handle.db.select().from(shareReplies)).toHaveLength(1);
		expect(
			(await handle.db.select().from(shareEvents)).filter((row) => row.kind === "reply.posted"),
		).toHaveLength(1);
	});

	it("bounds a stuck Slack hint without failing the durable reply receipt", async () => {
		await configureWebhook(
			encryptWebhook("https://hooks.slack.com/services/T/B/test", TEST_ENV.RELAY_ENCRYPTION_KEY),
		);
		slackPoster.mockImplementation(() => new Promise(() => {}));
		const link = await createLink();
		expect((await reply(link)).status).toBe(201);
		expect(slackPoster.mock.calls[0]?.[2]?.aborted).toBe(true);
		expect(await handle.db.select().from(shareReplies)).toHaveLength(1);
	}, 10_000);

	it("skips hints after sender disablement or link revocation", async () => {
		await configureWebhook(
			encryptWebhook("https://hooks.slack.com/services/T/B/test", TEST_ENV.RELAY_ENCRYPTION_KEY),
		);
		const link = await createLink();
		await handle.db
			.update(agents)
			.set({ status: "disabled" })
			.where(eq(agents.id, sender.agent_id));
		const options = {
			encryptionKey: TEST_ENV.RELAY_ENCRYPTION_KEY,
			logger: createLogger(loadConfig(TEST_ENV)),
			slackPoster,
		};
		await sendShareReplyHint(handle.db, link.link_id, options);
		await handle.db.update(agents).set({ status: "active" }).where(eq(agents.id, sender.agent_id));
		await handle.db
			.update(shareLinks)
			.set({ revokedAt: new Date() })
			.where(eq(shareLinks.publicId, link.link_id));
		await sendShareReplyHint(handle.db, link.link_id, options);
		expect(slackPoster).not.toHaveBeenCalled();
	});

	it("keeps held bodies out of the inbox and atomically releases one external reply once", async () => {
		const link = await createLink();
		const key = randomUUID();
		await reply(link, { content: "private external instructions", idempotency_key: key });
		const [stored] = await handle.db.select().from(shareReplies);
		expect(await (await inbox()).json()).toEqual({
			replies: [],
			next_cursor: "0",
			has_more: false,
		});
		const releases = await Promise.all([release(stored!.id), release(stored!.id)]);
		expect(releases.every((response) => response.status === 200)).toBe(true);
		const receipts = await Promise.all(releases.map((response) => response.json()));
		expect(receipts.map((receipt) => receipt.replayed).sort()).toEqual([false, true]);
		expect(receipts[0].released_at).toBe(receipts[1].released_at);
		const page = await (await inbox()).json();
		expect(page.replies).toHaveLength(1);
		expect(page.replies[0]).toMatchObject({
			link_id: link.link_id,
			reply_id: stored!.id,
			content: "private external instructions",
			origin: "external_unverified",
			channel: "api",
			released_at: receipts[0].released_at,
		});
		expect(await (await inbox(`?after_cursor=${page.next_cursor}`)).json()).toEqual({
			replies: [],
			next_cursor: page.next_cursor,
			has_more: false,
		});
		expect((await (await listReplies(link)).json()).replies[0].released_at).toBe(
			receipts[0].released_at,
		);
		const [released] = await handle.db.select().from(shareReplies);
		expect(released!.releasedByAgentId).toBe(sender.agent_id);
		expect(
			await handle.db.select().from(shareEvents).where(eq(shareEvents.kind, "reply.released")),
		).toHaveLength(1);
		const audits = await handle.db
			.select()
			.from(auditLog)
			.where(eq(auditLog.action, "reply.released"));
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({ actorKind: "agent", actorId: sender.agent_id });
		expect(JSON.stringify(audits.map((audit) => audit.metadata))).not.toContain(
			"private external instructions",
		);
		expect(await handle.db.select().from(messages)).toHaveLength(0);
		expect(await handle.db.select().from(mailboxEvents)).toHaveLength(0);
		for (const accept of ["text/markdown", "text/html"]) {
			expect(
				await (await app.request(`/l/${link.link_id}`, { headers: { accept } })).text(),
			).not.toContain("private external instructions");
		}
		const replay = await reply(link, {
			content: "private external instructions",
			idempotency_key: key,
		});
		expect(await replay.json()).toEqual({ stored: true, replayed: true });
	});

	it("authorizes private release and inbox reads without accepting link capabilities or sender answers", async () => {
		const link = await createLink();
		await reply(link);
		const [stored] = await handle.db.select().from(shareReplies);
		expect((await release(stored!.id, other)).status).toBe(404);
		expect((await release(randomUUID())).status).toBe(404);
		expect((await release("invalid")).status).toBe(400);
		expect((await release(stored!.id, sender, "yes")).status).toBe(400);
		expect(
			(
				await app.request(`/shares/replies/${stored!.id}/release`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${sender.api_key}`,
						"content-type": "application/json",
					},
					body: "{}",
				})
			).status,
		).toBe(400);
		const answerReceipt = await (await answer(link)).json();
		expect((await release(answerReceipt.answer_id)).status).toBe(404);
		expect(
			(
				await app.request(`/shares/replies/${stored!.id}/release`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ confirmation: "release_to_inbox" }),
				})
			).status,
		).toBe(401);
		expect((await app.request("/shares/inbox")).status).toBe(401);
		expect(
			(await app.request("/shares/inbox", { headers: { authorization: `Bearer ${link.link_id}` } }))
				.status,
		).toBe(401);
		expect((await (await inbox("", other)).json()).replies).toEqual([]);
		await handle.db
			.update(agents)
			.set({ status: "disabled" })
			.where(eq(agents.id, sender.agent_id));
		expect((await release(stored!.id)).status).toBe(403);
		expect((await inbox()).status).toBe(403);
	});

	it("pages released replies across links in release order and replays after router reconstruction", async () => {
		const first = await createLink();
		const second = await createLink();
		await reply(first);
		await reply(second);
		const stored = await handle.db.select().from(shareReplies).orderBy(asc(shareReplies.createdAt));
		await release(stored[1]!.id);
		await release(stored[0]!.id);
		const firstPage = await (await inbox("?limit=1")).json();
		expect(firstPage.replies.map((entry: { reply_id: string }) => entry.reply_id)).toEqual([
			stored[1]!.id,
		]);
		expect(firstPage.has_more).toBe(true);
		const config = loadConfig(TEST_ENV);
		app = createServer({ config, logger: createLogger(config), db: handle.db });
		const secondPage = await (await inbox(`?limit=1&after_cursor=${firstPage.next_cursor}`)).json();
		expect(secondPage.replies.map((entry: { reply_id: string }) => entry.reply_id)).toEqual([
			stored[0]!.id,
		]);
		expect(secondPage.has_more).toBe(false);
		expect(BigInt(secondPage.next_cursor)).toBeGreaterThan(BigInt(firstPage.next_cursor));
		expect((await (await inbox("?since=2099-01-01T00%3A00%3A00.000Z")).json()).replies).toEqual([]);
		for (const query of [
			"?limit=0",
			"?limit=11",
			"?after_cursor=-1",
			"?after_cursor=01",
			"?after_cursor=invalid",
			"?after_cursor=9223372036854775808",
			"?since=invalid",
			"?status=pending",
		]) {
			expect((await inbox(query)).status).toBe(400);
		}
	});

	it("allows private historical release until deletion without reviving the public link", async () => {
		const link = await createLink();
		await reply(link);
		const [stored] = await handle.db.select().from(shareReplies);
		await app.request(`/shares/${link.link_id}/revoke`, {
			method: "POST",
			headers: { authorization: `Bearer ${sender.api_key}` },
		});
		expect((await release(stored!.id)).status).toBe(200);
		expect((await app.request(`/l/${link.link_id}`)).status).toBe(404);
		await handle.db
			.update(shareLinks)
			.set({
				createdAt: new Date(Date.now() - 39 * 86_400_000),
				expiresAt: new Date(Date.now() - 31 * 86_400_000),
			})
			.where(eq(shareLinks.publicId, link.link_id));
		await deleteExpiredShareContent(handle.db);
		expect((await release(stored!.id)).status).toBe(404);
		const page = await (await inbox()).json();
		expect(page.replies[0]).toMatchObject({
			reply_id: stored!.id,
			content: null,
			origin: "external_unverified",
		});
		expect(page.next_cursor).toBe(page.replies[0].cursor);
	});

	it("does not checkpoint past a release whose transaction has not committed", async () => {
		const first = await createLink();
		const second = await createLink();
		await reply(first);
		await reply(second);
		const stored = await handle.db.select().from(shareReplies).orderBy(asc(shareReplies.createdAt));
		await handle.sql.unsafe(
			`CREATE FUNCTION share_test_delay_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind = 'reply.released' AND NEW.reply_id = '${stored[0]!.id}'::uuid THEN PERFORM pg_sleep(0.2); END IF; RETURN NEW; END $$`,
		);
		await handle.sql.unsafe(
			"CREATE TRIGGER share_test_delay_release BEFORE INSERT ON share_events FOR EACH ROW EXECUTE FUNCTION share_test_delay_release()",
		);
		try {
			const slow = release(stored[0]!.id);
			await new Promise((resolve) => setTimeout(resolve, 25));
			const fast = release(stored[1]!.id);
			const observed = await (await inbox()).json();
			expect((await slow).status).toBe(200);
			expect((await fast).status).toBe(200);
			const later = await (await inbox(`?after_cursor=${observed.next_cursor}`)).json();
			const ids = [...observed.replies, ...later.replies].map(
				(entry: { reply_id: string }) => entry.reply_id,
			);
			expect(ids.sort()).toEqual(stored.map((entry) => entry.id).sort());
		} finally {
			await handle.sql.unsafe("DROP TRIGGER share_test_delay_release ON share_events");
			await handle.sql.unsafe("DROP FUNCTION share_test_delay_release()");
		}
	});

	it("rolls back release state and its replay event when the audit write fails", async () => {
		const link = await createLink();
		await reply(link);
		const [stored] = await handle.db.select().from(shareReplies);
		await handle.sql.unsafe(
			"CREATE FUNCTION share_test_reject_release_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'reply.released' THEN RAISE EXCEPTION 'release failure'; END IF; RETURN NEW; END $$",
		);
		await handle.sql.unsafe(
			"CREATE TRIGGER share_test_reject_release_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION share_test_reject_release_audit()",
		);
		try {
			expect((await release(stored!.id)).status).toBe(500);
			expect((await (await inbox()).json()).replies).toEqual([]);
			const [unchanged] = await handle.db.select().from(shareReplies);
			expect(unchanged!.releasedAt).toBeNull();
			expect(unchanged!.releasedByAgentId).toBeNull();
			expect(
				await handle.db.select().from(shareEvents).where(eq(shareEvents.kind, "reply.released")),
			).toHaveLength(0);
		} finally {
			await handle.sql.unsafe("DROP TRIGGER share_test_reject_release_audit ON audit_log");
			await handle.sql.unsafe("DROP FUNCTION share_test_reject_release_audit()");
		}
		expect((await release(stored!.id)).status).toBe(200);
	});

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
		expect(await response.json()).toEqual({ stored: true, replayed: false });
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
		await configureWebhook(
			encryptWebhook("https://hooks.slack.com/services/T/B/test", TEST_ENV.RELAY_ENCRYPTION_KEY),
		);
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
			expect(slackPoster).not.toHaveBeenCalled();
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
