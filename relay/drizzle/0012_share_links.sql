SELECT pg_advisory_xact_lock(
  hashtextextended('agentrelay:migration:0012_share_links', 0)
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "company_domain" text;
--> statement-breakpoint
ALTER TABLE "invites" ADD COLUMN IF NOT EXISTS "company_domain" text;
--> statement-breakpoint
ALTER TABLE "audit_log"
  DROP CONSTRAINT IF EXISTS "audit_log_actor_kind_chk",
  DROP CONSTRAINT IF EXISTS "audit_log_actor_identity_chk";
--> statement-breakpoint
ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_actor_kind_chk" CHECK (
    "actor_kind" IN ('agent','admin','external','system')
  ),
  ADD CONSTRAINT "audit_log_actor_identity_chk" CHECK (
    ("actor_kind" = 'agent' AND "actor_id" IS NOT NULL)
    OR ("actor_kind" IN ('admin','external','system') AND "actor_id" IS NULL)
  );
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "share_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_id" text NOT NULL,
  "sender_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE restrict,
  "content" text,
  "idempotency_key" text NOT NULL,
  "expires_at" timestamp with time zone DEFAULT now() + interval '7 days' NOT NULL,
  "revoked_at" timestamp with time zone,
  "content_deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "share_links_public_id_chk" CHECK ("public_id" ~ '^[A-Za-z0-9_-]{43}$'),
  CONSTRAINT "share_links_content_size_chk" CHECK (octet_length("content") <= 65536),
  CONSTRAINT "share_links_content_state_chk" CHECK (
    ("content" IS NOT NULL AND "content_deleted_at" IS NULL)
    OR ("content" IS NULL AND "content_deleted_at" IS NOT NULL)
  ),
  CONSTRAINT "share_links_expiry_chk" CHECK (
    "expires_at" > "created_at" AND "expires_at" <= "created_at" + interval '30 days'
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_share_links_public_id" ON "share_links" ("public_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_share_links_idempotency" ON "share_links" ("sender_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_share_links_sender" ON "share_links" ("sender_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_share_links_retention" ON "share_links" ("expires_at") WHERE "content_deleted_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "share_replies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "link_id" uuid NOT NULL REFERENCES "share_links"("id") ON DELETE restrict,
  "seq" integer NOT NULL,
  "author_kind" text NOT NULL,
  "channel" text NOT NULL,
  "content" text,
  "idempotency_key" text NOT NULL,
  "released_at" timestamp with time zone,
  "released_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE restrict,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "share_replies_seq_chk" CHECK ("seq" > 0),
  CONSTRAINT "share_replies_author_kind_chk" CHECK ("author_kind" IN ('sender','external')),
  CONSTRAINT "share_replies_channel_chk" CHECK ("channel" IN ('api','form')),
  CONSTRAINT "share_replies_content_size_chk" CHECK (octet_length("content") <= 16384),
  CONSTRAINT "share_replies_release_chk" CHECK (
    ("released_at" IS NULL AND "released_by_agent_id" IS NULL)
    OR ("author_kind" = 'external' AND "released_at" IS NOT NULL AND "released_by_agent_id" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_share_replies_link_seq" ON "share_replies" ("link_id", "seq");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_share_replies_identity_link" ON "share_replies" ("id", "link_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_share_replies_idempotency" ON "share_replies" ("link_id", "author_kind", "idempotency_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "share_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "link_id" uuid NOT NULL REFERENCES "share_links"("id") ON DELETE restrict,
  "reply_id" uuid,
  "kind" text NOT NULL,
  "actor_kind" text NOT NULL,
  "actor_agent_id" uuid REFERENCES "agents"("id") ON DELETE restrict,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "share_events_reply_link_fk" FOREIGN KEY ("reply_id", "link_id") REFERENCES "share_replies"("id", "link_id") ON DELETE restrict,
  CONSTRAINT "share_events_kind_chk" CHECK (
    "kind" IN ('link.created','link.fetched','reply.posted','reply.released','answer.posted','invite.requested')
  ),
  CONSTRAINT "share_events_reply_chk" CHECK (
    ("kind" IN ('reply.posted','reply.released','answer.posted') AND "reply_id" IS NOT NULL)
    OR ("kind" IN ('link.created','link.fetched','invite.requested') AND "reply_id" IS NULL)
  ),
  CONSTRAINT "share_events_actor_chk" CHECK (
    ("actor_kind" = 'agent' AND "actor_agent_id" IS NOT NULL)
    OR ("actor_kind" IN ('admin','external','system') AND "actor_agent_id" IS NULL)
  ),
  CONSTRAINT "share_events_metadata_chk" CHECK (jsonb_typeof("metadata") = 'object')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_share_events_link" ON "share_events" ("link_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_share_events_reply_kind" ON "share_events" ("reply_id", "kind") WHERE "reply_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_share_events_link_created" ON "share_events" ("link_id") WHERE "kind" = 'link.created';
