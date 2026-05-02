-- Single-use signed invite tokens (lld §future / issue #6). The token
-- itself is HMAC-signed and self-describing (handle, role, exp baked in
-- and tamper-evident); this table exists to enforce one-shot semantics
-- (mark used_at atomically with agent creation) and to rate-limit.
CREATE TABLE IF NOT EXISTS "invites" (
  "jti" uuid PRIMARY KEY,
  "token_hash" text NOT NULL,            -- sha256(raw_token) hex; never store the raw token
  "handle" text NOT NULL,
  "role" text NOT NULL,
  "inviter_id" uuid NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "used_by_agent_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invites"
  ADD CONSTRAINT "invites_inviter_id_agents_id_fk"
  FOREIGN KEY ("inviter_id") REFERENCES "public"."agents"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "invites"
  ADD CONSTRAINT "invites_used_by_agent_id_agents_id_fk"
  FOREIGN KEY ("used_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_invites_token_hash" ON "invites" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_invites_expires_at" ON "invites" ("expires_at") WHERE "used_at" IS NULL;
