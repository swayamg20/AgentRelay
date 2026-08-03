-- Drizzle reads its journal before opening the migration transaction. Serialize
-- concurrent relay startup so two runners can safely observe this file as pending.
SELECT pg_advisory_xact_lock(
  hashtextextended('agentrelay:migration:0008_audit_actor_kind', 0)
);
--> statement-breakpoint
ALTER TABLE "audit_log"
  ADD COLUMN IF NOT EXISTS "actor_kind" text;
--> statement-breakpoint
-- Every pre-0008 audit row was written by an authenticated Agent.
UPDATE "audit_log"
SET "actor_kind" = 'agent'
WHERE "actor_kind" IS NULL;
--> statement-breakpoint
ALTER TABLE "audit_log"
  ALTER COLUMN "actor_kind" SET DEFAULT 'agent',
  ALTER COLUMN "actor_kind" SET NOT NULL,
  ALTER COLUMN "actor_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit_log"
  DROP CONSTRAINT IF EXISTS "audit_log_actor_kind_chk",
  DROP CONSTRAINT IF EXISTS "audit_log_actor_identity_chk";
--> statement-breakpoint
ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_actor_kind_chk" CHECK (
    "actor_kind" IN ('agent','admin','system')
  ),
  ADD CONSTRAINT "audit_log_actor_identity_chk" CHECK (
    ("actor_kind" = 'agent' AND "actor_id" IS NOT NULL)
    OR ("actor_kind" IN ('admin','system') AND "actor_id" IS NULL)
  );
