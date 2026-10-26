# Autopilot state

Working memory. Rewrite this file at the end of each session.

## Goal as understood

Ship core-mailbox issues one at a time, implementing only the owner's selection
and proposing three candidates whenever no selected issue remains in progress.
The goal is unchanged. The owner's 2026-10-26 reply “okay, go ahead” on #161
approves that question's recommended #40 safe thread-export plan.

**#40 is complete and verified on the autopilot branch in `b95dc2b`
(`feat(cli): add safe markdown thread export`).** It is not on main yet. The PR
description must include `Closes #40`; do not claim it is released or merged.
The choice question #161 is resolved and listed in the external resolved.txt.
No other product issue was implemented.

## Plan

- [x] Read memory, history, issue snapshot, design sources, and applicable instructions.
- [x] Install locked dependencies and migrate the local test database.
- [x] Act on approval of the recommended #40 plan in #161.
- [x] Trace tasks/get producer, participant authorization, viewThread, provenance, CLI, and tests.
- [x] Add export-thread with deterministic safe rendering and exclusive private writes.
- [x] Add focused renderer/command/built-CLI regressions and truthful usage documentation.
- [x] Pass shared lint/typecheck/build/unit gates and commit the product change.
- [x] Pass canonical Relay integration and the existing local handoff roundtrip e2e.
- [x] Propose the next three candidates: #111 (recommended), #10, and #103.
- [ ] Receive the owner's next selection; implement only that issue.

## Next step

Read the owner inbox for the choice requested in
`questions/choose-after-thread-export.md`. Recheck current main and the issue
snapshot before starting. If #10 is chosen, require approval of strict-root
rejection rather than warning-only validation. If #103 is chosen, first map the
nine required cases to existing tests, then add only uncovered mailbox proof.
Do not implement another issue just because #40 is finished.

Stop this run while waiting for the next selection. The external PR description
covers the entire branch relative to origin/main, including existing run memory.
The owner can review #40 independently of choosing the next issue.

## Waiting on owner

Choose **#111, #10, or #103** in the new external candidate question. The workflow
assigns its issue number; none is known in this session. The question includes
plans, paths, contract choices, exact checks, and the recommendation. Do not
duplicate it or treat a recommendation as approval. #10 and #103 lack help-wanted
labels; selection must approve the stated narrow plans. #161 is resolved, not a
still-pending choice.

## Learned about this repository

- This run starts clean on autopilot at `382be9f`, with only previous run-memory
  updates ahead of origin/main (`ec6ef7c`). #11 remains merged on main through
  `119d756` / #150. #40 is newly complete on this branch, not main.
- Export uses local config and the existing A2A client, calling only tasks/get
  through viewThread. Relay getHandoff authorizes sender/recipient before reading
  messages and does not change lifecycle or read state. The pre-existing
  viewThread header claims access audit; getHandoff has no such audit write.
  No new access-audit claim or Relay mutation was introduced.
- Relay already returns created_at. viewThread now preserves it optionally for
  backward compatibility; export requires the creation field and recipient and
  rejects a mismatched thread ID. Existing provenance and Relay-metadata stripping
  remain the shared representation, including custom typed artifacts.
- All archive values are sorted-key indented JSON, never dynamic headings or
  executable fences. Embedded Markdown, HTML, backticks, and CR/LF remain data.
  Messages are sorted by sequence_no without mutating the input. Completion and
  cancellation are explicit. No wall-clock export timestamp spoils determinism.
- writePrivateArchive uses exclusive wx creation and file-handle chmod to enforce
  mode 0600 even with a restrictive umask. Existing files, directories, and
  symlinks are refused. It does not create parent directories. Fetch failures
  write no archive; errors omit raw response bodies/config contents/credentials.
  Authored message/artifact secrets are deliberately not redacted.
- #111 still has the real forwarded-but-ignored filter gap. Preserve legacy
  no-filter callers, active-only roster selection, current lack of block-list
  discovery filtering, and REST GET /agents. Inspect query plans before indexes.
- #10 still uses passthrough at the root, and its warning-titled test accepts extra
  keys without any warning. Strict root rejection is a compatibility change;
  nested schemas, safe MCP fallback, and exact-sender pickup must not broaden.
- #103 is now the third candidate after closer gap review. Existing Relay tests
  cover replay, block fencing, and many lifecycle gates; MCP and handoff e2e prove
  structured provenance. TestRelay.restart preserves secrets/database. Missing
  process restart/offline/lost-response and notification-loss-plus-retrieval proof
  can use that harness. Do not replace mailbox evidence with Labs fault tests.
- #34 remains blocked for candidacy: Compose exists but Docker daemon socket
  access is denied. Native Postgres is not its required Compose restore proof.
  #39 overlaps shipped watch and needs a distinct contract; #44 is a larger
  notification architecture; #8 needs people/machines and prerequisite proof.
- Final checks pass: lint (four existing unused-suppression warnings), recursive
  typecheck/build, unit suites (protocol 125, MCP 315, Relay 77, Node 438), canonical
  Relay integration (180), and existing handoff roundtrip e2e (1). Relay database
  tests and three Node opt-in tests skip normally in the database-free unit gate.
  The export additions contain 49 focused tests (32 renderer/command, 17 built CLI).
- Build before built-CLI tests to avoid describeIfBuilt skips. Unset both Relay
  database variables for the unit command. Keep integration/e2e database variables
  scoped to those subprocesses; use the canonical sequential integration runner.
  No dependencies, migrations, runtime configuration, or workflows changed.
