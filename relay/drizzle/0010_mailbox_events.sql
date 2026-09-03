-- Serialize concurrent relay startup before adding the mailbox event ledger.
SELECT pg_advisory_xact_lock(
  hashtextextended('agentrelay:migration:0010_mailbox_events', 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mailbox_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "cursor" bigserial NOT NULL,
  "recipient_agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE restrict,
  "actor_agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE restrict,
  "thread_id" uuid NOT NULL REFERENCES "handoffs"("id") ON DELETE restrict,
  "kind" text NOT NULL,
  "source_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mailbox_events_recipient_not_actor_chk" CHECK (
    "recipient_agent_id" != "actor_agent_id"
  ),
  CONSTRAINT "mailbox_events_kind_chk" CHECK (
    "kind" IN (
      'thread.created','message.appended','thread.accepted',
      'thread.completed','thread.cancelled'
    )
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_mailbox_events_cursor"
  ON "mailbox_events" ("cursor");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mailbox_events_recipient_cursor"
  ON "mailbox_events" ("recipient_agent_id", "cursor");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_mailbox_events_recipient_kind_source"
  ON "mailbox_events" ("recipient_agent_id", "kind", "source_id");
