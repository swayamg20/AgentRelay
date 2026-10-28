# Nightshift state

Working memory. Rewrite at the end of each session; history and active tests take
precedence over notes.

## Goal as understood

Ship owner-chosen `core-mailbox` issues with passing checks and concern-specific
commits. The goal is unchanged. The owner's October 28, 2026, 21:41:13 UTC reply on
#176 explicitly selects #44 now, defers its #30 metrics requirement to a follow-up,
assigns #34 outside Nightshift, and holds #8 until the #101 two-machine proof exists.
This supersedes the prerequisite interpretation recorded in the previous session.

#44 is complete on this branch in `ce0b06e` —
`feat(notifications): add a transactional outbox worker`. It is ready for owner
review, not yet claimed as merged into main. The PR description closes #44 under
the owner's explicitly approved metrics deferral. No other product issue is closed.

The previous #10/#103/#39 changes already merged through PR #175 (`cc61e09`).
#111/#40/#11 are also prior main work, not new branch product changes. This session
started clean on `nightshift` at `f0ac5bd`, a memory-only commit above `origin/main`.

## Plan

- [x] Read state, recent journal, history, repository instructions, design sources,
  issue inventory, and the owner's substantive #176 scope resolution.
- [x] Run harness setup and locked installation; use native job Postgres on 5433.
- [x] Trace mailbox transactions, A2A producers, notification destinations, the
  dispatcher and startup/shutdown, MCP receipts, and existing reliability tests.
- [x] Add the encrypted outbox migration/schema and transactional intent for
  creation, append, and completion without changing public mailbox contracts.
- [x] Replace the volatile queue with token-fenced, skip-locked shared claims,
  persisted retries/429 budget/outcomes, lease recovery, and terminal retention.
- [x] Verify rollback, idempotency, concurrency, expired/stale holders, lost
  responses, timeout, poison jobs, backlog, destination validation, and redaction.
- [x] Prove SIGKILL recovery with real 30-second leases in separate worker
  processes and committed pending-job replay across a production Relay restart.
- [x] Update truthful architecture/HLD/LLD/hosting/notification operations docs;
  check 56 local Markdown links and execute all four documented SQL diagnostics.
- [x] Pass all six shared gates and the focused/mailbox process checks; commit #44
  and prepare run memory, owner-resolution record, summary, and branch-wide PR text.
- [ ] Resume only after owner feedback, new eligible scoped work, or actual #101
  evidence supplies another unblocked issue. Stop this run after memory is committed.

## Next step

Handle any PR findings first. Recheck `origin/main` and branch history before
making closure claims or repeating implementation. If #44 is already merged,
exclude it from candidate selection. Read the refreshed inventory and owner inbox.

There are not three remaining unconditional, one-run-ready eligible candidates:
#34 is explicitly being done outside Nightshift, #8 still requires real #101
evidence, and #44 is now complete. Do not manufacture a third candidate from an
epic, Labs, interop, or demand-gated #30. Do not repeat the answered #176 selection
question. Propose three candidates only if a refreshed eligible backlog supplies
them; otherwise wait for new small owner-scoped mailbox work or the proof evidence.

## Waiting on owner

- #176 is fully resolved by the October 28, 2026, 21:41:13 UTC reply. Record 176 in
  the external `resolved.txt`; no duplicate prerequisite question is needed.
- #44 is ready for review/merge. Queue age/depth/outcome metrics through #30 are
  explicitly deferred, not implemented or required for this scoped closure.
- #34 is assigned outside Nightshift; do not probe or change Docker permissions,
  touch protected workflows, or attempt its backup/restore runbook here.
- #8 stays on hold until actual sanitized #101 two-owner/two-machine evidence
  exists. Local worker and mailbox process proofs are not that evidence.
- No additional unblocked eligible three-issue shortlist exists in this snapshot.

## Learned about the repository

- `relay/src/services/handoff.ts` now receives notification encryption/public-URL
  context from A2A. Creation, append, and completion insert intent alongside their
  authoritative mutation, mailbox event, and audit in the same transaction.
  Creation/append replays do not enqueue again. Acceptance remains silent;
  cancellation remains pending-only and silent, preserving the lifecycle contract.
- `0011_notification_outbox` stores recipient/thread/kind/source identity and an
  AES-GCM encrypted 240-character preview with sender metadata. Recipient/kind/source
  is unique. Partial indexes cover due jobs, expired leases, and terminal cleanup.
  There is no historical backfill or recovery of the old queue's already-lost jobs.
- Each process polls idle work once per second and claims one job using
  `FOR UPDATE SKIP LOCKED`. Claims have fresh UUID tokens and 30-second leases.
  Attempts count claims (including ambiguous/dead claims), with a maximum of four.
  A dead fourth holder settles terminally without a fifth provider post.
- Five-second posting bounds and token/deadline predicates protect settlement.
  Provider and database failures have separate boundaries: failed settlement leaves
  leased work for recovery, not a false provider classification. A pause beyond a
  lease or lost provider response can still duplicate external attempts; database
  fencing does not promise exactly-once Slack delivery or recipient pickup.
- Network/5xx retry due times persist at 1s/4s/16s. One 429 retry budget survives
  reconstruction; numeric Retry-After is capped at one day, invalid/missing values
  use one second. Other 4xx and poison payloads are terminal. Destinations are read
  from the current encrypted card, validated at send time, and cannot redirect.
  Removed webhooks/disabled recipients skip; unmarked plaintext fails closed.
- No old 10,000-entry overflow drop remains. Worker memory/concurrency are bounded,
  not total PostgreSQL backlog. Active work is never silently evicted. Terminal
  previews are erased immediately and up to 100 terminal rows older than seven
  days are cleaned per worker per minute. Preserve the encryption key on replicas.
- No notification body, ciphertext, webhook, provider error text, or response body
  is logged. No metrics endpoint, new dependency, Labs activation, release,
  workflow, Compose, version, deployment, or public HTTP/MCP/config change was added.
- Shared checks passed: 125 protocol, 393 MCP, 79 database-free Relay, and 438 Node
  unit tests (expected 274 Relay database and three Node opt-in skips); 274 Relay
  integration tests; four mailbox process tests across three e2e files. Lint has
  three existing unused-suppression warnings. Keep database URLs unset for unit
  tests and run database test files serially through the canonical integration runner.

## Verification commands

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm -r typecheck
pnpm -r build
env -u RELAY_TEST_DATABASE_URL -u RELAY_DATABASE_URL pnpm --filter @agentrelay/protocol --filter relay --filter agentrelay-mcp --filter agentrelay-node test
RELAY_TEST_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay RELAY_TEST_TRUNCATE_VIA_PSQL=1 pnpm --filter relay test:integration
RELAY_TEST_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay pnpm --filter relay exec vitest run src/notifications/dispatcher-process.test.ts
pnpm --filter agentrelay-e2e exec vitest run src/notification-reliability.e2e.test.ts src/mailbox-reliability.e2e.test.ts src/handoff-roundtrip.e2e.test.ts
```
