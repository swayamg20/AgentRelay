# Nightshift state

Working memory. Rewrite at the end of each session; history and active tests take
precedence over notes.

## Goal as understood

Ship owner-chosen `core-mailbox` issues one at a time with passing checks. The goal
is unchanged. The recorded October 28, 2026, 21:41:13 UTC owner reply on #176
selected #44, deferred its #30 metrics requirement, assigned #34 elsewhere, and
held #8 until actual #101 two-owner/two-machine evidence exists. This run supplies
no new owner reply or PR feedback.

#44 is complete on this branch in `ce0b06e` —
`feat(notifications): add a transactional outbox worker`. The prior PR #178
typecheck repair is in `945e9d5` —
`fix(e2e): build relay before typechecking restart tests`. Both remain outside
the workflow-supplied `origin/main` snapshot, whose tip is `0a93246`.

Run 40942715397 starts at `956cbb4`, makes no product changes, and passes all six
required checks, four mailbox process tests, protocol exports, and the packed MCP
artifact smoke. The branch-wide PR description closes only #44, with metrics
explicitly deferred. Remote CI, PR, and merge status were not queried.

## Plan

- [x] Read memory first, run harness setup, and inspect clean status and history.
- [x] Review instructions, relevant designs, issue scope, and notification
  producer/worker plus the MCP mailbox consumer and nearby tests.
- [x] Confirm #44 and the typecheck repair are already committed; do not duplicate
  implementation or expand the approved scope.
- [x] Pass all six required checks against the job's Postgres on port 5433.
- [x] Pass mailbox/restart process proofs, protocol exports, and packed MCP smoke.
- [x] Recheck the backlog and request an owner decision on the exhausted eligible
  inventory without inventing a three-issue shortlist.
- [x] Update memory, branch-wide PR description, external summary, and STOP.

## Next step

Read new PR feedback and owner replies first, then compare branch history with the
workflow-supplied `origin/main`. Address blocking PR findings before new work. If
#44 has merged, exclude it from future candidates.

The supplied inventory has exactly five `core-mailbox` issues: #128, #102, and
#101 are excluded epics; #44 is complete on the branch; #8 lacks its prerequisite
real-user evidence. #34's backup/restore docs are already on main through PR #179.
The earlier #10/#103/#39 and #111/#40/#11 work is also on main.

There are no three eligible, unblocked one-run candidates. Do not substitute Labs,
interop, demand-gated #30, completed main work, or fabricated proof evidence.
Follow the response to this run's scope-unblock question; shortlist three issues
only when a refreshed, approved backlog actually supports that shortlist.

## Waiting on owner

- #44 is ready for review/merge, subject to remote checks; #30 metrics remain
  expressly deferred, not shipped by this branch.
- This run writes `questions/next-mailbox-scope.md` in the external output
  directory. It asks whether to supply new scoped mailbox issues, provide real
  sanitized #101 evidence for #8, or keep implementation stopped. The recommendation
  is to review #44 and wait for evidence of a concrete mailbox blocker.
- No open question was supplied in this run's owner inbox. The new question
  concerns the exhausted next-task backlog, not the resolved #176 selection.
- #8 still needs evidence from two owners and two machines. Local process tests
  cannot satisfy that prerequisite. Stop this run rather than expand scope.

## Learned about the repository

- Mailbox creation, append, and completion insert encrypted notification intent
  alongside their mutation, recipient event, and audit in the same transaction.
  Replays do not add jobs; acceptance/cancellation stay silent.
- Migration `0011_notification_outbox` adds unique source identity, encrypted
  previews, due/lease/terminal state, and partial indexes. It does not backfill jobs
  already lost from the previous in-memory queue.
- Workers claim one job with skip-locked row selection, a fresh UUID token, and
  a 30-second lease. Bounded retries, one persisted Slack 429 retry, fencing,
  safe outcomes, and terminal cleanup are durable database state.
- Slack is an optional at-least-once hint, never pickup or reply evidence. Current
  webhook configuration and its allowlist are checked at send time. Sensitive
  payloads and provider exception text are not logged.
- Worker memory is bounded, not total PostgreSQL backlog. Active jobs are not
  evicted; terminal previews are erased and old terminal rows are batch-cleaned.
- E2E typechecking needs the Relay build before the static production import in
  restart tests. Serial package hooks avoid concurrent protocol output writers.
- This run passes 125 protocol, 393 MCP, 79 database-free Relay, and 438 Node unit
  tests, with expected 274 Relay database and three Node opt-in skips. Integration
  passes 274 tests; mailbox process proofs pass four tests across three files.
- Lint retains three existing unused-suppression warnings. Initial install warns
  about links to not-yet-built Node binaries; subsequent builds and packed smoke
  pass. No source, dependency, workflow, infrastructure, version, or public contract
  changes are made this session. Memory contains no Markdown links.

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
! rg -n '\[[^]]+\]\([^)]+\)' .nightshift/STATE.md .nightshift/JOURNAL.md
git diff --check
git diff --cached --check
```
