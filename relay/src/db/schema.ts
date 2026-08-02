import { sql } from "drizzle-orm";
import {
	bigserial,
	check,
	customType,
	foreignKey,
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
		completionArtifacts: jsonb("completion_artifacts").notNull().default(sql`'[]'::jsonb`),
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
		artifacts: jsonb("artifacts").notNull().default(sql`'[]'::jsonb`),
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
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
	},
	(t) => ({
		uniqTokenHash: uniqueIndex("uniq_invites_token_hash").on(t.tokenHash),
		idxExpiresAt: index("idx_invites_expires_at").on(t.expiresAt).where(sql`${t.usedAt} IS NULL`),
	}),
);

// ─── Durable Mission ledger ─────────────────────────────────────────────────

export const nodes = pgTable(
	"nodes",
	{
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		agentId: uuid("agent_id")
			.notNull()
			.references(() => agents.id, { onDelete: "restrict" }),
		name: text("name").notNull(),
		status: text("status").notNull().default("active"),
		capabilities: jsonb("capabilities").notNull().default(sql`'[]'::jsonb`),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		createdAt,
		updatedAt,
	},
	(t) => ({
		agentIdx: index("idx_nodes_agent").on(t.agentId),
		identityOwnerIdx: uniqueIndex("idx_nodes_identity_owner").on(t.id, t.agentId),
		activeNameIdx: uniqueIndex("idx_nodes_active_name")
			.on(t.agentId, t.name)
			.where(sql`${t.status} = 'active'`),
		statusCheck: check("nodes_status_chk", sql`${t.status} IN ('active','revoked')`),
		revokedAtCheck: check(
			"nodes_revoked_at_chk",
			sql`(${t.status} = 'revoked') = (${t.revokedAt} IS NOT NULL)`,
		),
	}),
);

export const workspaceBindings = pgTable(
	"workspace_bindings",
	{
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		nodeId: uuid("node_id")
			.notNull()
			.references(() => nodes.id, { onDelete: "restrict" }),
		alias: text("alias").notNull(),
		repositoryUrl: text("repository_url").notNull(),
		allowedBaseRefs: textArray("allowed_base_refs").notNull().default(sql`'{}'::text[]`),
		status: text("status").notNull().default("active"),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		createdAt,
		updatedAt,
	},
	(t) => ({
		nodeIdx: index("idx_workspace_bindings_node").on(t.nodeId),
		identityNodeIdx: uniqueIndex("idx_workspace_bindings_identity_node").on(t.id, t.nodeId),
		activeAliasIdx: uniqueIndex("idx_workspace_bindings_active_alias")
			.on(t.nodeId, t.alias)
			.where(sql`${t.status} = 'active'`),
		statusCheck: check("workspace_bindings_status_chk", sql`${t.status} IN ('active','revoked')`),
		revokedAtCheck: check(
			"workspace_bindings_revoked_at_chk",
			sql`(${t.status} = 'revoked') = (${t.revokedAt} IS NOT NULL)`,
		),
	}),
);

export const missions = pgTable(
	"missions",
	{
		id: uuid("id").primaryKey(),
		createdByAgentId: uuid("created_by_agent_id")
			.notNull()
			.references(() => agents.id, { onDelete: "restrict" }),
		coordinatorConfig: jsonb("coordinator_config").notNull(),
		state: jsonb("state").notNull(),
		status: text("status").notNull().default("awaiting_acceptance"),
		lastEventSequence: integer("last_event_sequence").notNull().default(0),
		contractVersion: integer("contract_version").notNull().default(1),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt,
		updatedAt,
	},
	(t) => ({
		creatorIdx: index("idx_missions_creator").on(t.createdByAgentId, t.createdAt.desc()),
		statusIdx: index("idx_missions_status").on(t.status, t.updatedAt.desc()),
		statusCheck: check(
			"missions_status_chk",
			sql`${t.status} IN ('awaiting_acceptance','active','verifying','blocked','completed','cancelled','expired','failed')`,
		),
		sequenceCheck: check("missions_sequence_chk", sql`${t.lastEventSequence} >= 0`),
		contractVersionCheck: check("missions_contract_version_chk", sql`${t.contractVersion} > 0`),
	}),
);

export const missionParticipants = pgTable(
	"mission_participants",
	{
		missionId: uuid("mission_id")
			.notNull()
			.references(() => missions.id, { onDelete: "restrict" }),
		agentId: uuid("agent_id")
			.notNull()
			.references(() => agents.id, { onDelete: "restrict" }),
		nodeId: uuid("node_id")
			.notNull()
			.references(() => nodes.id, { onDelete: "restrict" }),
		workspaceBindingId: uuid("workspace_binding_id")
			.notNull()
			.references(() => workspaceBindings.id, { onDelete: "restrict" }),
		role: text("role").notNull(),
		status: text("status").notNull().default("pending"),
		acceptedAt: timestamp("accepted_at", { withTimezone: true }),
		acceptanceIdempotencyKey: text("acceptance_idempotency_key"),
		acceptanceReceipt: jsonb("acceptance_receipt"),
		createdAt,
	},
	(t) => ({
		pk: primaryKey({ columns: [t.missionId, t.agentId] }),
		nodeIdx: index("idx_mission_participants_node").on(t.nodeId, t.missionId),
		missionNodeIdx: uniqueIndex("idx_mission_participants_mission_node").on(t.missionId, t.nodeId),
		acceptanceIdempotencyIdx: uniqueIndex("idx_mission_participants_acceptance_idempotency")
			.on(t.missionId, t.acceptanceIdempotencyKey)
			.where(sql`${t.acceptanceIdempotencyKey} IS NOT NULL`),
		nodeOwnerFk: foreignKey({
			columns: [t.nodeId, t.agentId],
			foreignColumns: [nodes.id, nodes.agentId],
			name: "mission_participants_node_owner_fk",
		}),
		bindingNodeFk: foreignKey({
			columns: [t.workspaceBindingId, t.nodeId],
			foreignColumns: [workspaceBindings.id, workspaceBindings.nodeId],
			name: "mission_participants_binding_node_fk",
		}),
		statusCheck: check(
			"mission_participants_status_chk",
			sql`${t.status} IN ('pending','accepted')`,
		),
		acceptedAtCheck: check(
			"mission_participants_accepted_at_chk",
			sql`(${t.status} = 'accepted') = (${t.acceptedAt} IS NOT NULL)
				AND (${t.status} = 'accepted') = (${t.acceptanceIdempotencyKey} IS NOT NULL)
				AND (${t.status} = 'accepted') = (${t.acceptanceReceipt} IS NOT NULL)`,
		),
	}),
);

export const missionEvents = pgTable(
	"mission_events",
	{
		id: uuid("id").primaryKey(),
		missionId: uuid("mission_id")
			.notNull()
			.references(() => missions.id, { onDelete: "restrict" }),
		sequenceNo: integer("sequence_no").notNull(),
		type: text("type").notNull(),
		actorAgentId: uuid("actor_agent_id")
			.notNull()
			.references(() => agents.id, { onDelete: "restrict" }),
		idempotencyKey: text("idempotency_key").notNull(),
		sourceDeliveryId: uuid("source_delivery_id"),
		causalParentEventId: uuid("causal_parent_event_id"),
		payload: jsonb("payload").notNull(),
		createdAt,
	},
	(t) => ({
		missionSequenceIdx: uniqueIndex("idx_mission_events_sequence").on(t.missionId, t.sequenceNo),
		idempotencyIdx: uniqueIndex("idx_mission_events_idempotency").on(t.missionId, t.idempotencyKey),
		missionIdentityIdx: uniqueIndex("idx_mission_events_mission_identity").on(t.missionId, t.id),
		missionCreatedIdx: index("idx_mission_events_created").on(t.missionId, t.createdAt),
		causalParentFk: foreignKey({
			columns: [t.missionId, t.causalParentEventId],
			foreignColumns: [t.missionId, t.id],
			name: "mission_events_causal_parent_fk",
		}),
		actorParticipantFk: foreignKey({
			columns: [t.missionId, t.actorAgentId],
			foreignColumns: [missionParticipants.missionId, missionParticipants.agentId],
			name: "mission_events_actor_participant_fk",
		}),
		typeCheck: check(
			"mission_events_type_chk",
			sql`${t.type} IN ('participants_accepted','turn_completed','contract_acknowledged','verification_recorded')`,
		),
		sequenceCheck: check("mission_events_sequence_chk", sql`${t.sequenceNo} > 0`),
	}),
);

export const nodeDeliveries = pgTable(
	"node_deliveries",
	{
		id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
		nodeId: uuid("node_id")
			.notNull()
			.references(() => nodes.id, { onDelete: "restrict" }),
		missionId: uuid("mission_id")
			.notNull()
			.references(() => missions.id, { onDelete: "restrict" }),
		missionEventId: uuid("mission_event_id")
			.notNull()
			.references(() => missionEvents.id, { onDelete: "restrict" }),
		kind: text("kind").notNull(),
		cursor: bigserial("cursor", { mode: "bigint" }).notNull(),
		status: text("status").notNull().default("stored"),
		attemptCount: integer("attempt_count").notNull().default(0),
		maxAttempts: integer("max_attempts").notNull().default(5),
		lastFencingToken: text("last_fencing_token").notNull().default("0"),
		activeLeaseId: uuid("active_lease_id"),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		contractVersion: integer("contract_version").notNull(),
		verificationRound: integer("verification_round"),
		idempotencyKey: text("idempotency_key").notNull(),
		causalParentDeliveryId: uuid("causal_parent_delivery_id"),
		settledByEventId: uuid("settled_by_event_id"),
		settledAt: timestamp("settled_at", { withTimezone: true }),
		availableAt: timestamp("available_at", { withTimezone: true }).notNull().default(sql`now()`),
		acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
		deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
		createdAt,
		updatedAt,
	},
	(t) => ({
		cursorIdx: uniqueIndex("idx_node_deliveries_cursor").on(t.cursor),
		nodeCursorIdx: index("idx_node_deliveries_node_cursor").on(t.nodeId, t.cursor),
		identityScopeIdx: uniqueIndex("idx_node_deliveries_identity_scope").on(
			t.nodeId,
			t.missionId,
			t.id,
		),
		missionIdentityIdx: uniqueIndex("idx_node_deliveries_mission_identity").on(t.missionId, t.id),
		eventKindIdx: uniqueIndex("idx_node_deliveries_event_kind").on(
			t.nodeId,
			t.missionEventId,
			t.kind,
		),
		idempotencyIdx: uniqueIndex("idx_node_deliveries_idempotency").on(t.nodeId, t.idempotencyKey),
		causalParentFk: foreignKey({
			columns: [t.nodeId, t.missionId, t.causalParentDeliveryId],
			foreignColumns: [t.nodeId, t.missionId, t.id],
			name: "node_deliveries_causal_parent_fk",
		}),
		eventMissionFk: foreignKey({
			columns: [t.missionId, t.missionEventId],
			foreignColumns: [missionEvents.missionId, missionEvents.id],
			name: "node_deliveries_event_mission_fk",
		}),
		participantNodeFk: foreignKey({
			columns: [t.missionId, t.nodeId],
			foreignColumns: [missionParticipants.missionId, missionParticipants.nodeId],
			name: "node_deliveries_participant_node_fk",
		}),
		settlementEventMissionFk: foreignKey({
			columns: [t.missionId, t.settledByEventId],
			foreignColumns: [missionEvents.missionId, missionEvents.id],
			name: "node_deliveries_settlement_event_mission_fk",
		}),
		kindCheck: check(
			"node_deliveries_kind_chk",
			sql`${t.kind} IN ('turn','verification','contract_acknowledgement')`,
		),
		statusCheck: check(
			"node_deliveries_status_chk",
			sql`${t.status} IN ('stored','leased','executing','acknowledged','dead_lettered')`,
		),
		verificationRoundCheck: check(
			"node_deliveries_verification_round_chk",
			sql`(${t.kind} = 'verification') = (${t.verificationRound} IS NOT NULL)
				AND (${t.verificationRound} IS NULL OR ${t.verificationRound} > 0)`,
		),
		attemptCheck: check(
			"node_deliveries_attempt_chk",
			sql`${t.attemptCount} >= 0 AND ${t.maxAttempts} > 0 AND ${t.attemptCount} <= ${t.maxAttempts}`,
		),
		fencingTokenCheck: check(
			"node_deliveries_fencing_token_chk",
			sql`${t.lastFencingToken} ~ '^(0|[1-9][0-9]*)$'`,
		),
		initialFenceCheck: check(
			"node_deliveries_initial_fence_chk",
			sql`(${t.attemptCount} = 0) = (${t.lastFencingToken} = '0')`,
		),
		leaseCheck: check(
			"node_deliveries_lease_chk",
			sql`(${t.status} IN ('leased','executing')) = (${t.activeLeaseId} IS NOT NULL)
				AND (${t.status} IN ('leased','executing')) = (${t.leaseExpiresAt} IS NOT NULL)
				AND (${t.status} NOT IN ('leased','executing') OR ${t.attemptCount} > 0)`,
		),
		acknowledgedAtCheck: check(
			"node_deliveries_acknowledged_at_chk",
			sql`(${t.status} = 'acknowledged') = (${t.acknowledgedAt} IS NOT NULL)
				AND (${t.status} != 'acknowledged' OR ${t.attemptCount} > 0)`,
		),
		deadLetteredAtCheck: check(
			"node_deliveries_dead_lettered_at_chk",
			sql`(${t.status} = 'dead_lettered') = (${t.deadLetteredAt} IS NOT NULL)`,
		),
		settlementCheck: check(
			"node_deliveries_settlement_chk",
			sql`(${t.settledByEventId} IS NOT NULL) = (${t.settledAt} IS NOT NULL)`,
		),
	}),
);

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type AgentCard = typeof agentCards.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type Handoff = typeof handoffs.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type Node = typeof nodes.$inferSelect;
export type WorkspaceBinding = typeof workspaceBindings.$inferSelect;
export type Mission = typeof missions.$inferSelect;
export type MissionParticipant = typeof missionParticipants.$inferSelect;
export type MissionEvent = typeof missionEvents.$inferSelect;
export type NodeDelivery = typeof nodeDeliveries.$inferSelect;
