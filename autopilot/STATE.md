# Autopilot state

Working memory. Rewrite this file at the end of every session.

## Goal as understood

Ship owner-selected core-mailbox issues one at a time with passing checks, then
propose the next candidates. GOALS.md is unchanged. The owner's October 28 reply
on #171, “go ahead with all three”, approved all three previously scoped plans;
they were implemented sequentially, not treated as permission for other work.

Completed in this run:

- #10: `6e7fd2f` — `fix(trust): reject unknown root policy keys`.
- #103: `ad08f1d` — `fix(mailbox): contain notification failures and prove durable replay`.
- #39: `e325dc7` — `feat(cli): add passive stdout mailbox watch`.

#111 remains complete on this branch in `46b6e68` (`fix(roster): honor filters and
add bounded pagination`). It is still ahead of origin/main, so the full-branch PR
closes #111, #10, #103, and #39. #40 and #11 are already on main and must not be
claimed as new branch work. #171's approval is fully acted on and ready for the
workflow's resolution record.

## Plan

- [x] Read memory/history, design sources, repository instructions, and issue snapshot.
- [x] Install locked dependencies and migrate the disposable test database.
- [x] Implement #10's strict root policy, generated-file/nested-acceptance and doctor regressions.
- [x] Run #10's focused and shared checks; commit its isolated change.
- [x] Run existing #103 client/provenance and Relay integration tests before adding proofs.
- [x] Map all nine #103 cases to existing evidence and fill only actual gaps.
- [x] Prove committed-send restart, offline ordered retrieval/reply, and lost-response retry.
- [x] Cover non-participant mutations, accepted/terminal ownership, and notification faults.
- [x] Fix the exposed post-commit notification enqueue exception; rerun the failing proof.
- [x] Run #103's shared, integration, focused process, and full e2e checks; commit.
- [x] Implement #39's separate passive stdout metadata observer and exclusive replay contract.
- [x] Prove CLI output isolation, unchanged local files/binding requirements, reconnect and auth teardown.
- [x] Run a real Relay replay/restart smoke plus focused/shared/integration/full e2e checks; commit.
- [x] Re-evaluate the remaining eligible backlog and prepare a prerequisite question.
- [x] Update run memory and full-branch PR/summary outputs; stop awaiting owner direction.
- [ ] Receive a next selection with its prerequisites satisfied before implementing more product work.

## Next step

Read the owner inbox and the next issue snapshot for a reply to this run's external
`questions/next-core-mailbox-prerequisite.md`. The workflow assigns its issue number;
do not duplicate the question. Recheck history and origin/main before closure claims.
Start any next session with the required dependency install and test-DB migration.

The supplied snapshot does not contain three remaining unblocked one-run candidates.
Do not pretend #44 is a small complete issue, substitute local processes for #8's
human proof, or substitute native Postgres for #34's required Compose restoration.
An updated, owner-scoped backlog may provide better candidates.

## Waiting on owner

The question lists the only three remaining eligible core-mailbox entries with
plans, files, verification, and explicit blockers:

- #34 (recommended): provide a usable disposable Docker environment and select the
  Compose backup/restore guide. Ordinary daemon access fails; passwordless sudo also
  fails. No restore was attempted or claimed.
- #44: split/revise the larger outbox issue into an honest bounded mailbox-only
  issue before selecting it. Its metrics acceptance depends on demand-gated #30;
  do not expand that work without approval. A migration requires owner GitHub review.
- #8: supply actual passing #101 two-owner/two-machine evidence and consent/location
  for the recording. This unattended runner cannot invent the prerequisites.

Alternatively, the owner can add three smaller eligible core-mailbox issues.
There is no remaining blocker on #171 or the three approved implementations.

## Learned about this repository

- This session started clean on `autopilot` at `62adaf9`; #111 remained branch-only.
  The session adds no dependency, migration, release/version, runtime configuration,
  infrastructure, or workflow change.
- Trust root keys are now exactly version/teammates/unknown_teammates/blocked/defaults.
  Unknown root keys return existing invalid policy, not a warning. Generated and
  missing-file policies still load; nested acceptance, block precedence, and
  exact-sender-only pickup are unchanged. Doctor reports broken policy, MCP uses its
  existing safe fallback, and attention watch refuses invalid policy.
- #103's process fixture uses real Relay/Postgres/MCP, preserving database and
  secrets through `TestRelay.restart()`. The lost-response fixture consumes a real
  committed append response before throwing; retry must reuse its envelope/key and
  return one original message/sequence. Offline retrieval/reply needs no acceptance.
- The previous non-participant read/append test only checked read. It now checks
  append/accept/complete/cancel and no content disclosure. Accepted re-accept is
  idempotent; terminal state and owner-first transition denials preserve audit/events.
- A throwing notification sink previously returned HTTP 500 after commit. The shared
  helper now contains synchronous enqueue exceptions and logs safe references only.
  Real zero-capacity dispatcher drops and throwing-sink tests prove create/append
  receipts and recipient replay survive notification loss. This is not an outbox.
- `docs/mailbox-reliability.md` maps all nine #103 cases and records proof limits.
  Local response/notification injections and Relay restart are not network-partition,
  power-loss, Compose restore, actual Slack, or two-owner/machine evidence.
- `watch --stdout` only reads mailbox replay/SSE, emits explicit metadata references
  for thread.created/message.appended, and silently advances over lifecycle events.
  It never loads trust, invokes a runtime/MCP tool, changes bindings, or reads/writes
  attention checkpoints or locks. CLI tests snapshot config/trust/state byte-for-byte.
- Stdout replay starts at the beginning unless an exclusive positive decimal bigint
  is supplied; pages are 100 events. Cursors are in-memory only. Duplicates are
  suppressed within a process; restart without an externally saved cursor repeats.
  Permanent client/auth errors fail, and reconnect replays only after stream readiness.
- CAC automatically coerces numeric-looking arguments, including lossy bigint values
  and leading-zero strings. The CLI reads the raw cursor argument before Zod
  validation, supports the equals form, and rejects duplicate cursor flags.
- Passive diagnostics are content-free stderr; stdout is NDJSON only. Output failures
  stop the observer. Aborted --once does not claim completion. CLI cleanup aborts an
  open SSE on fatal ready-replay authentication failure, without changing default watch.
- Final shared gates pass; Relay integration is 235 passed; full e2e is 13 passed
  with one normal opt-in skip. The unit command explicitly unsets both database URL
  variables (235 DB cases and three opt-in Node cases skip normally). Four existing
  unused-suppression lint warnings remain; none were changed.
- Docker Compose v2.38.2 is installed, but daemon access is denied and `sudo -n`
  needs a password. Do not repair host/workflow permissions or claim Compose proof.
