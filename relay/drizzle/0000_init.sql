CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "citext";--> statement-breakpoint
CREATE TYPE "public"."handoff_status" AS ENUM('pending', 'accepted', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_cards" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"card" jsonb NOT NULL,
	"repos_owned" text[] DEFAULT '{}'::text[] NOT NULL,
	"skills" text[] DEFAULT '{}'::text[] NOT NULL,
	"notification_webhook_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handle" text NOT NULL,
	"email" "citext" NOT NULL,
	"display_name" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_handle_unique" UNIQUE("handle"),
	CONSTRAINT "agents_email_unique" UNIQUE("email"),
	CONSTRAINT "agents_status_chk" CHECK ("agents"."status" IN ('active','disabled'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"key_hash" "bytea" NOT NULL,
	"salt" "bytea" NOT NULL,
	"label" text,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"intent" text DEFAULT 'inform' NOT NULL,
	"status" "handoff_status" DEFAULT 'pending' NOT NULL,
	"artifacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"proposed_action" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"accepted_by_session" text,
	"accepted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completed_summary" text,
	"cancelled_at" timestamp with time zone,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handoffs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "handoffs_sender_not_recipient" CHECK ("handoffs"."sender_id" != "handoffs"."recipient_id"),
	CONSTRAINT "handoffs_intent_valid" CHECK ("handoffs"."intent" IN ('inform','ask_question','propose_action')),
	CONSTRAINT "handoffs_proposed_action_invariant" CHECK (("handoffs"."intent" = 'propose_action') = ("handoffs"."proposed_action" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handoff_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sequence_no" integer NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_cards" ADD CONSTRAINT "agent_cards_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_agents_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_sender_id_agents_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_recipient_id_agents_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_handoff_id_handoffs_id_fk" FOREIGN KEY ("handoff_id") REFERENCES "public"."handoffs"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_author_id_agents_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_cards_repos" ON "agent_cards" USING gin ("repos_owned");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_cards_skills" ON "agent_cards" USING gin ("skills");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agents_handle" ON "agents" USING btree ("handle");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agents_status" ON "agents" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_keys_agent" ON "api_keys" USING btree ("agent_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_api_keys_active_hash" ON "api_keys" USING btree ("key_hash") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_resource" ON "audit_log" USING btree ("resource_type","resource_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_audit_actor" ON "audit_log" USING btree ("actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_handoffs_recipient_status" ON "handoffs" USING btree ("recipient_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_handoffs_sender" ON "handoffs" USING btree ("sender_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_messages_seq" ON "messages" USING btree ("handoff_id","sequence_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_messages_handoff" ON "messages" USING btree ("handoff_id","created_at");