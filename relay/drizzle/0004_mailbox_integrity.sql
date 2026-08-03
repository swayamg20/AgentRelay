-- Drizzle reads its migration journal before opening the migration transaction.
-- Concurrent runners can therefore both decide this file is pending. Serialize the
-- file, then use the new messages column itself as the one-time backfill marker.
SELECT pg_advisory_xact_lock(
  hashtextextended('agentrelay:migration:0004_mailbox_integrity', 0)
);
--> statement-breakpoint
ALTER TABLE "handoffs"
  ADD COLUMN IF NOT EXISTS "completion_artifacts" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
-- Before this migration, first-message artifacts lived on the handoff and append
-- artifacts were stored inside messages.payload.artifacts. Move both into the typed
-- column, then remove the old relay-owned envelope. If another runner already added
-- the column, it also completed this transactional backfill, so never reinterpret
-- payloads written by the new application.
DO $agentrelay$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = to_regclass('messages')
      AND attname = 'artifacts'
      AND NOT attisdropped
  ) THEN
    ALTER TABLE "messages"
      ADD COLUMN "artifacts" jsonb DEFAULT '[]'::jsonb NOT NULL;

    UPDATE "messages" AS "message"
    SET
      "artifacts" = CASE
        WHEN "message"."sequence_no" = 1
          THEN COALESCE("handoff"."artifacts", '[]'::jsonb)
        WHEN jsonb_typeof("message"."payload" -> 'artifacts') = 'array'
          THEN "message"."payload" -> 'artifacts'
        ELSE '[]'::jsonb
      END,
      "payload" = CASE
        WHEN jsonb_typeof("message"."payload") = 'object'
          THEN "message"."payload" - 'artifacts'
        ELSE '{}'::jsonb
      END
    FROM "handoffs" AS "handoff"
    WHERE "message"."handoff_id" = "handoff"."id";
  END IF;
END
$agentrelay$;
--> statement-breakpoint
-- Legacy card updates stored plaintext URLs which the dispatcher deliberately
-- refuses to consume. A SQL migration cannot encrypt them without the runtime key,
-- so remove the secret and require the owner to submit the webhook again.
UPDATE "agent_cards"
SET "notification_webhook_url" = NULL
WHERE "notification_webhook_url" IS NOT NULL
  AND "notification_webhook_url" NOT LIKE 'enc:v1:%';
