-- Serialize concurrent startup before changing the Mission event actor contract.
SELECT pg_advisory_xact_lock(
  hashtextextended('agentrelay:migration:0009_mission_terminal_reconciliation', 0)
);
--> statement-breakpoint
ALTER TABLE "mission_events"
  ADD COLUMN IF NOT EXISTS "actor_kind" text NOT NULL DEFAULT 'agent';
--> statement-breakpoint
ALTER TABLE "mission_events"
  ALTER COLUMN "actor_agent_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "mission_events"
  DROP CONSTRAINT IF EXISTS "mission_events_actor_kind_chk",
  DROP CONSTRAINT IF EXISTS "mission_events_actor_identity_chk",
  DROP CONSTRAINT IF EXISTS "mission_events_actor_event_chk",
  DROP CONSTRAINT IF EXISTS "mission_events_type_chk";
--> statement-breakpoint
ALTER TABLE "mission_events"
  ADD CONSTRAINT "mission_events_actor_kind_chk" CHECK (
    "actor_kind" IN ('agent','system')
  ) NOT VALID,
  ADD CONSTRAINT "mission_events_actor_identity_chk" CHECK (
    ("actor_kind" = 'agent' AND "actor_agent_id" IS NOT NULL)
    OR ("actor_kind" = 'system' AND "actor_agent_id" IS NULL)
  ) NOT VALID,
  ADD CONSTRAINT "mission_events_actor_event_chk" CHECK (
    ("type" = 'mission_terminal' AND "actor_kind" = 'system')
    OR ("type" != 'mission_terminal' AND "actor_kind" = 'agent')
  ) NOT VALID,
  ADD CONSTRAINT "mission_events_type_chk" CHECK (
    "type" IN (
      'participants_accepted','turn_completed','contract_acknowledged',
      'verification_recorded','mission_terminal'
    )
  ) NOT VALID;

-- Drizzle runs every pending migration in one transaction. Keeping these checks
-- NOT VALID avoids scanning the append-only event ledger while that transaction
-- retains ALTER TABLE's lock. PostgreSQL still enforces each check for all new or
-- updated rows; a later maintenance migration may validate historical rows online.
