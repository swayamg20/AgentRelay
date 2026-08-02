-- Keep concurrent relay startup migrations from applying this file twice.
SELECT pg_advisory_xact_lock(
  hashtextextended('agentrelay:migration:0005_durable_delivery_ledger', 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "nodes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE restrict,
  "name" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "last_seen_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "idx_nodes_identity_owner" UNIQUE ("id", "agent_id"),
  CONSTRAINT "nodes_status_chk" CHECK ("status" IN ('active','revoked')),
  CONSTRAINT "nodes_revoked_at_chk" CHECK (
    ("status" = 'revoked') = ("revoked_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_nodes_agent" ON "nodes" ("agent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_nodes_active_name"
  ON "nodes" ("agent_id", "name") WHERE "status" = 'active';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_bindings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "node_id" uuid NOT NULL REFERENCES "nodes"("id") ON DELETE restrict,
  "alias" text NOT NULL,
  "repository_url" text NOT NULL,
  "allowed_base_refs" text[] DEFAULT '{}'::text[] NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "idx_workspace_bindings_identity_node" UNIQUE ("id", "node_id"),
  CONSTRAINT "workspace_bindings_status_chk" CHECK ("status" IN ('active','revoked')),
  CONSTRAINT "workspace_bindings_revoked_at_chk" CHECK (
    ("status" = 'revoked') = ("revoked_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspace_bindings_node" ON "workspace_bindings" ("node_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_workspace_bindings_active_alias"
  ON "workspace_bindings" ("node_id", "alias") WHERE "status" = 'active';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "missions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "created_by_agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE restrict,
  "coordinator_config" jsonb NOT NULL,
  "state" jsonb NOT NULL,
  "status" text DEFAULT 'awaiting_acceptance' NOT NULL,
  "last_event_sequence" integer DEFAULT 0 NOT NULL,
  "contract_version" integer DEFAULT 1 NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "missions_status_chk" CHECK (
    "status" IN ('awaiting_acceptance','active','verifying','blocked','completed','cancelled','expired','failed')
  ),
  CONSTRAINT "missions_sequence_chk" CHECK ("last_event_sequence" >= 0),
  CONSTRAINT "missions_contract_version_chk" CHECK ("contract_version" > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_missions_creator"
  ON "missions" ("created_by_agent_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_missions_status" ON "missions" ("status", "updated_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mission_participants" (
  "mission_id" uuid NOT NULL REFERENCES "missions"("id") ON DELETE restrict,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE restrict,
  "node_id" uuid NOT NULL REFERENCES "nodes"("id") ON DELETE restrict,
  "workspace_binding_id" uuid NOT NULL REFERENCES "workspace_bindings"("id") ON DELETE restrict,
  "role" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "accepted_at" timestamp with time zone,
  "acceptance_idempotency_key" text,
  "acceptance_receipt" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mission_participants_pkey" PRIMARY KEY ("mission_id", "agent_id"),
  CONSTRAINT "mission_participants_node_owner_fk"
    FOREIGN KEY ("node_id", "agent_id") REFERENCES "nodes"("id", "agent_id") ON DELETE no action,
  CONSTRAINT "mission_participants_binding_node_fk"
    FOREIGN KEY ("workspace_binding_id", "node_id") REFERENCES "workspace_bindings"("id", "node_id") ON DELETE no action,
  CONSTRAINT "mission_participants_status_chk" CHECK ("status" IN ('pending','accepted')),
  CONSTRAINT "mission_participants_accepted_at_chk" CHECK (
    ("status" = 'accepted') = ("accepted_at" IS NOT NULL)
    AND ("status" = 'accepted') = ("acceptance_idempotency_key" IS NOT NULL)
    AND ("status" = 'accepted') = ("acceptance_receipt" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mission_participants_node"
  ON "mission_participants" ("node_id", "mission_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_mission_participants_mission_node"
  ON "mission_participants" ("mission_id", "node_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_mission_participants_acceptance_idempotency"
  ON "mission_participants" ("mission_id", "acceptance_idempotency_key")
  WHERE "acceptance_idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mission_events" (
  "id" uuid PRIMARY KEY NOT NULL,
  "mission_id" uuid NOT NULL REFERENCES "missions"("id") ON DELETE restrict,
  "sequence_no" integer NOT NULL,
  "type" text NOT NULL,
  "actor_agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE restrict,
  "idempotency_key" text NOT NULL,
  "source_delivery_id" uuid,
  "causal_parent_event_id" uuid,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "idx_mission_events_mission_identity" UNIQUE ("mission_id", "id"),
  CONSTRAINT "mission_events_causal_parent_fk"
    FOREIGN KEY ("mission_id", "causal_parent_event_id")
    REFERENCES "mission_events"("mission_id", "id") ON DELETE no action,
  CONSTRAINT "mission_events_actor_participant_fk"
    FOREIGN KEY ("mission_id", "actor_agent_id")
    REFERENCES "mission_participants"("mission_id", "agent_id") ON DELETE no action,
  CONSTRAINT "mission_events_type_chk" CHECK (
    "type" IN ('participants_accepted','turn_completed','contract_acknowledged','verification_recorded')
  ),
  CONSTRAINT "mission_events_sequence_chk" CHECK ("sequence_no" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_mission_events_sequence"
  ON "mission_events" ("mission_id", "sequence_no");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_mission_events_idempotency"
  ON "mission_events" ("mission_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mission_events_created"
  ON "mission_events" ("mission_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "node_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "node_id" uuid NOT NULL REFERENCES "nodes"("id") ON DELETE restrict,
  "mission_id" uuid NOT NULL REFERENCES "missions"("id") ON DELETE restrict,
  "mission_event_id" uuid NOT NULL REFERENCES "mission_events"("id") ON DELETE restrict,
  "kind" text NOT NULL,
  "cursor" bigserial NOT NULL,
  "status" text DEFAULT 'stored' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 5 NOT NULL,
  "last_fencing_token" text DEFAULT '0' NOT NULL,
  "active_lease_id" uuid,
  "lease_expires_at" timestamp with time zone,
  "contract_version" integer NOT NULL,
  "verification_round" integer,
  "idempotency_key" text NOT NULL,
  "causal_parent_delivery_id" uuid,
  "settled_by_event_id" uuid,
  "settled_at" timestamp with time zone,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "acknowledged_at" timestamp with time zone,
  "dead_lettered_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "idx_node_deliveries_identity_scope" UNIQUE ("node_id", "mission_id", "id"),
  CONSTRAINT "idx_node_deliveries_mission_identity" UNIQUE ("mission_id", "id"),
  CONSTRAINT "node_deliveries_causal_parent_fk"
    FOREIGN KEY ("node_id", "mission_id", "causal_parent_delivery_id")
    REFERENCES "node_deliveries"("node_id", "mission_id", "id") ON DELETE no action,
  CONSTRAINT "node_deliveries_event_mission_fk"
    FOREIGN KEY ("mission_id", "mission_event_id")
    REFERENCES "mission_events"("mission_id", "id") ON DELETE no action,
  CONSTRAINT "node_deliveries_participant_node_fk"
    FOREIGN KEY ("mission_id", "node_id")
    REFERENCES "mission_participants"("mission_id", "node_id") ON DELETE no action,
  CONSTRAINT "node_deliveries_settlement_event_mission_fk"
    FOREIGN KEY ("mission_id", "settled_by_event_id")
    REFERENCES "mission_events"("mission_id", "id") ON DELETE no action,
  CONSTRAINT "node_deliveries_kind_chk" CHECK (
    "kind" IN ('turn','verification','contract_acknowledgement')
  ),
  CONSTRAINT "node_deliveries_status_chk" CHECK (
    "status" IN ('stored','leased','executing','acknowledged','dead_lettered')
  ),
  CONSTRAINT "node_deliveries_verification_round_chk" CHECK (
    (("kind" = 'verification') = ("verification_round" IS NOT NULL))
    AND ("verification_round" IS NULL OR "verification_round" > 0)
  ),
  CONSTRAINT "node_deliveries_attempt_chk" CHECK (
    "attempt_count" >= 0 AND "max_attempts" > 0 AND "attempt_count" <= "max_attempts"
  ),
  CONSTRAINT "node_deliveries_fencing_token_chk" CHECK (
    "last_fencing_token" ~ '^(0|[1-9][0-9]*)$'
  ),
  CONSTRAINT "node_deliveries_initial_fence_chk" CHECK (
    ("attempt_count" = 0) = ("last_fencing_token" = '0')
  ),
  CONSTRAINT "node_deliveries_lease_chk" CHECK (
    (("status" IN ('leased','executing')) = ("active_lease_id" IS NOT NULL))
    AND (("status" IN ('leased','executing')) = ("lease_expires_at" IS NOT NULL))
    AND ("status" NOT IN ('leased','executing') OR "attempt_count" > 0)
  ),
  CONSTRAINT "node_deliveries_acknowledged_at_chk" CHECK (
    (("status" = 'acknowledged') = ("acknowledged_at" IS NOT NULL))
    AND ("status" != 'acknowledged' OR "attempt_count" > 0)
  ),
  CONSTRAINT "node_deliveries_dead_lettered_at_chk" CHECK (
    ("status" = 'dead_lettered') = ("dead_lettered_at" IS NOT NULL)
  ),
  CONSTRAINT "node_deliveries_settlement_chk" CHECK (
    ("settled_by_event_id" IS NOT NULL) = ("settled_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_node_deliveries_cursor" ON "node_deliveries" ("cursor");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_node_deliveries_node_cursor"
  ON "node_deliveries" ("node_id", "cursor");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_node_deliveries_event_kind"
  ON "node_deliveries" ("node_id", "mission_event_id", "kind");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_node_deliveries_idempotency"
  ON "node_deliveries" ("node_id", "idempotency_key");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'mission_events_source_delivery_fk'
      AND conrelid = 'mission_events'::regclass
  ) THEN
    ALTER TABLE "mission_events"
      ADD CONSTRAINT "mission_events_source_delivery_fk"
      FOREIGN KEY ("mission_id", "source_delivery_id")
      REFERENCES "node_deliveries"("mission_id", "id") ON DELETE no action;
  END IF;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS nodes_set_updated_at ON nodes;
--> statement-breakpoint
CREATE TRIGGER nodes_set_updated_at
  BEFORE UPDATE ON nodes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS workspace_bindings_set_updated_at ON workspace_bindings;
--> statement-breakpoint
CREATE TRIGGER workspace_bindings_set_updated_at
  BEFORE UPDATE ON workspace_bindings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS missions_set_updated_at ON missions;
--> statement-breakpoint
CREATE TRIGGER missions_set_updated_at
  BEFORE UPDATE ON missions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS node_deliveries_set_updated_at ON node_deliveries;
--> statement-breakpoint
CREATE TRIGGER node_deliveries_set_updated_at
  BEFORE UPDATE ON node_deliveries FOR EACH ROW EXECUTE FUNCTION set_updated_at();
