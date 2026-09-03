import { and, desc, eq, gte } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { generateKey } from "../auth/keys.js";
import { bearerAuth } from "../auth/middleware.js";
import type { Database } from "../db/client.js";
import { agentBlocks, agentCards, agents, apiKeys, auditLog } from "../db/schema.js";
import { RelayError } from "../errors.js";
import type { MailboxSignalHub } from "../events/mailbox-signal.js";
import { encryptWebhook } from "../notifications/crypto.js";
import { isSlackWebhookUrl } from "../notifications/slack.js";
import { lockAgentBlockPair } from "../services/agent-block-lock.js";
import { writeAudit } from "../services/audit.js";
import { listMailboxEvents } from "../services/mailbox-events.js";
import { lockAgentLifecycle } from "../services/node-enrollment.js";
import type { AppEnv } from "../types.js";
import { registerMailboxEventStream } from "./mailbox-events-stream.js";
import { registerMissionOwnerRoutes } from "./mission-owner.js";
import { registerNodeOwnerRoutes } from "./node-owner.js";

const updateCardSchema = z
	.object({
		skills: z.array(z.string().min(1).max(60)).max(50).optional(),
		repos_owned: z.array(z.string().min(1).max(200)).max(100).optional(),
		role: z.string().min(1).max(60).optional(),
		notification_webhook_url: z
			.string()
			.url()
			.refine(isSlackWebhookUrl, "expected an https://hooks.slack.com/services/... webhook URL")
			.nullable()
			.optional(),
	})
	.strict();

const MAX_POSTGRES_BIGINT = "9223372036854775807";
const mailboxEventsQuerySchema = z.object({
	after_cursor: z
		.string()
		.regex(/^[1-9][0-9]*$/)
		.max(19)
		.refine(
			(cursor) => cursor.length < MAX_POSTGRES_BIGINT.length || cursor <= MAX_POSTGRES_BIGINT,
			"Mailbox cursor exceeds Postgres bigint range",
		)
		.optional(),
	limit: z.coerce.number().int().positive().max(200).default(50),
});

export interface AgentsRoutesOptions {
	db: Database;
	pepper: string;
	encryptionKey: string;
	/** 'live' on production relays, 'test' otherwise. */
	keyEnvironment: "live" | "test";
	mailboxSignalHub?: MailboxSignalHub;
}

export function createAgentsRoutes(opts: AgentsRoutesOptions): Hono<AppEnv> {
	const router = new Hono<AppEnv>();
	router.use("*", bearerAuth({ db: opts.db, pepper: opts.pepper }));
	registerNodeOwnerRoutes(router, opts);
	registerMissionOwnerRoutes(router, opts);
	if (opts.mailboxSignalHub) {
		registerMailboxEventStream(router, { db: opts.db, hub: opts.mailboxSignalHub });
	}

	// GET /agents/me — whoami (lld §5.4 / R7)
	router.get("/me", async (c) => {
		const me = c.get("agent");
		if (!me) throw new RelayError("unauthenticated", "Auth required");
		const [row] = await opts.db
			.select({
				id: agents.id,
				handle: agents.handle,
				displayName: agents.displayName,
				email: agents.email,
				role: agents.role,
				status: agents.status,
				skills: agentCards.skills,
				reposOwned: agentCards.reposOwned,
			})
			.from(agents)
			.leftJoin(agentCards, eq(agentCards.agentId, agents.id))
			.where(eq(agents.id, me.id));
		if (!row) throw new RelayError("internal", "agent vanished");
		return c.json({
			id: row.id,
			handle: row.handle,
			name: row.displayName,
			email: row.email,
			role: row.role,
			status: row.status,
			skills: row.skills ?? [],
			repos_owned: row.reposOwned ?? [],
		});
	});

	router.get("/me/mailbox/events", async (c) => {
		const me = c.get("agent");
		if (!me) throw new RelayError("unauthenticated", "Auth required");
		const parsed = mailboxEventsQuerySchema.safeParse({
			after_cursor: c.req.query("after_cursor"),
			limit: c.req.query("limit"),
		});
		if (!parsed.success) {
			throw new RelayError("invalid_params", "Invalid mailbox event query", {
				issues: parsed.error.issues,
			});
		}
		return c.json(
			await listMailboxEvents(opts.db, {
				recipientAgentId: me.id,
				afterCursor:
					parsed.data.after_cursor === undefined ? null : BigInt(parsed.data.after_cursor),
				limit: parsed.data.limit,
			}),
		);
	});

	// POST /agents/me/keys/rotate — self-rotate using current key (lld §5.3 / R7)
	router.post("/me/keys/rotate", async (c) => {
		const me = c.get("agent");
		if (!me) throw new RelayError("unauthenticated", "Auth required");
		const generated = generateKey(opts.keyEnvironment, opts.pepper);
		const newKey = await opts.db.transaction(async (tx) => {
			await lockAgentLifecycle(tx, me.id);
			const [activeAgent] = await tx
				.select({ id: agents.id })
				.from(agents)
				.where(and(eq(agents.id, me.id), eq(agents.status, "active")))
				.limit(1);
			if (!activeAgent) {
				throw new RelayError("unauthenticated", "Only an active agent can rotate API keys");
			}
			// revoke ALL of caller's currently-active keys (including the one used to call us)
			await tx.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.agentId, me.id));
			const [created] = await tx
				.insert(apiKeys)
				.values({
					agentId: me.id,
					keyHash: generated.hash,
					salt: generated.salt,
					label: "self-rotated",
				})
				.returning();
			if (!created) throw new RelayError("internal", "Failed to issue rotated key");
			return created;
		});
		return c.json({
			agent_id: me.id,
			api_key: generated.raw,
			key_id: newKey.id,
		});
	});

	// GET /agents/me/audit — self-audit log query (lld §5.5 / R7)
	router.get("/me/audit", async (c) => {
		const me = c.get("agent");
		if (!me) throw new RelayError("unauthenticated", "Auth required");

		const querySchema = z.object({
			since: z.string().datetime().optional(),
			from: z.string().min(1).max(120).optional(),
			action: z.string().min(1).max(120).optional(),
			limit: z.coerce.number().int().positive().max(1000).default(100),
		});
		const parsed = querySchema.safeParse({
			since: c.req.query("since"),
			from: c.req.query("from"),
			action: c.req.query("action"),
			limit: c.req.query("limit"),
		});
		if (!parsed.success) {
			throw new RelayError("invalid_params", "Invalid audit query", {
				issues: parsed.error.issues,
			});
		}
		const q = parsed.data;

		const conds = [eq(auditLog.actorId, me.id)];
		if (q.since) conds.push(gte(auditLog.createdAt, new Date(q.since)));
		if (q.action) conds.push(eq(auditLog.action, q.action));

		// `from` filter: lld §5.5 frames it as the sender side ("audit --from bob@acme")
		// — i.e. show actions where the actor is `bob`. Since this endpoint is scoped
		// to actor_id = caller, `from` only matches when from === caller.handle. Keep
		// the filter for forward-compat with future server-side join modes; today it
		// just degenerates to "no rows" if `from` mismatches caller's handle.
		if (q.from && q.from !== me.handle) {
			return c.json({ events: [] });
		}

		const rows = await opts.db
			.select({
				id: auditLog.id,
				action: auditLog.action,
				resourceType: auditLog.resourceType,
				resourceId: auditLog.resourceId,
				metadata: auditLog.metadata,
				requestId: auditLog.requestId,
				createdAt: auditLog.createdAt,
				actorHandle: agents.handle,
			})
			.from(auditLog)
			.innerJoin(agents, eq(agents.id, auditLog.actorId))
			.where(and(...conds))
			.orderBy(desc(auditLog.createdAt))
			.limit(q.limit);

		return c.json({
			events: rows.map((r) => ({
				timestamp: r.createdAt.toISOString(),
				actor_handle: r.actorHandle,
				action: r.action,
				resource_type: r.resourceType,
				resource_id: r.resourceId,
				request_id: r.requestId,
				metadata: r.metadata,
			})),
		});
	});

	// GET /agents — public roster (lld §3.2)
	router.get("/", async (c) => {
		const rows = await opts.db
			.select({
				handle: agents.handle,
				displayName: agents.displayName,
				role: agents.role,
				status: agents.status,
				skills: agentCards.skills,
				reposOwned: agentCards.reposOwned,
			})
			.from(agents)
			.leftJoin(agentCards, eq(agentCards.agentId, agents.id))
			.where(eq(agents.status, "active"));

		return c.json({
			teammates: rows.map((r) => ({
				handle: r.handle,
				name: r.displayName,
				role: r.role,
				skills: r.skills ?? [],
				repos_owned: r.reposOwned ?? [],
			})),
		});
	});

	// PUT /agents/me/card — self-update card (lld §3.2)
	router.put("/me/card", async (c) => {
		const agent = c.get("agent");
		if (!agent) throw new RelayError("unauthenticated", "Auth required");

		const body = await c.req.json().catch(() => null);
		const parsed = updateCardSchema.safeParse(body);
		if (!parsed.success) {
			throw new RelayError("invalid_params", "Invalid card payload", {
				issues: parsed.error.issues,
			});
		}
		const input = parsed.data;
		const encryptedWebhook =
			input.notification_webhook_url === undefined
				? undefined
				: input.notification_webhook_url === null
					? null
					: encryptWebhook(input.notification_webhook_url, opts.encryptionKey);

		if (input.role !== undefined) {
			await opts.db.update(agents).set({ role: input.role }).where(eq(agents.id, agent.id));
		}

		const hasCardUpdate =
			input.skills !== undefined ||
			input.repos_owned !== undefined ||
			encryptedWebhook !== undefined;
		if (hasCardUpdate) {
			await opts.db
				.insert(agentCards)
				.values({
					agentId: agent.id,
					card: { id: agent.handle, name: agent.handle },
					skills: input.skills ?? [],
					reposOwned: input.repos_owned ?? [],
					notificationWebhookUrl: encryptedWebhook ?? null,
				})
				.onConflictDoUpdate({
					target: agentCards.agentId,
					set: {
						...(input.skills !== undefined ? { skills: input.skills } : {}),
						...(input.repos_owned !== undefined ? { reposOwned: input.repos_owned } : {}),
						...(encryptedWebhook !== undefined ? { notificationWebhookUrl: encryptedWebhook } : {}),
					},
				});
		}

		return c.json({ ok: true });
	});

	// ─── Block list (lld §5.6 / R6) ───────────────────────────────────────────

	const blockBodySchema = z
		.object({
			handle: z.string().min(1).max(120),
			reason: z.string().max(500).optional(),
		})
		.strict();

	// GET /agents/me/block — list caller's blocked teammates
	router.get("/me/block", async (c) => {
		const me = c.get("agent");
		if (!me) throw new RelayError("unauthenticated", "Auth required");
		const rows = await opts.db
			.select({
				handle: agents.handle,
				name: agents.displayName,
				role: agents.role,
				createdAt: agentBlocks.createdAt,
			})
			.from(agentBlocks)
			.innerJoin(agents, eq(agents.id, agentBlocks.blockedId))
			.where(eq(agentBlocks.blockerId, me.id));
		return c.json({
			blocked: rows.map((r) => ({
				handle: r.handle,
				name: r.name,
				role: r.role,
				blocked_at: r.createdAt.toISOString(),
			})),
		});
	});

	// POST /agents/me/block — block a teammate by handle
	router.post("/me/block", async (c) => {
		const me = c.get("agent");
		if (!me) throw new RelayError("unauthenticated", "Auth required");
		const body = await c.req.json().catch(() => null);
		const parsed = blockBodySchema.safeParse(body);
		if (!parsed.success) {
			throw new RelayError("invalid_params", "Invalid block payload", {
				issues: parsed.error.issues,
			});
		}
		const target = parsed.data.handle;
		if (target === me.handle) {
			throw new RelayError("invalid_params", "Cannot block yourself");
		}
		const [other] = await opts.db
			.select({ id: agents.id })
			.from(agents)
			.where(eq(agents.handle, target));
		if (!other) {
			throw new RelayError("recipient_not_found", `No agent with handle '${target}'`);
		}
		await opts.db.transaction(async (tx) => {
			await lockAgentBlockPair(tx, me.id, other.id);
			const inserted = await tx
				.insert(agentBlocks)
				.values({ blockerId: me.id, blockedId: other.id })
				.onConflictDoNothing()
				.returning({ blockedId: agentBlocks.blockedId });
			if (inserted.length > 0) {
				await writeAudit(tx, {
					actorId: me.id,
					action: "agent.block",
					resourceType: "agent",
					resourceId: other.id,
					metadata: { handle: target, reason: parsed.data.reason ?? null },
					requestId: c.get("requestId"),
				});
			}
		});
		return c.json({ ok: true, blocked_handle: target }, 201);
	});

	// DELETE /agents/me/block/:handle — unblock by handle
	router.delete("/me/block/:handle", async (c) => {
		const me = c.get("agent");
		if (!me) throw new RelayError("unauthenticated", "Auth required");
		const target = c.req.param("handle");
		if (!target) throw new RelayError("invalid_params", "handle required");
		const [other] = await opts.db
			.select({ id: agents.id })
			.from(agents)
			.where(eq(agents.handle, target));
		if (!other) {
			// Be lenient: idempotent unblock should still 204 if the agent vanished.
			return c.body(null, 204);
		}
		await opts.db.transaction(async (tx) => {
			await lockAgentBlockPair(tx, me.id, other.id);
			const deleted = await tx
				.delete(agentBlocks)
				.where(and(eq(agentBlocks.blockerId, me.id), eq(agentBlocks.blockedId, other.id)))
				.returning({ blockedId: agentBlocks.blockedId });
			if (deleted.length > 0) {
				await writeAudit(tx, {
					actorId: me.id,
					action: "agent.unblock",
					resourceType: "agent",
					resourceId: other.id,
					metadata: { handle: target },
					requestId: c.get("requestId"),
				});
			}
		});
		return c.body(null, 204);
	});

	return router;
}
