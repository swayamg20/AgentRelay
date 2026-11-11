# Nightshift state

## Goal as understood

Build verified handoff links through the seven owner-supplied steps, preserving
ordinary mailbox and sovereignty boundaries. The goal is unchanged in run
43010550235. All seven implementation steps landed in merge commit 1a265fb
(`Merge pull request #178 from swayamg20/nightshift`). At session start, HEAD
and origin/main were identical. No new product change is needed or authorized.
The receiver test kit is ready; real Claude Code/Codex/Cursor trials remain
unrun and explicitly nonblocking. Publication and deployment are not authorized.

## Plan

- [x] Read memory and history; run the required setup from the repository root.
- [x] Confirm the full seven-step implementation is already on origin/main.
- [x] Step 1: synthetic Markdown/HTML receiver fixture and manual six-trial kit.
- [x] Step 2: RFC 003 narrowly amends exactly four RFC 002 decisions.
- [x] Step 3: share tables, non-agent audit, and admin-attested invite domains.
- [x] Step 4: capability routes, held replies, revocation, expiry, and retention.
- [x] Step 5: previewed/scanned MCP and CLI publication, interactive owner
  release, and external-unverified inbox replay.
- [x] Step 6: admission limits, safe rendering, invite-redeem rate limiting,
  and content-free Slack waiting hints.
- [x] Step 7: measurement events and current source/API/provenance documentation.
- [x] Finish all six canonical checks; units run without database variables.
- [x] Commit refreshed memory and write external summary, PR description,
  STOP, and IDLE.

## Next step

The goal is complete and its implementation is merged. On a future run, read
changed goals, concrete PR findings, and fresh owner replies first. Otherwise
remain idle: do not expand the completed goal or repeat memory-only sessions. The owner may run
`docs/handoff-links-receiver-test.md`; do not infer real-client compatibility
from automated tests.

## Waiting on owner

No open questions and no PR feedback or owner replies are supplied this run.
The preceding implementation PR is merged according to local Git history.
Historical scanner and CI notes remain in JOURNAL.md, but are not evidence of a
current blocker. Do not repeat previously answered questions, rewrite history,
call GitHub, or assert external scanner/check status. Further implementation
requires a changed owner goal, not a decision request from this completed goal.

## Verification for run 43010550235, session 1

- `bash "$NIGHTSHIFT_HARNESS/setup-install.sh"`: pass.
- `pnpm install --frozen-lockfile`: pass; prebuild e2e CLI bin warnings are
  followed by successful builds.
- `pnpm lint`: pass with three existing unused-suppression warnings.
- `pnpm -r typecheck` and `pnpm -r build`: pass.
- `env -u RELAY_TEST_DATABASE_URL -u RELAY_DATABASE_URL pnpm --filter
  @agentrelay/protocol --filter relay --filter agentrelay-mcp --filter
  agentrelay-node test`: pass. Protocol 125, MCP 501, Relay 98, Node 438;
  expected skips: Relay 337 database tests and Node three opt-in tests.
- `RELAY_TEST_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay
  RELAY_TEST_TRUNCATE_VIA_PSQL=1 pnpm --filter relay test:integration`: pass,
  337 tests, zero failures.
- `git diff --check`: pass. Memory has no new Markdown links.
- No source changes, external mutations, or manual receiver trials.

## Repository facts

- Code/tests define current behavior; docs explain existing ownership boundaries.
- Ordinary mailbox threads remain participant-only and two-party. Link content
  is explicitly published sender text; external replies never render publicly.
- Owner release does not verify an author or grant authority. Released replies
  retain `external_unverified` provenance; no MCP release tool exists.
- PostgreSQL on port 5433 supports sequential integration checks; database
  variables must be unset for the canonical unit command.
- Only STATE.md and JOURNAL.md may be changed under .nightshift. Do not edit
  protected workflows, merge settings, package versions, or release entries.
