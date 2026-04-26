-- Block list (lld §5.6 / §3.5 -32013). `agentrelay block <handle>` mirrors
-- a row here so message/send can reject early. Mirror, not source of truth —
-- the receiver's local trust.yaml is authoritative; this is the relay-side
-- fast path.
CREATE TABLE IF NOT EXISTS "agent_blocks" (
  "blocker_id" uuid NOT NULL,
  "blocked_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("blocker_id", "blocked_id"),
  CONSTRAINT "agent_blocks_self" CHECK ("blocker_id" != "blocked_id")
);
--> statement-breakpoint
ALTER TABLE "agent_blocks"
  ADD CONSTRAINT "agent_blocks_blocker_id_agents_id_fk"
  FOREIGN KEY ("blocker_id") REFERENCES "public"."agents"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "agent_blocks"
  ADD CONSTRAINT "agent_blocks_blocked_id_agents_id_fk"
  FOREIGN KEY ("blocked_id") REFERENCES "public"."agents"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_blocks_blocked" ON "agent_blocks" ("blocked_id");
