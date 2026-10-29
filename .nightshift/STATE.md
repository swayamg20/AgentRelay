# Nightshift state

Working memory. Rewrite at the end of each session; history and active tests take
precedence over notes.

## Goal as understood

Ship owner-chosen `core-mailbox` issues one at a time with passing checks. The goal
is unchanged. The previously recorded October 28, 2026, 21:41:13 UTC owner reply on
#176 selected #44, deferred its #30 metrics requirement, assigned #34 elsewhere,
and held #8 until actual #101 two-owner/two-machine evidence exists. This run has
no new owner reply or PR feedback.

#44 is complete on this branch in `ce0b06e` —
`feat(notifications): add a transactional outbox worker`. The prior PR #178
typecheck repair is in `945e9d5` —
`fix(e2e): build relay before typechecking restart tests`. Both remain outside
the supplied `origin/main` snapshot. This session starts at `2e569a2`, makes no
product changes, and revalidates the branch with all six required checks, four
mailbox process tests, protocol exports, and the packed MCP artifact smoke passing.
Remote CI and merge status were not queried; no GitHub access was attempted.

The #10/#103/#39 work merged through PR #175 (`cc61e09`). #111/#40/#11 are also
prior main work. #34's backup/restore documentation merged through PR #179
(`0a93246`), the current supplied `origin/main` tip, and is not a branch change.
The branch-wide PR description closes only #44, with metrics explicitly deferred.

## Plan

- [x] Read memory first, run harness setup, and inspect clean status and history.
- [x] Read instructions, current designs, the eligible issue snapshot, and the
  notification producer, worker, MCP consumer, and nearby tests.
- [x] Confirm the selected issue and prior typecheck repair are already committed;
  do not duplicate implementation or expand owner scope.
- [x] Pass all six required gates against the job's Postgres on port 5433.
- [x] Pass mailbox/notification process proofs, protocol exports, and packed MCP
  artifact smoke.
- [x] Recheck candidate eligibility; do not invent a three-issue shortlist.
- [x] Update run memory, branch-wide PR description, external summary, and STOP.

## Next step

Read new PR feedback and owner replies first, then compare current branch history
with the workflow-supplied `origin/main`. If #44 has merged, exclude it from
future candidates. Address any blocking PR findings before new product work.

The refreshed inventory contains exactly five `core-mailbox` issues: #128, #102,
and #101 are epics and therefore excluded; #44 is complete on this branch; #8 is
blocked on #101 evidence. There are no three unblocked one-run candidates. Do not
repeat the answered #176 question or manufacture candidates from Labs, interop,
demand-gated #30, completed main work, or fabricated proof evidence. Propose the
next three only when an eligible refreshed backlog makes that possible.

## Waiting on owner

- #44 is ready for review/merge, subject to remote checks. Its #30 metrics work is
  expressly deferred, not shipped by this branch.
- No unresolved question or new owner selection appears in this run's inbox.
  No duplicate question or resolution record is created.
- #8 needs actual sanitized #101 transcripts/evidence from two owners and two
  machines. Local process tests do not satisfy that prerequisite.
- New small eligible mailbox issues or that evidence are needed before another
  product change. Stop this run rather than expanding scope.

## Learned about the repository

- Mailbox creation, append, and completion insert encrypted notification intent
  alongside their mutation, recipient event, and audit in the same transaction.
  Creation/append replays do not add jobs; acceptance/cancellation stay silent.
- Migration `0011_notification_outbox` adds unique source identity, encrypted
  previews, due/lease/terminal state, and partial indexes. No historical backfill
  or recovery of jobs already lost from the old queue is claimed.
- Workers claim one job with skip-locked row selection, a fresh UUID token, and
  a 30-second lease. Claim count, bounded retries, one persisted Slack 429 retry,
  fencing, outcomes, and terminal cleanup are durable database state.
- Slack is an optional at-least-once hint, never pickup or reply evidence.
  Workers resolve current webhook configuration, enforce the Slack allowlist,
  and never log sensitive payloads or provider exception text.
- Worker memory is bounded, not total PostgreSQL backlog. Active work is not
  evicted. Terminal previews are erased and old terminal rows are batch-cleaned.
- TypeScript does not run Vitest global setup. The static production Relay import
  in E2E restart tests needs the Relay build in E2E `pretypecheck`; package hooks
  remain serial to avoid concurrent protocol output writers.
- This run passes 125 protocol, 393 MCP, 79 database-free Relay, and 438 Node unit
  tests, with expected 274 Relay database and three Node opt-in skips. Integration
  passes 274 tests; mailbox process proofs pass four tests across three files.
- Lint retains three existing unused-suppression warnings. Initial locked install
  reports missing links to not-yet-built Node binaries; later builds and packed
  artifact smoke pass. No dependency, workflow, infra, version, or public contract
  change is made this session. Memory adds no Markdown links.

## Verification commands

All pass this session:

```bash
bash "$NIGHTSHIFT_HARNESS/setup-install.sh"
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
