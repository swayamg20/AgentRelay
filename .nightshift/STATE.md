# Nightshift state

Working memory. Rewrite at the end of each session; history and active tests take
precedence over notes.

## Goal as understood

Ship owner-chosen `core-mailbox` issues, with small concern-specific commits and
passing checks, then request the next selection. The goal is unchanged. The owner's
October 28, 2026 reply on #171, “go ahead with all three,” approves all three scoped
plans by reference, including #10 strict-root rejection and #39's independent
passive stdout mode/replay contract. This supersedes the previous waiting state
and the usual single-selection limit for these three issues only.

All three selected issues are complete and verified on `nightshift`:

- #10: `46bea8d` — `fix(trust): reject unknown root policy keys`.
- #103: `e34465a` — `test(mailbox): prove retry and restart reliability`.
- #39: `be91a0f` — `feat(cli): add passive stdout mailbox observation`.

The session started clean at `8ab55ae`. #111, #40, and #11 are already on main;
they are not new changes on this branch. The PR must use `Closes #10`,
`Closes #103`, and `Closes #39`, not closure claims for prior main work.

## Plan

- [x] Read state, recent journal/history, repository instructions, design sources,
  issue snapshot, and the owner's scope approval.
- [x] Run harness setup/locked installation and prepare the disposable database.
- [x] Implement #10's root-only strict schema and focused loader/doctor/watcher
  regressions; preserve nested acceptance, generated files, fallback, and consent.
- [x] Verify and commit #10 separately.
- [x] Run existing MCP and Relay evidence before adding #103 tests; map all nine
  cases and fill only process, non-participant, terminal/ownership, and notification
  loss gaps.
- [x] Add the reliability evidence record and README link; verify and commit #103.
- [x] Implement #39's separate metadata-only stdout observer with Zod edge checks,
  bounded replay, exclusive cursors, in-memory duplicate suppression, reconnect,
  safe diagnostics, and no attention checkpoint/runtime side effects.
- [x] Verify #39's focused CLI/client/watcher contracts and disposable real Relay
  restart/reconnect smoke; finish shared gates/full e2e and commit separately.
- [x] Review the remaining eligible backlog; prepare the conditional three-issue
  next-choice question without inventing runnable scope or implementing it.
- [x] Record answered #171 for resolution and write external summary/STOP outputs.
- [x] Update memory and the full-branch PR description; leave the working tree clean.
- [ ] Receive the next owner selection with any required access/evidence/scope.

## Next step

Read the owner inbox and refreshed issue snapshot. The next-choice question is
`questions/next-mailbox-prerequisites.md` in the external run output; the workflow
assigns its issue number. Do not duplicate it or mistake a recommendation for
approval. Do not implement anything beyond #10/#103/#39 without a new selection.
Recheck origin/main/history before making closure claims.

The eligible non-epic backlog currently contains only #34, #44, and #8. There is
no honest three-candidate, unconditionally one-run-ready shortlist. The question
lists all three with plans, files, verification, and prerequisites, recommends
unblocking #34, and requests another small owner-scoped mailbox issue if none is
ready. Epics, Labs, demand-gated work, non-mailbox-labelled interop issues, and
completed main work stay excluded.

## Waiting on owner

- #171 is answered; external `resolved.txt` records 171. It is no longer a blocker.
- Select the next issue through the newly prepared question:
  - #34 requires a disposable Docker-capable environment/approved daemon access.
    Ordinary Docker access is denied; noninteractive sudo requires a password.
    Native job Postgres is not the required Compose backup/restore proof.
  - #44 needs bounded outbox scope approval and a decision on its #30 metrics
    dependency, which is demand-gated and excluded. Do not silently omit criteria
    or close the full issue for a partial outbox.
  - #8 needs actual redacted #101 prerequisite evidence and two owners/machines;
    local process tests cannot certify that proof.

## Learned about the repository

- Trust root keys are now exactly `version`, `teammates`, `unknown_teammates`,
  `blocked`, and `defaults`. Unknown roots return existing `invalid` policy,
  doctor reports broken trust, MCP retains safe fallback, and attention watch
  refuses pickup without checkpointing. Nested schemas and trust precedence are
  unchanged; pickup is still exact-sender consent, never inherited.
- #103's real-process proof preserves Postgres and Relay secrets through
  `TestRelay.restart()`. It retries creation after restart, starts receiver MCP
  only after three messages commit offline, observes ordered provenance-marked
  retrieval, and proves a same-thread reply as sequence 4.
- The lost-append-response transport consumes the real committed HTTP response,
  independently observes the message through MCP, withholds the response, and
  verifies identical serialized automatic retries plus stable receipt/data/event
  count after another restart. Its fault flag prevents retry logic from hiding
  failed assertions inside the injected transport.
- Notification evidence discards actual handoff/append enqueue jobs and replaces
  the HTTP app before retrieval. This is local loss-boundary proof, not a killed
  Slack worker, remote-provider outage, durable outbox, power-loss, or capacity
  claim. Slack remains process-local best effort.
- Non-participant read/append disclose no result/private content and leave no
  mutation audit. Completed/cancelled tests cover both participants' append and
  all transitions, preserving ownership and unchanged thread/audit/event state.
  Existing block-fence/provenance tests remain the evidence for those rules.
- `watch --stdout` uses only configured bearer metadata replay/SSE reads and emits
  six-field `thread.created`/`message.appended` NDJSON. No body fetch, binding,
  trust read/mutation, runtime enqueue, connector lock, or shared state access
  occurs. Default attention-mode code remains intact apart from CLI option parsing.
- Passive cursors are exclusive positive decimal strings within Postgres bigint
  range. CAC numerically coerces option values, so the CLI preserves the original
  cursor token before Zod validation; max-bigint, exponential/hex/leading-zero,
  duplicate-flag, and `--` separator regressions cover that boundary.
- Replay asks for 100 events per page, advances over filtered lifecycle events
  only in memory, suppresses duplicate cursors, and rejects unordered new events
  before printing. SSE ready/change/resync triggers replay; heartbeat does not
  poll. Reconnect waits for ready before replay, permanent 4xx other than 408/429
  fail, and output/schema failures stop rather than printing unsafe diagnostics.
- Source docs explicitly do not claim the new flag is in published 0.3.0.
  A printed ledger reference is not pickup, model processing, or a reply receipt.
- Run database-mutating integration/e2e/smoke commands serially. Keep both Relay
  database variables unset for unit tests; avoid simultaneous dist writers during
  process tests. Do not use recursive `pnpm -r test`.
- No dependencies, versions, release notes, migrations, workflows, infra, runtime
  activation, or notification architecture changes were made.

## Verification this session

- Harness setup and explicit frozen-lockfile install passed. Initial setup had
  expected unbuilt Node-bin warnings; the final install passed cleanly.
- #10 focused loader/trust mutation/doctor/watcher tests passed: 85 tests.
- Existing MCP client/provenance/tools evidence passed: 39 tests. Focused Relay
  routes passed: 76 tests; focused handoff/reliability e2e passed: 3 tests.
- Final stdout observer/CLI/event-client/existing attention-watcher tests passed:
  59 tests. The external `.mts` real Relay smoke passed ordered replay, exclusive
  cursor, restart/reconnect, duplicate suppression, metadata-only output, clean
  SIGTERM, and unchanged local file hashes/listing.
- All canonical gates passed before each product commit: lint, recursive
  typecheck/build, database-unset protocol/Relay/MCP/Node unit tests, and sequential
  Relay integration. Final units: 125 protocol, 393 MCP, 77 Relay, 438 Node passed;
  233 Relay DB and three Node opt-in tests skipped normally. Integration: 233
  passed. Full e2e: 13 passed, one opt-in test skipped.
- Lint retains four pre-existing unused-suppression warnings. Focused formatting,
  diff/cached diff, and public-document local Markdown-link checks passed.
- Corrected initial doctor regex, route fixture list shape, cursor refinement,
  formatting, and external smoke module-format failures before passing checks;
  no failed implementation or test was committed.
- Exact validation commands and outcomes are in the latest journal entry.

## End-of-session outputs

- External summary and PR description cover all three branch-only product changes.
- External next-choice question covers the only three remaining eligible issues
  conditionally and explains why a ready triple cannot currently be supplied.
- External `resolved.txt` records #171; `STOP` ends this run pending selection.
- Memory commit: `chore(nightshift): update run memory`. No push or GitHub calls.
