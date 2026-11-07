import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tryConnect } from "./test-utils.js";

const TEST_URL = process.env.RELAY_TEST_DATABASE_URL ?? process.env.RELAY_DATABASE_URL;
const connection = await tryConnect();
const databaseDescribe = connection.available && TEST_URL ? describe : describe.skip;
if (!connection.available) console.warn(`[migration-0012.test] skipping: ${connection.reason}`);

databaseDescribe("0012 share links migration", () => {
	let sql: Sql;
	let migration: string;
	const schemaName = `migration_0012_${randomUUID().replaceAll("-", "")}`;
	const senderId = randomUUID();
	const legacyInviteId = randomUUID();

	async function applyMigration() {
		await sql.begin(async (transaction) => {
			for (const statement of migration.split("--> statement-breakpoint")) {
				if (statement.trim()) await transaction.unsafe(statement);
			}
		});
	}

	async function createLink(content = "Synthetic sender content") {
		const [link] = await sql<Array<{ id: string; public_id: string }>>`
			INSERT INTO share_links (sender_id, public_id, content, idempotency_key)
			VALUES (${senderId}, ${randomBytes(32).toString("base64url")}, ${content}, ${randomUUID()})
			RETURNING id, public_id`;
		if (!link) throw new Error("expected link");
		return link;
	}

	beforeAll(async () => {
		sql = postgres(TEST_URL as string, { max: 1, onnotice: () => undefined });
		await sql.unsafe(`CREATE SCHEMA "${schemaName}"; SET search_path TO "${schemaName}", public;
			CREATE TABLE agents (id uuid PRIMARY KEY);
			CREATE TABLE invites (jti uuid PRIMARY KEY);
			CREATE TABLE audit_log (
				id bigserial PRIMARY KEY, actor_kind text NOT NULL DEFAULT 'agent',
				actor_id uuid REFERENCES agents(id), action text NOT NULL,
				CONSTRAINT audit_log_actor_kind_chk CHECK (actor_kind IN ('agent','admin','system')),
				CONSTRAINT audit_log_actor_identity_chk CHECK (
					(actor_kind = 'agent' AND actor_id IS NOT NULL)
					OR (actor_kind IN ('admin','system') AND actor_id IS NULL))
			);`);
		await sql`INSERT INTO agents (id) VALUES (${senderId})`;
		await sql`INSERT INTO invites (jti) VALUES (${legacyInviteId})`;
		await sql`INSERT INTO audit_log (actor_id, action) VALUES (${senderId}, 'legacy.action')`;
		migration = await readFile(
			new URL("../../drizzle/0012_share_links.sql", import.meta.url),
			"utf8",
		);
		await applyMigration();
	});

	afterAll(async () => {
		if (sql) {
			await sql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
			await sql.end({ timeout: 2 });
		}
		await connection.handle?.close();
	});

	it("keeps legacy domains unknown, preserves audit, and reapplies without erasing attestations", async () => {
		expect(await sql`SELECT company_domain FROM agents`).toEqual([{ company_domain: null }]);
		expect(await sql`SELECT company_domain FROM invites`).toEqual([{ company_domain: null }]);
		expect(await sql`SELECT actor_kind, actor_id, action FROM audit_log`).toEqual([
			{ actor_kind: "agent", actor_id: senderId, action: "legacy.action" },
		]);
		await sql`UPDATE agents SET company_domain = 'example.com' WHERE id = ${senderId}`;
		await sql`UPDATE invites SET company_domain = 'example.com' WHERE jti = ${legacyInviteId}`;
		await applyMigration();
		expect(await sql`SELECT company_domain FROM agents`).toEqual([
			{ company_domain: "example.com" },
		]);
		expect(await sql`SELECT company_domain FROM invites`).toEqual([
			{ company_domain: "example.com" },
		]);
		const indexes = await sql`SELECT indexname FROM pg_indexes WHERE schemaname = ${schemaName}
			AND tablename IN ('share_links','share_replies','share_events') ORDER BY indexname`;
		expect(indexes.map((row) => row.indexname)).toEqual([
			"idx_share_events_link",
			"idx_share_events_link_created",
			"idx_share_events_reply_kind",
			"idx_share_links_idempotency",
			"idx_share_links_public_id",
			"idx_share_links_retention",
			"idx_share_links_sender",
			"idx_share_replies_idempotency",
			"idx_share_replies_identity_link",
			"idx_share_replies_link_seq",
			"share_events_pkey",
			"share_links_pkey",
			"share_replies_pkey",
		]);
	});

	it("enforces link capability shape, byte limit, expiry, deletion shape, and creation identity", async () => {
		const link = await createLink("é".repeat(32_768));
		const [expiry] =
			await sql`SELECT expires_at - created_at AS lifetime FROM share_links WHERE id = ${link.id}`;
		expect(expiry?.lifetime).toBe("7 days");
		await expect(createLink("é".repeat(32_769))).rejects.toThrow(/share_links_content_size_chk/);
		await expect(
			sql`UPDATE share_links SET public_id = 'guessable' WHERE id = ${link.id}`,
		).rejects.toThrow(/share_links_public_id_chk/);
		await expect(sql`UPDATE share_links SET expires_at = created_at + interval '31 days'
			WHERE id = ${link.id}`).rejects.toThrow(/share_links_expiry_chk/);
		await expect(
			sql`UPDATE share_links SET expires_at = created_at WHERE id = ${link.id}`,
		).rejects.toThrow(/share_links_expiry_chk/);
		await sql`UPDATE share_links SET expires_at = created_at + interval '30 days' WHERE id = ${link.id}`;
		await expect(sql`INSERT INTO share_links (sender_id, public_id, content, idempotency_key)
			VALUES (${senderId}, ${link.public_id}, 'duplicate', ${randomUUID()})`).rejects.toThrow(
			/idx_share_links_public_id/,
		);
		await expect(sql`INSERT INTO share_links (sender_id, public_id, content, idempotency_key)
			SELECT sender_id, ${randomBytes(32).toString("base64url")}, 'duplicate', idempotency_key
			FROM share_links WHERE id = ${link.id}`).rejects.toThrow(/idx_share_links_idempotency/);
		await expect(sql`UPDATE share_links SET content = NULL WHERE id = ${link.id}`).rejects.toThrow(
			/share_links_content_state_chk/,
		);
		await sql`UPDATE share_links SET content = NULL, content_deleted_at = now() WHERE id = ${link.id}`;
	});

	it("keeps external replies held, separates sender answers, and checks release and ordering", async () => {
		const link = await createLink();
		const replyId = randomUUID();
		const key = randomUUID();
		await sql`INSERT INTO share_replies (id, link_id, seq, author_kind, channel, content, idempotency_key)
			VALUES (${replyId}, ${link.id}, 1, 'external', 'form', ${"é".repeat(8192)}, ${key}),
			(${randomUUID()}, ${link.id}, 2, 'sender', 'api', 'Public answer', ${key})`;
		expect(
			await sql`SELECT released_at, released_by_agent_id FROM share_replies WHERE id = ${replyId}`,
		).toEqual([{ released_at: null, released_by_agent_id: null }]);
		await expect(
			sql`UPDATE share_replies SET content = ${"é".repeat(8193)} WHERE id = ${replyId}`,
		).rejects.toThrow(/share_replies_content_size_chk/);
		await expect(
			sql`UPDATE share_replies SET author_kind = 'verified' WHERE id = ${replyId}`,
		).rejects.toThrow(/share_replies_author_kind_chk/);
		await expect(
			sql`UPDATE share_replies SET channel = 'email' WHERE id = ${replyId}`,
		).rejects.toThrow(/share_replies_channel_chk/);
		await expect(sql`UPDATE share_replies SET seq = 0 WHERE id = ${replyId}`).rejects.toThrow(
			/share_replies_seq_chk/,
		);
		await expect(sql`UPDATE share_replies SET seq = 2 WHERE id = ${replyId}`).rejects.toThrow(
			/idx_share_replies_link_seq/,
		);
		await expect(sql`INSERT INTO share_replies (link_id, seq, author_kind, channel, content, idempotency_key)
			VALUES (${link.id}, 3, 'external', 'api', 'Repeat', ${key})`).rejects.toThrow(
			/idx_share_replies_idempotency/,
		);
		await expect(
			sql`UPDATE share_replies SET released_at = now() WHERE id = ${replyId}`,
		).rejects.toThrow(/share_replies_release_chk/);
		await expect(sql`UPDATE share_replies SET released_at = now(), released_by_agent_id = ${senderId}
			WHERE author_kind = 'sender' AND link_id = ${link.id}`).rejects.toThrow(
			/share_replies_release_chk/,
		);
		await sql`UPDATE share_replies SET released_at = now(), released_by_agent_id = ${senderId} WHERE id = ${replyId}`;
		await sql`UPDATE share_replies SET content = NULL WHERE link_id = ${link.id}`;
	});

	it("records repeat fetches but unique mutation facts with exact reply/link and actor identity", async () => {
		const link = await createLink();
		const otherLink = await createLink();
		const replyId = randomUUID();
		await sql`INSERT INTO share_replies (id, link_id, seq, author_kind, channel, content, idempotency_key)
			VALUES (${replyId}, ${link.id}, 1, 'external', 'api', 'Held reply', ${randomUUID()})`;
		await sql`INSERT INTO share_events (link_id, kind, actor_kind, actor_agent_id)
			VALUES (${link.id}, 'link.created', 'agent', ${senderId})`;
		await sql`INSERT INTO share_events (link_id, kind, actor_kind)
			VALUES (${link.id}, 'link.fetched', 'external'), (${link.id}, 'link.fetched', 'external'),
			(${link.id}, 'invite.requested', 'external')`;
		await sql`INSERT INTO share_events (link_id, reply_id, kind, actor_kind)
			VALUES (${link.id}, ${replyId}, 'reply.posted', 'external')`;
		await sql`INSERT INTO share_events (link_id, reply_id, kind, actor_kind, actor_agent_id)
			VALUES (${link.id}, ${replyId}, 'reply.released', 'agent', ${senderId})`;
		await expect(sql`INSERT INTO share_events (link_id, kind, actor_kind, actor_agent_id)
			VALUES (${link.id}, 'link.created', 'agent', ${senderId})`).rejects.toThrow(
			/idx_share_events_link_created/,
		);
		await expect(sql`INSERT INTO share_events (link_id, reply_id, kind, actor_kind)
			VALUES (${link.id}, ${replyId}, 'reply.posted', 'external')`).rejects.toThrow(
			/idx_share_events_reply_kind/,
		);
		await expect(sql`INSERT INTO share_events (link_id, reply_id, kind, actor_kind, actor_agent_id)
			VALUES (${otherLink.id}, ${replyId}, 'answer.posted', 'agent', ${senderId})`).rejects.toThrow(
			/share_events_reply_link_fk/,
		);
		await expect(sql`INSERT INTO share_events (link_id, kind, actor_kind)
			VALUES (${link.id}, 'agent.processed', 'external')`).rejects.toThrow(/share_events_kind_chk/);
		await expect(sql`INSERT INTO share_events (link_id, kind, actor_kind)
			VALUES (${link.id}, 'reply.posted', 'external')`).rejects.toThrow(/share_events_reply_chk/);
		await expect(sql`INSERT INTO share_events (link_id, kind, actor_kind, actor_agent_id)
			VALUES (${link.id}, 'link.fetched', 'external', ${senderId})`).rejects.toThrow(
			/share_events_actor_chk/,
		);
		await expect(sql`INSERT INTO share_events (link_id, kind, actor_kind)
			VALUES (${link.id}, 'link.fetched', 'agent')`).rejects.toThrow(/share_events_actor_chk/);
		await expect(sql`INSERT INTO share_events (link_id, kind, actor_kind, metadata)
			VALUES (${link.id}, 'link.fetched', 'external', '[]'::jsonb)`).rejects.toThrow(
			/share_events_metadata_chk/,
		);
	});

	it("permits external audit without fabricating an agent and preserves authenticated actor checks", async () => {
		await sql`INSERT INTO audit_log (actor_kind, action) VALUES ('external', 'reply.posted')`;
		expect(await sql`SELECT actor_id FROM audit_log WHERE actor_kind = 'external'`).toEqual([
			{ actor_id: null },
		]);
		await expect(sql`INSERT INTO audit_log (actor_kind, actor_id, action)
			VALUES ('external', ${senderId}, 'reply.posted')`).rejects.toThrow(
			/audit_log_actor_identity_chk/,
		);
		await expect(
			sql`INSERT INTO audit_log (actor_kind, action) VALUES ('agent', 'answer.posted')`,
		).rejects.toThrow(/audit_log_actor_identity_chk/);
		await expect(
			sql`INSERT INTO audit_log (actor_kind, action) VALUES ('verified_company', 'reply.posted')`,
		).rejects.toThrow(/audit_log_actor_(kind|identity)_chk/);
	});
});
