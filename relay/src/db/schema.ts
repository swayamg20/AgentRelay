import { sql } from "drizzle-orm";
import {
	bigserial,
	check,
	customType,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

// citext for case-insensitive email uniqueness (extension enabled in 0001 migration).
const citext = customType<{ data: string }>({ dataType: () => "citext" });

// bytea for hashed API keys + per-row salts.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

// text[] arrays for repos_owned / skills (GIN-indexed below).
const textArray = customType<{ data: string[]; driverData: string }>({
	dataType: () => "text[]",
});

export const handoffStatusEnum = pgEnum("handoff_status", [
	"pending",
	"accepted",
	"completed",
	"cancelled",
]);

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`);
const updatedAt = timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`);

// ─── 2.1 agents ─────────────────────────────────────────────────────────────
export const agents = pgTable(
	"agents",
	{
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		handle: text("handle").notNull().unique(),
		email: citext("email").notNull().unique(),
		displayName: text("display_name").notNull(),
		role: text("role").notNull(),
		status: text("status").notNull().default("active"),
		createdAt,
		updatedAt,
	},
	(t) => ({
		handleIdx: index("idx_agents_handle").on(t.handle),
		statusIdx: index("idx_agents_status").on(t.status),
		statusCheck: check("agents_status_chk", sql`${t.status} IN ('active','disabled')`),
	}),
);

// ─── 2.2 agent_cards ────────────────────────────────────────────────────────
export const agentCards = pgTable(
	"agent_cards",
	{
		agentId: uuid("agent_id")
			.primaryKey()
			.references(() => agents.id, { onDelete: "restrict" }),
		card: jsonb("card").notNull(),
		reposOwned: textArray("repos_owned").notNull().default(sql`'{}'::text[]`),
		skills: textArray("skills").notNull().default(sql`'{}'::text[]`),
		notificationWebhookUrl: text("notification_webhook_url"),
		createdAt,
		updatedAt,
	},
	(t) => ({
		reposIdx: index("idx_agent_cards_repos").using("gin", t.reposOwned),
		skillsIdx: index("idx_agent_cards_skills").using("gin", t.skills),
	}),
);

// ─── 2.3 api_keys ───────────────────────────────────────────────────────────
export const apiKeys = pgTable(
	"api_keys",
	{
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		agentId: uuid("agent_id")
			.notNull()
			.references(() => agents.id, { onDelete: "restrict" }),
		keyHash: bytea("key_hash").notNull(),
		salt: bytea("salt").notNull(),
		label: text("label"),
		lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		createdAt,
	},
	(t) => ({
		agentIdx: index("idx_api_keys_agent").on(t.agentId).where(sql`revoked_at IS NULL`),
		activeHashIdx: uniqueIndex("idx_api_keys_active_hash")
			.on(t.keyHash)
			.where(sql`revoked_at IS NULL`),
	}),
);

// ─── 2.4 handoffs ───────────────────────────────────────────────────────────
export const handoffs = pgTable(
	"handoffs",
	{
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		senderId: uuid("sender_id")
			.notNull()
			.references(() => agents.id, { onDelete: "restrict" }),
		recipientId: uuid("recipient_id")
			.notNull()
			.references(() => agents.id, { onDelete: "restrict" }),
		summary: text("summary").notNull(),
		intent: text("intent").notNull().default("inform"),
		status: handoffStatusEnum("status").notNull().default("pending"),
		artifacts: jsonb("artifacts").notNull().default(sql`'[]'::jsonb`),
		proposedAction: jsonb("proposed_action"),
		metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
		acceptedBySession: text("accepted_by_session"),
		acceptedAt: timestamp("accepted_at", { withTimezone: true }),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		completedSummary: text("completed_summary"),
		cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
		idempotencyKey: text("idempotency_key").unique(),
		createdAt,
		updatedAt,
	},
	(t) => ({
		recipientStatusIdx: index("idx_handoffs_recipient_status").on(
			t.recipientId,
			t.status,
			t.createdAt.desc(),
		),
		senderIdx: index("idx_handoffs_sender").on(t.senderId, t.createdAt.desc()),
		senderNotRecipient: check(
			"handoffs_sender_not_recipient",
			sql`${t.senderId} != ${t.recipientId}`,
		),
		intentValid: check(
			"handoffs_intent_valid",
			sql`${t.intent} IN ('inform','ask_question','propose_action')`,
		),
		proposedActionInvariant: check(
			"handoffs_proposed_action_invariant",
			sql`(${t.intent} = 'propose_action') = (${t.proposedAction} IS NOT NULL)`,
		),
	}),
);

// ─── 2.5 messages ───────────────────────────────────────────────────────────
export const messages = pgTable(
	"messages",
	{
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		handoffId: uuid("handoff_id")
			.notNull()
			.references(() => handoffs.id, { onDelete: "restrict" }),
		authorId: uuid("author_id")
			.notNull()
			.references(() => agents.id, { onDelete: "restrict" }),
		body: text("body").notNull(),
		payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
		sequenceNo: integer("sequence_no").notNull(),
		idempotencyKey: text("idempotency_key").unique(),
		createdAt,
	},
	(t) => ({
		seqIdx: uniqueIndex("idx_messages_seq").on(t.handoffId, t.sequenceNo),
		handoffIdx: index("idx_messages_handoff").on(t.handoffId, t.createdAt),
	}),
);

// ─── 2.6 audit_log ──────────────────────────────────────────────────────────
export const auditLog = pgTable(
	"audit_log",
	{
		id: bigserial("id", { mode: "bigint" }).primaryKey(),
		actorId: uuid("actor_id")
			.notNull()
			.references(() => agents.id, { onDelete: "restrict" }),
		action: text("action").notNull(),
		resourceType: text("resource_type").notNull(),
		resourceId: uuid("resource_id").notNull(),
		metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
		requestId: text("request_id"),
		createdAt,
	},
	(t) => ({
		resourceIdx: index("idx_audit_resource").on(t.resourceType, t.resourceId, t.createdAt.desc()),
		actorIdx: index("idx_audit_actor").on(t.actorId, t.createdAt.desc()),
	}),
);

// ─── agent_blocks (relay-side mirror of receiver block lists, §5.6) ─────────
export const agentBlocks = pgTable(
	"agent_blocks",
	{
		blockerId: uuid("blocker_id")
			.notNull()
			.references(() => agents.id, { onDelete: "restrict" }),
		blockedId: uuid("blocked_id")
			.notNull()
			.references(() => agents.id, { onDelete: "restrict" }),
		createdAt,
	},
	(t) => ({
		pk: primaryKey({ columns: [t.blockerId, t.blockedId] }),
		blockedIdx: index("idx_agent_blocks_blocked").on(t.blockedId),
		notSelf: check("agent_blocks_self", sql`${t.blockerId} != ${t.blockedId}`),
	}),
);

export const invites = pgTable(
	"invites",
	{
		jti: uuid("jti").primaryKey(),
		tokenHash: text("token_hash").notNull(),
		handle: text("handle").notNull(),
		role: text("role").notNull(),
		inviterId: uuid("inviter_id")
			.notNull()
			.references(() => agents.id, { onDelete: "restrict" }),
		expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
		usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
		usedByAgentId: uuid("used_by_agent_id").references(() => agents.id, {
			onDelete: "set null",
		}),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.notNull()
			.defaultNow(),
	},
	(t) => ({
		uniqTokenHash: uniqueIndex("uniq_invites_token_hash").on(t.tokenHash),
		idxExpiresAt: index("idx_invites_expires_at")
			.on(t.expiresAt)
			.where(sql`${t.usedAt} IS NULL`),
	}),
);

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type AgentCard = typeof agentCards.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Handoff = typeof handoffs.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
