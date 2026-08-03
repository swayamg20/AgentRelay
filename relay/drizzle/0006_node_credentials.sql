-- Drizzle reads its journal before opening the migration transaction. Serialize
-- concurrent relay startup so two runners can safely observe this file as pending.
SELECT pg_advisory_xact_lock(
  hashtextextended('agentrelay:migration:0006_node_credentials', 0)
);
--> statement-breakpoint
-- `now()` is fixed at transaction start and can regress updated_at after a
-- concurrent write. Use wall-clock time when each update trigger actually runs.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "node_credentials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "node_id" uuid NOT NULL REFERENCES "nodes"("id") ON DELETE restrict,
  "key_hash" bytea NOT NULL,
  "salt" bytea NOT NULL,
  "label" text,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_node_credentials_active_node";
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_node_credentials_active_node"
  ON "node_credentials" ("node_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_node_credentials_active_hash"
  ON "node_credentials" ("key_hash") WHERE "revoked_at" IS NULL;
