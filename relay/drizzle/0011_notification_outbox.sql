CREATE TABLE IF NOT EXISTS notification_outbox (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	recipient_agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
	thread_id uuid NOT NULL REFERENCES handoffs(id) ON DELETE CASCADE,
	kind text NOT NULL,
	source_id uuid NOT NULL,
	encrypted_payload text,
	status text NOT NULL DEFAULT 'pending',
	attempts integer NOT NULL DEFAULT 0,
	rate_limit_retried boolean NOT NULL DEFAULT false,
	available_at timestamptz NOT NULL DEFAULT now(),
	lease_token uuid,
	lease_expires_at timestamptz,
	last_status integer,
	reason text,
	terminal_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT notification_outbox_kind_chk CHECK (kind IN (
		'notify.handoff.created', 'notify.message.appended',
		'notify.handoff.completed', 'notify.handoff.cancelled'
	)),
	CONSTRAINT notification_outbox_attempts_chk CHECK (attempts BETWEEN 0 AND 4),
	CONSTRAINT notification_outbox_state_chk CHECK (
		(status = 'pending' AND encrypted_payload IS NOT NULL
			AND lease_token IS NULL AND lease_expires_at IS NULL AND terminal_at IS NULL)
		OR (status = 'leased' AND encrypted_payload IS NOT NULL
			AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL
			AND attempts > 0 AND terminal_at IS NULL)
		OR (status IN ('succeeded', 'failed', 'skipped') AND encrypted_payload IS NULL
			AND lease_token IS NULL AND lease_expires_at IS NULL AND terminal_at IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_outbox_source
	ON notification_outbox (recipient_agent_id, kind, source_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notification_outbox_due
	ON notification_outbox (available_at, id) WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notification_outbox_lease
	ON notification_outbox (lease_expires_at, id) WHERE status = 'leased';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_notification_outbox_terminal
	ON notification_outbox (terminal_at, id) WHERE terminal_at IS NOT NULL;
