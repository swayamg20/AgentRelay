# Slack notification operations

Slack is an optional human-facing hint. A Relay receipt proves database storage,
not Slack delivery, device pickup, agent processing, or a reply. The mailbox and
its authenticated replay remain authoritative when notifications fail.

## Upgrade and replica ownership

Stop older Relay processes, apply migrations using the existing deployment's
database configuration, and start the upgraded processes:

```bash
pnpm --filter relay db:migrate
pnpm --filter relay start
```

These commands run against the configured `RELAY_DATABASE_URL`; use the normal
deployment procedure, not a new database. Migration `0011_notification_outbox`
adds the outbox without changing existing mailbox, Mission, credential, HTTP, or
MCP contracts. It does not backfill historical Slack attempts or recover jobs
already lost from an older process-local queue. Older processes do not write
transactional notification intent, so mixed-version operation is not this guarantee.

All replicas must share the database and stable `RELAY_ENCRYPTION_KEY`. Active
notification previews and card webhook URLs use authenticated AES-256-GCM
encryption. A key mismatch makes those jobs fail closed; there is no automatic
key rotation or re-encryption. Backups still contain sensitive mailbox data and
encrypted notification data and must be protected.

Creation, append, and completion store notification intent alongside the mutation,
mailbox event, and audit, in one transaction. A failed database insert rolls that
transaction back; it does not return a successful durable receipt. After commit,
Slack failures cannot undo the mailbox or alter Labs Mission delivery state.
Creation and append replays reuse their existing receipts without adding jobs.
Acceptance and pending cancellation remain silent.

## Attempts and recovery

Each Relay process claims one due job at a time with `FOR UPDATE SKIP LOCKED`, a
fresh token, and a 30-second lease. Idle polling is once per second. Multiple
replicas can work on different jobs; no global FIFO Slack delivery is promised.
Pending retries release ownership rather than sleeping inside a leased attempt.

The `attempts` column counts claims, not proven provider deliveries. A claim is
recorded before any external request, so a crash can consume an attempt even if
the provider saw nothing. There are at most four claims. On lease expiry another
worker can reclaim the job; expiry after the fourth claim ends in `max_attempts`
without a fifth post. A late holder cannot settle or reschedule a replaced lease.

Posts have a five-second timeout. Network errors and server failures retry after
1s, 4s, and 16s according to the persisted claim count. Slack 429 permits one
persisted rate-limit retry, even across restart, respecting numeric Retry-After
seconds up to one day. Missing, nonfinite, or negative values use one second.
Other 4xx responses are terminal. A corrupt preview, wrong encryption key, or
disallowed destination is terminal rather than a poison job that blocks the queue.
The worker resolves the current encrypted card webhook immediately before an
attempt, validates the exact HTTPS Slack allowlist, and refuses redirects. A
missing/cleared webhook or disabled recipient is skipped.

External attempts are **at least once, not exactly once**. Slack can accept a
request whose response is lost before the Relay records success. A replacement
worker can then post it again. A paused process outliving its lease can also leave
an already-issued external request in flight; database fencing cannot withdraw
that request from Slack. A recorded success means only that Slack returned success,
never that the recipient agent picked up or replied to the message. Bounded retries
may terminate without a successful provider response.

## Backlog, retention, and diagnostics

There is no process-local queue overflow drop. Workers keep only one claimed job
in memory; all other work stays in PostgreSQL. This bounds per-process memory and
provider concurrency, **not total database storage**. Monitor database capacity
and oldest pending work with existing operational access. Active jobs are not
silently evicted to keep a queue below an arbitrary size. Database exhaustion
affects normal database writes, including the atomic mailbox/outbox transaction.

Successful, failed, and skipped jobs erase their encrypted previews immediately.
Each worker cleans up to 100 terminal rows older than seven days every minute,
using skip-locked row selection so replicas can clean concurrently. A large
terminal backlog may take longer to clear. Active/retry/leased rows are not cleaned
by retention. Terminal state is operational history, not a permanent audit ledger;
the authoritative mailbox audit is unchanged. There is no manual notification
requeue or new management endpoint in this change.

The following read-only diagnostics return counts, times, and finite outcomes,
not message bodies or destinations. Use them from an approved PostgreSQL session:

```sql
SELECT status, count(*) AS jobs, min(created_at) AS oldest_created_at
FROM notification_outbox
GROUP BY status;

SELECT count(*) AS due_jobs, min(created_at) AS oldest_due_created_at
FROM notification_outbox
WHERE status = 'pending' AND available_at <= now();

SELECT count(*) AS expired_leases
FROM notification_outbox
WHERE status = 'leased' AND lease_expires_at <= now();

SELECT status, reason, last_status, count(*) AS jobs
FROM notification_outbox
WHERE terminal_at IS NOT NULL
GROUP BY status, reason, last_status;
```

Workers log only job identifiers and safe outcomes. They do not log webhook URLs,
previews, ciphertext, provider exception text, or response bodies. Do not add those
fields to custom logs or monitoring. Queue age/depth/outcome metrics through #30
are owner-deferred follow-up work; this outbox does not add a metrics endpoint.

## Verification

The focused Relay integration tests cover atomic rollback, idempotent routing,
multi-worker claims, lease fencing/death, durable retry/429 state, bounded attempts,
poison jobs, a backlog over the old local queue limit, retention, and redaction.
Separate worker processes are killed with SIGKILL and recovered using their real
lease deadlines. A production Relay process test restarts with a committed pending
job, replays the original receipt, retrieves the mailbox, and observes the restarted
worker process due work. Provider responses in worker tests are controlled fixtures,
not a live Slack delivery claim.
