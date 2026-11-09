# Nightshift state

## Goal as understood

Build verified handoff links through all seven owner-supplied steps, preserving
ordinary mailbox and sovereignty boundaries. The goal changed on November 7, 2026
and is unchanged in run 42612620144, session 1. All seven steps are complete in
source; all six required local checks pass again. The receiver kit is ready, but
actual Claude Code/Codex/Cursor trials remain unrun and explicitly nonblocking.
No package release, publication, or deployment is part of this work.

The previous run records the owner's November 9 reply resolving question #183:
GitGuardian flagged a synthetic Basic-auth fixture in commit f461124, and the owner
will classify it as a test credential. Current source already constructs the
fixture at runtime from a830510; no deployed credential is involved. This run's
supplied feedback still reports incident 39789810 as triggered and blocking, with
no new owner reply. Preserve that distinction: the source remediation is complete,
but remote classification and merge readiness are not verified here. Do not rewrite
history, weaken secret scanning, change scanner rules, or duplicate question #183.

## Plan

- [x] Read memory/history/instructions, run setup, and inspect the clean tree.
- [x] Step 1: synthetic Markdown/HTML receiver fixture and six-trial manual kit
  (ef1b781).
- [x] Step 2: RFC 003 narrowly amends exactly four RFC 002 decisions (9a1b703).
- [x] Step 3: share tables and non-agent audit actors (c0048d5), admin-attested
  invite domains with unknown historical provenance (3f8f1a4).
- [x] Step 4: durable capability routes, held JSON/form replies, revocation,
  expiry, and retention sweep (8154962).
- [x] Step 5: private reply inspection/public answers (d742ace), previewed and
  secret-scanned MCP/CLI publications (f461124), interactive release and durable
  external inbox replay (1268207).
- [x] Step 6: byte/IP/link admission, invite-redeem limiting, safe rendering/log
  redaction, and content-free Slack waiting hints (06dd901).
- [x] Step 7: all measurement producers, explicit invite interest, and current
  API/architecture/provenance/HLD/LLD/MCP documentation (b312e37).
- [x] Review the repeated historical security finding against the fixed current
  source and prior owner reply, without duplicate resolution or external API calls.
- [x] Rerun all six required checks and validate local documentation targets.
- [x] Update memory and full-branch PR description, commit, and prepare STOP.

## Next step

The product goal is complete in source. Review new owner goals/replies and concrete
PR feedback first in any future run; do not invent additional handoff-link work.
The owner can classify the historical synthetic GitGuardian incident if it remains
triggered and run the 15-minute receiver matrix in
`docs/handoff-links-receiver-test.md` and review the full branch. Real-client
compatibility is not established by repository tests. Stop further sessions in
this run because the requested implementation and ready-to-run kit are complete.

## Waiting on owner

No new implementation decision is needed. The previous run records question #183
as resolved by the owner; only the owner's private incident classification remains.
Current feedback still lists GitGuardian as blocking. Do not duplicate the question,
mark it resolved again without a supplied reply, or claim the remote check is green
or merging is unblocked. Further source edits cannot remove a historical occurrence.
Prior question #184 requested a lint-typecheck diagnostic. No reply is supplied,
and the current feedback lists no lint-typecheck failure. Do not mark #184 resolved
or infer a remote passing rerun; local lint/typecheck/build pass. Without a new
diagnostic, it provides no identified source fix and does not justify more repeated
memory-only sessions or protected-path investigation.
Manual receiver results remain nonblocking. The unchanged merge guard denies
migrations and does not allow integration-runner/e2e package-script paths. This
branch includes those approved implementation paths and needs direct repository
review rather than reply-only merge.

## Verification for run 42612620144, session 1

- Setup script and `pnpm install --frozen-lockfile` pass. Installation warns about
  e2e CLI bins before the Node build; subsequent recursive builds pass.
- `pnpm lint`, `pnpm -r typecheck`, and `pnpm -r build` pass. Lint retains three
  existing unused-suppression warnings; no unrelated cleanup is made.
- Canonical units pass with database variables explicitly unset: protocol 125,
  MCP 501, Relay 98, Node 438. Relay 337 database tests and Node three opt-in tests
  skip as expected; never set database variables for units or run `pnpm -r test`.
- Serialized Relay integration against local Postgres on port 5433 passes all
  337 tests, zero failures, with `RELAY_TEST_TRUNCATE_VIA_PSQL=1`.
- Inline local Markdown-target validation passes: 75 targets across eight current
  handoff-link/design/client documents and both memory files. Post-memory lint,
  local target validation, and whitespace checks pass.
- Earlier export/packed-artifact/Azure compilation and six process regressions
  remain prior-run evidence, not separately rerun here. Neither private remote
  checks nor real receiver-client trials are run. No source changes in this session.
- The canonical MCP units include the runtime-created Basic-auth fixture and its
  secret-blocking/redacted-error assertions. The source remediation remains valid;
  local tests cannot resolve the historical private GitGuardian classification.

## Learned about the repository

- Separate share tables preserve participant-only two-party mailbox handoffs.
  Owner routes require active agent bearers, not Node credentials. Capabilities
  expose only sender-authored content; external replies are never public.
- Creation/answers require exact-content client previews and local secret scanning
  with no bypass. This is not a server scanner or confidentiality guarantee.
  Defaults/limits: seven-day expiry, thirty-day maximum, ten external replies,
  64 KiB initial content plus public answers in aggregate, 16 KiB per reply/answer.
- Private inspection/release works after public expiry/revocation until retention
  deletion. Release is sender-owned, idempotent by reply ID, and writes state,
  event, and audit transactionally. The CLI requires all three terminal streams
  and exact typed confirmation; there is no MCP release tool or bypass flag.
  The Relay authenticates a logical sender bearer, not a human at a terminal.
- `check_inbox` returns only released external replies in a separate array with
  `external_unverified`, untrusted/data-only body and record provenance, stable
  release-event cursors, and explicit caller checkpointing. Reads are replay, not
  processing acknowledgements or ordinary mailbox watch events.
- Retention runs at startup/minute, drains `SKIP LOCKED` batches, and nulls all
  content thirty days after expiry. Content-free IDs, state, cursors, measurement,
  and audit remain. Revocation does not move the deletion deadline.
- Share Slack hints are constant, content-free, best-effort attempts after only
  new committed external replies, bounded to five seconds. They reuse encrypted
  webhooks/Slack allowlisting, but have no durable outbox/retries and may be lost.
- Explicit invite requests collect only a UUID retry key/channel, transactionally
  record interest and external audit, and create no account, invite, credential,
  contact, email, inbox item, or notification. A fetch does not record interest.
- Public admission is bounded, per-process, restart-reset. Reply/invite requests:
  ten/IP/minute, twenty/link/minute; reads: sixty/IP, 120/link; invite redemption:
  ten/IP/minute. Honoring normalized first-position XFF requires trusted ingress
  that strips spoofed forwarding headers.
- Company domains are admin-attested at invite minting and copied on redemption;
  historical/omitted values remain unknown. External authors are never verified.
- Earlier ce0b06e ordinary notification outbox and 945e9d5 restart-test build
  ordering remain outside `origin/main` and must stay in the full-branch PR text.
  Queue metrics through #30 remain deferred; do not claim broader #44 closure.
