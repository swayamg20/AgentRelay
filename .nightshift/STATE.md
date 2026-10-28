# Autopilot state

Working memory. Rewrite this file at the end of every session.

## Goal as understood

Ship core-mailbox issues one at a time. Implement only the owner's chosen issue,
then propose three next candidates. The goal is unchanged.

The owner's “go with 111” reply on #165 approved #111. It is now complete and
verified in `46b6e68` (`fix(roster): honor filters and add bounded pagination`).
The next-choice question proposes #10 (recommended, strict-root rejection), #103,
and #39 (explicitly passive stdout metadata mode). No other issue was implemented.

History supersedes the previous memory: #40's safe thread export was merged into
main by #163 (`4acf32d`) before this session. #11 is also already on main.
The current branch's new product change is #111 only; use `Closes #111`, not
`Closes #40`, in its PR description.

## Plan

- [x] Read memory, recent journal/history, design sources, and the issue snapshot.
- [x] Install locked dependencies and migrate the disposable test database.
- [x] Trace roster schemas, MCP forwarding/provenance, Relay dispatch/query, card
  writers, registration, bearer authentication, and existing REST discovery.
- [x] Implement exact AND-combined filters and opt-in bounded keyset pagination.
- [x] Add focused MCP/Relay contract tests and truthful documentation examples.
- [x] Inspect filtered and continuation query plans before considering indexes.
- [x] Run focused tests, shared lint/typecheck/build/unit gates, sequential Relay
  integration, diff checks, and local Markdown-link checks; commit #111.
- [x] Prepare the external next-choice question; resolve the answered #165.
- [x] Update memory and full-branch summary/PR outputs; stop awaiting selection.
- [ ] Receive the next explicit owner selection and implement only that issue.

## Next step

Read the owner inbox and current issue snapshot for a reply to this run's
next-choice question. The workflow assigns its issue number; do not duplicate
the question or treat its recommendation as approval. Recheck origin/main to
avoid stale closure claims. If #10 is selected, require explicit strict-root
rejection approval. If #103 is selected, first map all nine required cases to
existing evidence. If #39 is selected, require approval of the passive stdout
metadata mode and its replay contract, preserving the existing attention watcher.

## Waiting on owner

Choose #10 (strict-root rejection, recommended), #103 (mailbox reliability proof),
or #39 (passive stdout metadata observer). The question is in this run's external
`questions/next-core-mailbox-issue.md`, ready for the workflow to publish.
All three include plans, file scopes, verification, and scope-approval conditions.
#165 is answered and recorded for resolution; it is no longer a blocker.

## Learned about this repository

- This session started clean on `autopilot` at `4acf32d`, with no commits or diff
  ahead of origin/main. Previous #40 work and run memory are already on main.
- Roster discovery is internal mailbox functionality, not A2A v1 discovery.
  It requires an active agent bearer identity and intentionally still includes
  the caller and blocked agents. No tenant or block-list discovery policy was added.
- Registration creates agents/keys, not cards. Missing cards must retain empty
  skills/repositories. Card updates write role to agents.role and skill/repo arrays
  to agent_cards. The new query uses those canonical columns.
- role/skill/repo filters trim the query input, preserve case, match exactly,
  combine with AND, and do not tokenize. Stored card values are not normalized.
  Their bounds are 60/60/200 characters; unknown keys, empty or malformed inputs fail.
- Pagination is opt-in via page: limit 1–200 (default 50), cursor null or a strict
  validated after_handle object. Unique ascending database handle ordering and an
  exclusive greater-than predicate form the keyset. Fetch limit+1 rows to determine
  next_cursor; final/empty pages return null. Without page, retain the full matching
  roster and omit next_cursor. Cursors are positions, not snapshots or permissions;
  reuse the same filters. MCP preserves the cursor and existing roster provenance.
- The 10,000-row rolled-back EXPLAIN fixture used the existing skills GIN index
  for combined filtering and idx_agents_handle for continuation, with card primary
  key lookups. No new index, migration, dependency, or REST change was needed.
  These local query plans are not a production capacity claim.
- #10 still accepts unknown root trust keys without warning; nested acceptance
  and trust decisions must remain unchanged if strict-root rejection is approved.
- #103 has a reusable Relay restart harness. Existing mailbox tests establish many
  retry/authorization/block/lifecycle/provenance cases; process restart and lost
  notification followed by retrieval still need explicit evidence.
- #39's existing watch command is an attention-only Codex connector. A new stdout
  observer must be separately approved, read-only, content-free, and must not write
  its shared connector checkpoints or weaken binding/exact-sender consent.
- #34 remains blocked on Docker socket access: Compose is installed, docker info
  returns permission denied. Native Postgres is not a Compose restore proof.
  #44 is broader architecture; #8/#101 need actual people/machines.

## Verification this session

- Install and migration passed (expected unbuilt Node bin warnings during install).
- Focused MCP schema/tool tests passed: 64 tests. Focused Relay a2a tests passed:
  73 tests. Initial Relay runs exposed missing protocol build output and a fixture
  that updated nonexistent cards; both were corrected before final verification.
- pnpm lint passed with four pre-existing unused-suppression warnings;
  pnpm -r typecheck and pnpm -r build passed. The initial typecheck exposed an
  unchecked final-row access, corrected with a typed last-row guard. Formatting
  differences were corrected and the final focused/full checks passed.
- The canonical database-unset protocol/Relay/MCP/Node unit command passed.
  Relay's 230 database tests skipped there, as intended; Node's three opt-in tests
  also skipped. Canonical sequential Relay integration passed all 230 tests.
- EXPLAIN (ANALYZE, BUFFERS) on disposable fixture data passed and rolled back.
  git diff --check, git diff --cached --check, and local Markdown-link checks passed.
- No e2e, publish, deployment, workflow, dependency, or migration changes were made.
  Exact validation commands and corrected initial failures are in the journal.

## End-of-session outputs

- External summary and PR description cover #111 and use Closes #111 only.
- External resolved.txt records #165; the next-choice question awaits publication.
- External STOP ends this run because another product issue requires selection.
- Commit STATE.md/JOURNAL.md as chore(autopilot): update run memory and leave
  the working tree clean. Do not push or call GitHub.
