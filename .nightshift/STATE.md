# Nightshift state

## Goal as understood

Build verified handoff links through the seven owner-supplied steps while
preserving ordinary mailbox and sovereignty boundaries. The goal changed on
November 7, 2026; it is unchanged in run 42361776481, session 4. Steps 1–5 are
complete in source. Continue with step 6's Slack waiting hint, then step 7's
invite-request measurement and final documentation. Do not create STOP or wait
for manual receiver results.

## Plan

- [x] Read memory/history/instructions/designs, inspect the clean tree, run setup.
- [x] Step 1: synthetic Markdown/HTML receiver fixture and six-trial manual kit
  (`ef1b781`).
- [x] Step 2: RFC 003 narrowly amends exactly four RFC 002 decisions (`9a1b703`).
- [x] Step 3: migration/share tables/external audit actors (`c0048d5`) and
  admin-attested invite domains/trusted redemption (`3f8f1a4`).
- [x] Step 4: capability create/read, held JSON/form replies, revocation, expiry,
  and in-process retention (`8154962`).
- [x] Step 5: private inspection/public answers (`d742ace`), MCP/CLI previews and
  secret scanning (`f461124`), interactive owner release and provenance-marked
  durable external inbox replay (`1268207`). No MCP release tool exists.
- [ ] Step 6 remaining: content-free Slack waiting hints. Public IP/link admission,
  invite-redeem limits, CSP/escaping/noindex/random delimiters, log redaction,
  byte limits, and aggregate answer bounds are implemented.
- [ ] Step 7 remaining: invite-request producer and final end-to-end documentation.
  Create/fetch/reply/release/answer facts are wired. Architecture/provenance,
  HLD/LLD, source-client/API and MCP docs truthfully describe release and replay.

## Next step

Read fresh feedback first. Implement the content-free "reply waiting" Slack hint
through the sender's existing configured webhook. Trace the encrypted webhook,
validation, transport, dispatcher, and outbox before choosing the smallest safe
implementation. Do not fabricate a handoff or teammate identity: the existing
ordinary notification outbox requires a handoff reference. Preserve ordinary
durable notification behavior, keep share hints optional, avoid capability URLs,
reply bodies or claimed authors in Slack/logs, and never imply processing.

Then implement a minimal explicit invite-request measurement surface without
receiver accounts, signup, email or external account mutations. Record a real
request fact, not an inferred request from a fetch. Finish truthful documentation
and focused/cross-process tests, run all gates, and commit each concern separately.

The six actual Claude Code/Codex/Cursor trials in
`docs/handoff-links-receiver-test.md` remain not run. The kit is ready. Synthetic
stdio/terminal tests do not establish real receiver compatibility or delivery.

## Waiting on owner

No blocking question. Manual receiver results are explicitly nonblocking.

The unchanged merge guard denies migrations and does not allow the integration
runner script. The approved goal requires these paths: flag direct repository
review rather than reply-only merge. No credentials or external systems are
needed to continue local implementation.

## Learned about the repository

- Separate share tables preserve ordinary participant-only two-party handoffs.
  Owner routes require active agent bearers, not Node credentials. Capabilities
  allow public read/reply only; public content never includes external replies.
- New private routes: `POST /shares/replies/:replyId/release` requires strict JSON
  `confirmation: release_to_inbox`; `GET /shares/inbox` returns release-event
  cursor-ordered external replies with `after_cursor`, `limit` (1–10), optional
  release-time `since`, stable `next_cursor`, and `has_more`.
- Release is sender-owned, idempotent by reply ID, and transactionally writes
  release state, one `reply.released` event and audit. Sender lifecycle locking
  serializes allocation and inbox reads; a slow lower cursor cannot be skipped.
  There are no fabricated messages, agents, handoffs or mailbox events.
- CLI `share release <reply-id>` requires stdin/stdout/stderr TTYs and exact typed
  `release <reply-id>`. Wrong input/EOF cancels; no flags or MCP tool bypass it.
  Each retry invocation prompts again. The Relay verifies the sender bearer,
  not a human at a terminal; keep that authentication limitation explicit.
- `check_inbox` retains ordinary items and adds `external_replies`,
  `external_next_cursor`, `external_has_more`, and input `external_after_cursor`.
  Default external page is ten, capped by the smaller requested limit. Status
  filters apply only to ordinary handoffs; since filters external release time.
  Text and typed records retain untrusted/data-only `external_unverified`.
- Inbox reads are replayable, not processing acknowledgements. Omitted cursor
  repeats stable IDs; callers explicitly checkpoint. Shares do not enter the
  ordinary mailbox-event watch feed. Retention leaves nullable body tombstones
  with stable release cursors. No release establishes trust or authority.
- Private inspection/release remains available after expiry/revocation until
  deletion, without reviving public reads/writes. Deleted bodies cannot release.
  Public JSON/form receipts prove storage only and never expose release state,
  including retry after release (`stored`/`replayed`, no misleading `held`).
- Capability IDs are 32 random bytes/43 base64url characters. Limits: ten external
  replies/link, initial plus all sender answers 64 KiB total, each answer/reply
  16 KiB UTF-8. Lifecycle/link locks protect bounds and mutation idempotency.
- Local scans run before previews and publication confirmation, no bypass.
  Preview tokens bind exact operation/content/expiry/link/Relay/sender for ten
  minutes and retain stable UUID mutation keys. MCP keeps 100 process-local
  previews; CLI keeps one private content-free pending file per local config.
- Public IP limits honor normalized XFF-first-position addresses; trusted ingress
  must strip spoofed headers. Limits are per-process, bounded and restart-reset.
  Retention runs at startup/minute in SKIP LOCKED batches, deletes content thirty
  days after expiry, retains facts, and does not accelerate on revocation.
- Company provenance is admin-attested at invite minting, copied on redemption;
  historical/omitted domains stay unknown. External authors stay unverified.
- Final checks: units 125 protocol/501 MCP/97 Relay/438 Node, expected 318 Relay DB
  and three Node skips; serialized integration 318; focused client 117; focused
  share/render 32 before the final concurrency regression (final integration has
  all 25 share plus eight render tests); cross-process tests five. An actual PTY
  proof verified wrong-input cancellation, exact confirmation, and EOF without
  adding any dependency. Three existing lint suppression warnings remain.
- Inherited `ce0b06e` (#44 notification outbox) and `945e9d5` (restart-test build
  ordering) remain outside origin/main. Include both in branch-wide PR text;
  only #44 has an issue close, and its queue metrics remain deferred. This session
  adds no migration, dependency, package version, protected-path or Labs change.
