-- Keep concurrent relay startup migrations from applying this file twice.
SELECT pg_advisory_xact_lock(
  hashtextextended('agentrelay:migration:0007_delivery_claims', 0)
);
--> statement-breakpoint
ALTER TABLE "node_deliveries"
  ADD COLUMN IF NOT EXISTS "cancelled_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "cancellation_reason" text;
--> statement-breakpoint
-- No delivery mutation service existed before this migration. Normalize the
-- dormant fencing projection before making the attempt number its sole epoch.
UPDATE "node_deliveries"
SET "last_fencing_token" = "attempt_count"::text
WHERE "last_fencing_token" IS DISTINCT FROM "attempt_count"::text;
--> statement-breakpoint
ALTER TABLE "node_deliveries"
  DROP CONSTRAINT IF EXISTS "node_deliveries_status_chk",
  DROP CONSTRAINT IF EXISTS "node_deliveries_attempt_chk",
  DROP CONSTRAINT IF EXISTS "node_deliveries_fencing_token_chk",
  DROP CONSTRAINT IF EXISTS "node_deliveries_initial_fence_chk",
  DROP CONSTRAINT IF EXISTS "node_deliveries_stored_capacity_chk",
  DROP CONSTRAINT IF EXISTS "node_deliveries_acknowledged_at_chk",
  DROP CONSTRAINT IF EXISTS "node_deliveries_cancelled_at_chk";
--> statement-breakpoint
ALTER TABLE "node_deliveries"
  ADD CONSTRAINT "node_deliveries_status_chk" CHECK (
    "status" IN ('stored','leased','executing','acknowledged','cancelled','dead_lettered')
  ),
  ADD CONSTRAINT "node_deliveries_attempt_chk" CHECK (
    "attempt_count" >= 0
    AND "max_attempts" BETWEEN 1 AND 100
    AND "attempt_count" <= "max_attempts"
  ),
  ADD CONSTRAINT "node_deliveries_fencing_token_chk" CHECK (
    "last_fencing_token" = "attempt_count"::text
  ),
  ADD CONSTRAINT "node_deliveries_stored_capacity_chk" CHECK (
    "status" != 'stored'
    OR "settled_by_event_id" IS NOT NULL
    OR "attempt_count" < "max_attempts"
  ),
  ADD CONSTRAINT "node_deliveries_acknowledged_at_chk" CHECK (
    ("status" = 'acknowledged') = ("acknowledged_at" IS NOT NULL)
    AND (
      "status" != 'acknowledged'
      OR ("attempt_count" > 0 AND "settled_by_event_id" IS NOT NULL)
    )
  ),
  ADD CONSTRAINT "node_deliveries_cancelled_at_chk" CHECK (
    ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)
    AND ("status" = 'cancelled') = ("cancellation_reason" IS NOT NULL)
    AND (
      "cancellation_reason" IS NULL
      OR "cancellation_reason" IN (
        'mission_cancelled','mission_expired','mission_failed','work_superseded',
        'node_revoked','workspace_revoked'
      )
    )
  );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_node_credentials_identity_node"
  ON "node_credentials" ("id", "node_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_node_deliveries_active_lease"
  ON "node_deliveries" ("active_lease_id") WHERE "active_lease_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_node_deliveries_due"
  ON "node_deliveries" ("node_id", "available_at", "cursor")
  WHERE "status" = 'stored' AND "settled_by_event_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_node_deliveries_recovery"
  ON "node_deliveries" ("node_id", "lease_expires_at", "cursor")
  WHERE "status" IN ('leased','executing') AND "settled_by_event_id" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_operation_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "origin" text NOT NULL,
  "node_id" uuid NOT NULL REFERENCES "nodes"("id") ON DELETE restrict,
  "mission_id" uuid NOT NULL REFERENCES "missions"("id") ON DELETE restrict,
  "delivery_id" uuid NOT NULL,
  "operation" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "credential_id" uuid,
  "attempt_count" integer NOT NULL,
  "lease_id" uuid,
  "fencing_token" text,
  "lease_expires_at" timestamp with time zone,
  "status_before" text NOT NULL,
  "status_after" text NOT NULL,
  "cancellation_reason" text,
  "input" jsonb NOT NULL,
  "output" jsonb NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT "delivery_operation_receipts_delivery_owner_fk"
    FOREIGN KEY ("node_id", "mission_id", "delivery_id")
    REFERENCES "node_deliveries"("node_id", "mission_id", "id") ON DELETE restrict,
  CONSTRAINT "delivery_operation_receipts_credential_node_fk"
    FOREIGN KEY ("credential_id", "node_id")
    REFERENCES "node_credentials"("id", "node_id") ON DELETE restrict,
  CONSTRAINT "delivery_operation_receipts_origin_chk" CHECK (
    "origin" IN ('node','relay')
  ),
  CONSTRAINT "delivery_operation_receipts_operation_chk" CHECK (
    "operation" IN ('claim','start','renew','complete','release','lease_expired','cancel')
  ),
  CONSTRAINT "delivery_operation_receipts_status_chk" CHECK (
    "status_before" IN (
      'stored','leased','executing','acknowledged','cancelled','dead_lettered'
    )
    AND "status_after" IN (
      'stored','leased','executing','acknowledged','cancelled','dead_lettered'
    )
  ),
  CONSTRAINT "delivery_operation_receipts_idempotency_key_chk" CHECK (
    octet_length("idempotency_key") BETWEEN 1 AND 128
  ),
  CONSTRAINT "delivery_operation_receipts_attempt_chk" CHECK (
    "attempt_count" BETWEEN 0 AND 100
    AND ("operation" = 'cancel' OR "attempt_count" > 0)
  ),
  CONSTRAINT "delivery_operation_receipts_fencing_token_chk" CHECK (
    "fencing_token" IS NULL OR "fencing_token" = "attempt_count"::text
  ),
  CONSTRAINT "delivery_operation_receipts_lease_chk" CHECK (
    ("lease_id" IS NULL) = ("fencing_token" IS NULL)
    AND ("lease_id" IS NULL) = ("lease_expires_at" IS NULL)
    AND (
      "origin" != 'node'
      OR "lease_id" IS NOT NULL
      OR ("operation" = 'claim' AND "status_after" = 'dead_lettered')
    )
  ),
  CONSTRAINT "delivery_operation_receipts_origin_credential_chk" CHECK (
    ("origin" = 'node') = ("credential_id" IS NOT NULL)
  ),
  CONSTRAINT "delivery_operation_receipts_origin_operation_chk" CHECK (
    (
      "origin" = 'node'
      AND "operation" IN ('claim','start','renew','complete','release')
    ) OR (
      "origin" = 'relay'
      AND "operation" IN ('lease_expired','cancel')
    )
  ),
  CONSTRAINT "delivery_operation_receipts_transition_chk" CHECK (
    (
      "operation" = 'claim'
      AND (
        ("status_before" = 'stored' AND "status_after" = 'leased')
        OR (
          "status_before" IN ('leased','executing')
          AND "status_after" = 'dead_lettered'
        )
      )
    ) OR (
      "operation" = 'start'
      AND "status_before" = 'leased'
      AND "status_after" = 'executing'
    ) OR (
      "operation" = 'renew'
      AND "status_before" IN ('leased','executing')
      AND "status_after" = "status_before"
    ) OR (
      "operation" = 'complete'
      AND "status_before" = 'executing'
      AND "status_after" = 'acknowledged'
    ) OR (
      "operation" IN ('release','lease_expired')
      AND "status_before" IN ('leased','executing')
      AND "status_after" IN ('stored','dead_lettered')
    ) OR (
      "operation" = 'cancel'
      AND "status_before" IN ('stored','leased','executing')
      AND "status_after" = 'cancelled'
    )
  ),
  CONSTRAINT "delivery_operation_receipts_cancellation_chk" CHECK (
    ("operation" = 'cancel') = ("cancellation_reason" IS NOT NULL)
    AND (
      "cancellation_reason" IS NULL
      OR "cancellation_reason" IN (
        'mission_cancelled','mission_expired','mission_failed','work_superseded',
        'node_revoked','workspace_revoked'
      )
    )
  ),
  CONSTRAINT "delivery_operation_receipts_deadline_chk" CHECK (
    (
      "operation" NOT IN ('claim','start','renew','complete','release')
      OR ("operation" = 'claim' AND "status_after" = 'dead_lettered')
      OR "recorded_at" < "lease_expires_at"
    )
    AND (
      "operation" != 'lease_expired'
      OR "lease_expires_at" IS NULL
      OR "recorded_at" >= "lease_expires_at"
    )
  ),
  CONSTRAINT "delivery_operation_receipts_input_chk" CHECK (
    jsonb_typeof("input") = 'object'
    AND octet_length("input"::text) <= 1048576
  ),
  CONSTRAINT "delivery_operation_receipts_output_chk" CHECK (
    jsonb_typeof("output") = 'object'
    AND octet_length("output"::text) <= 1048576
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_delivery_operation_receipts_node_idempotency"
  ON "delivery_operation_receipts" ("origin", "node_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_delivery_operation_receipts_delivery_history"
  ON "delivery_operation_receipts" ("delivery_id", "recorded_at", "id");
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_delivery_operation_receipts_claim_attempt";
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_delivery_operation_receipts_claim_attempt"
  ON "delivery_operation_receipts" ("delivery_id", "attempt_count")
  WHERE "operation" = 'claim' AND "status_after" = 'leased';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_delivery_operation_receipts_claim_lease"
  ON "delivery_operation_receipts" ("lease_id")
  WHERE "operation" = 'claim' AND "lease_id" IS NOT NULL;
