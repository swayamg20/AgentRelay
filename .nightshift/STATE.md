# Nightshift state

## Goal as understood

Build verified handoff links through the seven owner-supplied steps, preserving
ordinary mailbox and sovereignty boundaries. The goal changed on November 7,
2026; it is unchanged in run 42361776481, session 2. Steps 1–4 are complete.
Client preview/scanning, owner release, external inbox delivery, sender answers,
Slack waiting hints, and the remaining event producers are not implemented yet.
Continue this run; do not create STOP or wait for manual receiver results.

## Plan

- [x] Read memory/history/instructions/designs, inspect a clean tree, run setup.
- [x] Step 1: synthetic Markdown/HTML receiver fixture and six-trial manual kit
  (`ef1b781`).
- [x] Step 2: RFC 003 narrowly amends exactly four RFC 002 decisions
  (`9a1b703`).
- [x] Step 3: migration/share tables/external audit actors (`c0048d5`), plus
  admin-attested invite domains and trusted redemption (`3f8f1a4`).
- [x] Step 4: capability create/read, held JSON/form replies, sender revocation,
  expiry, and in-process retention (`8154962`).
- [ ] Step 5: client preview and secret scanning, MCP/CLI share creation/answers,
  interactive-terminal owner release, and `external_unverified` inbox delivery.
- [ ] Step 6: remaining answer/aggregate bounds and content-free Slack waiting
  hints. Public byte/admission limits, CSP/escaping/noindex/random delimiters,
  sensitive log redaction, and invite-redeem rate limiting already land with step 4.
- [ ] Step 7: remaining MCP README/provenance docs and release/answer/invite-request
  producers. Architecture/LLD/API checkpoint docs and create/fetch/reply facts exist.

## Next step

Read fresh feedback first. Implement step 5 in small concerns, starting with the
client-side secret-scan/preview contract and create/answer clients. Trace the Relay
producer through the actual MCP and CLI consumers; do not implicitly serialize an
ordinary thread or publish external replies. Add sender-answer/list-held services,
then the explicit interactive-only release path and separately proven external
inbox provenance. There must be no MCP release tool or model-driven release.

The six real-client trials in `docs/handoff-links-receiver-test.md` remain not run.
The kit is ready; synthetic fixture success is not actual receiver compatibility,
production delivery, owner release, or processing evidence.

## Waiting on owner

No blocking question. Manual receiver results are explicitly nonblocking.

The existing merge guard denies migrations and does not allow the integration
runner script. This approved goal explicitly requires migrations: leave the guard
unchanged and flag direct repository review instead of reply-only merge. No new
credentials or external systems are needed to continue local implementation.

## Learned about the repository

- Separate `share_links`/`share_replies`/`share_events` do not widen ordinary
  two-party mailbox handoffs. Authenticated creation/revocation are `POST /shares`
  and `POST /shares/:id/revoke`. No sender reply-list/release/answer route exists yet.
- `GET /l/:id` and `POST /l/:id/replies` use only the 32-random-byte, 43-character
  base64url capability. The internal UUID is only for DB/audit references. Public
  reads include initial content and stored sender rows, never external replies,
  whether held or released. Unknown/expired/revoked/deleted/disabled-owner links
  give the same unavailable 404. Agent lifecycle and link locks fence public work.
- Link creation requires a sender-scoped UUID key; matching input replays and
  changed content/expiry conflicts. Replies accept optional UUID keys; no key means
  a new submission. Per-link locks protect ten external replies, sequence, replay,
  and mutation/event/audit atomicity. Revoke audits once. Node keys cannot create.
- The current public POST receipt says stored/held and exposes no reply ID or body.
  When implementing release, preserve honest replay semantics without publicly
  leaking release state or claiming a released reply is still held.
- Initial text is 64 KiB, each reply/answer is 16 KiB in UTF-8 bytes. Raw bodies are
  stream-bounded and NUL/empty text is rejected. Aggregate answer admission still
  needs the sender-answer mutation; the read path currently accepts stored sender
  rows, but no production answer producer is mounted.
- Explicit Markdown acceptance wins; positive HTML acceptance selects minimal HTML,
  other clients get Markdown. Relay instructions precede random sender delimiters;
  matching content is rejected, and HTML text/URLs are escaped. Strict CSP, noindex,
  no-referrer, nosniff, no-store, and Vary apply. No content-bearing metadata/previews.
- Rate limits are per process, separate read/write windows: link reads 60/IP and
  120/link/minute; reply attempts 10/IP and 20/link; invite redemption 10/IP. First
  valid forwarded-first-position IP wins, otherwise socket/unknown. IPv6 equivalents,
  mapped IPv4, and zones normalize. Trusted ingress must strip client XFF assertions.
  Each limiter caps memory at 10,000 buckets; this is not a distributed quota.
  Hono wildcard middleware has no named params: bind per-link admission directly
  to named routes so the per-link limit really applies.
- A startup/minute sweep drains locked batches of 100 with SKIP LOCKED. Thirty days
  after expiry it nulls link and all reply/answer bodies, marks deletion, and audits
  as system in one transaction. IDs, ordering, release/idempotency fields, and facts
  remain. Revocation does not accelerate the expiry-based deletion deadline.
- Public/owner-share/invite paths and incoming correlation IDs are redacted from
  request logs; raw share errors and sweep diagnostics are not logged. Share facts
  store neither bodies, capabilities, raw user agents, nor IPs.
- `share_events` now produces `link.created`, `link.fetched` (format/bot hint),
  and `reply.posted` (API/form). Release/answer/invite-request kinds remain only
  schema support. Fetch is not understanding; a storage receipt is not release.
- Company domain is admin-attested at invite minting and copied from the locked
  stored row at redemption; old/omitted domains stay unknown. It is not inferred
  from email/handle or claimed by receivers. Tokens and prior shapes stay compatible.
- Existing mailbox events require agent actors/handoff references: never invent an
  agent to fit an external reply. Existing Slack outbox rows require a handoff;
  do not fabricate one for a link hint. `check_inbox` currently reads tasks/list via
  `mcp-server/src/tools/inbox.ts`; its provenance currently assumes teammates.
- All six final checks pass: units 125 protocol/401 MCP/97 Relay/438 Node, expected
  307 Relay DB and three Node skips; integration 307; inherited process proofs four.
  New focused units pass 15 and share DB tests 14. Three existing lint suppression
  warnings remain. No dependencies, package versions, protected paths, or Labs edits.
- Inherited `ce0b06e` (#44 notification outbox) and `945e9d5` (restart-test build
  ordering) are still outside origin/main. Include both in branch-wide PR text;
  only #44 has an issue close, and its queue metrics remain deferred.
