# Nightshift state

Working memory. Rewrite at the end of each session; history and active tests take
precedence over notes.

## Goal as understood

Ship owner-chosen `core-mailbox` issues with passing checks and concern-specific
commits. The goal is unchanged. The owner's October 28, 2026, 21:41:13 UTC reply on
#176 explicitly selects #44 now, defers its #30 metrics requirement to a follow-up,
assigns #34 outside Nightshift, and holds #8 until the #101 two-machine proof exists.
That selection remains authoritative; this session has no new owner scope reply.

#44 is complete on this branch in `ce0b06e` —
`feat(notifications): add a transactional outbox worker`. The blocking PR #178
`lint-typecheck` failure is reproduced and fixed in `945e9d5` —
`fix(e2e): build relay before typechecking restart tests`. All six required local
checks and the mailbox process proofs pass. Remote CI still needs to rerun; no
GitHub access was attempted. The PR description closes #44 under the owner's
explicitly approved metrics deferral. No other product issue is closed here.

The previous #10/#103/#39 changes already merged through PR #175 (`cc61e09`).
#111/#40/#11 are also prior main work, not new branch product changes. #34's backup
and restore documentation now landed on main through PR #179 (`0a93246`) and is
absent from the refreshed issue inventory. This session started clean on
`nightshift` at `b4f2f92`, after the workflow merged that main update into the branch.

## Plan

- [x] Read memory, recent history, instructions, relevant designs, and refreshed
  inventory before addressing the blocking PR #178 finding.
- [x] Run harness setup and locked installation against native Postgres on 5433.
- [x] Reproduce clean-checkout `pnpm -r typecheck` failure: TS2307 for the new E2E
  test's static import of `relay/dist/db/client.js`.
- [x] Trace the compiled Relay database producer, E2E import, test global setup,
  and existing package build hooks; preserve the production-restart test boundary.
- [x] Add only the missing Relay build to E2E `pretypecheck`, using the same serial
  Relay/MCP/Node order as E2E global setup, without dependencies or workflow edits.
- [x] Pass all six shared gates, protocol exports, packed-artifact smoke, and all
  four mailbox process tests across three E2E files; commit the focused fix.
- [x] Recheck eligible issues: #44 is complete here, #34 landed elsewhere, and #8
  still lacks #101 evidence. Do not invent three eligible candidates.
- [x] Prepare branch-wide PR description, external summary, updated run memory,
  and STOP. Resume only for PR feedback or newly unblocked owner-scoped work.

## Next step

Handle any PR findings first. Recheck `origin/main` and branch history before
making closure claims or repeating implementation. If #44 is already merged,
exclude it from candidate selection. Read the refreshed inventory and owner inbox.

There are not three remaining unconditional, one-run-ready eligible candidates:
#34 is already on main, #8 still requires real #101 evidence, and #44 is complete
on this branch. Do not manufacture candidates from epics, Labs, interop, or
demand-gated #30. Do not repeat the answered #176 selection question. Propose three
candidates only if a refreshed eligible backlog supplies them; otherwise wait for
new small owner-scoped mailbox work or the proof evidence.

## Waiting on owner

- #176 was fully resolved and recorded by the previous run; no duplicate question
  or new resolution record is needed. The current inbox contains no open question.
- #44 is ready for review/merge. Queue age/depth/outcome metrics through #30 are
  explicitly deferred, not implemented or required for this scoped closure.
- PR #178's reproduced typecheck failure is fixed locally; the workflow must
  rerun remote CI. No workflow, infra, Docker-permission, or deployment changes.
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
- E2E global setup builds Relay/MCP/Node before tests, but TypeScript does not run
  Vitest setup. A static compiled Relay import therefore also needs Relay built
  by E2E `pretypecheck`. Recursive typechecking must work before recursive build
  on a fresh checkout. Keep build hooks serial to avoid shared protocol writers.
- Shared checks passed: 125 protocol, 393 MCP, 79 database-free Relay, and 438 Node
  unit tests (expected 274 Relay database and three Node opt-in skips); 274 Relay
  integration tests; four mailbox process tests across three e2e files. Lint has
  three existing unused-suppression warnings. Keep database URLs unset for unit
  tests and run database test files serially through the canonical integration runner.
- Protocol export validation and the locally packed MCP artifact smoke also passed
  this session. No public documentation links changed; memory adds no Markdown links.

## Verification commands

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm -r typecheck
pnpm -r build
env -u RELAY_TEST_DATABASE_URL -u RELAY_DATABASE_URL pnpm --filter @agentrelay/protocol --filter relay --filter agentrelay-mcp --filter agentrelay-node test
RELAY_TEST_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay RELAY_TEST_TRUNCATE_VIA_PSQL=1 pnpm --filter relay test:integration
RELAY_TEST_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay pnpm --filter agentrelay-e2e exec vitest run src/notification-reliability.e2e.test.ts src/mailbox-reliability.e2e.test.ts src/handoff-roundtrip.e2e.test.ts
pnpm --filter @agentrelay/protocol test:exports
pnpm --dir mcp-server pack --pack-destination "$NIGHTSHIFT_OUT"
node mcp-server/scripts/smoke-packed-artifact.mjs "$NIGHTSHIFT_OUT/agentrelay-mcp-$(node -p "require('./mcp-server/package.json').version").tgz"
git diff --check
git diff --cached --check
```
