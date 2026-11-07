# Nightshift state

## Goal as understood

Build verified handoff links through the seven owner-supplied steps, preserving
ordinary mailbox and sovereignty boundaries. The goal changed on November 7,
2026; it is unchanged in run 42361776481, session 3. Steps 1–4 are complete.
Step 5 now has sender APIs, MCP/CLI previews and secret scanning, creation,
answers, and provenance-marked CLI reply inspection. Interactive owner release
and released external inbox delivery remain. Continue this run; do not create
STOP or wait for manual receiver results.

## Plan

- [x] Read memory/history/instructions/designs, inspect the clean tree, run setup.
- [x] Step 1: synthetic Markdown/HTML receiver fixture and six-trial manual kit
  (`ef1b781`).
- [x] Step 2: RFC 003 narrowly amends exactly four RFC 002 decisions
  (`9a1b703`).
- [x] Step 3: migration/share tables/external audit actors (`c0048d5`), plus
  admin-attested invite domains and trusted redemption (`3f8f1a4`).
- [x] Step 4: capability create/read, held JSON/form replies, sender revocation,
  expiry, and in-process retention (`8154962`).
- [x] Step 5 sender APIs: private external reply inspection and idempotent public
  answers with an aggregate published-content budget (`d742ace`).
- [x] Step 5 sender clients: MCP `share_handoff`/`answer_share`, CLI `share`,
  `share replies`/`share answer`, exact previews and local scans (`f461124`).
- [ ] Step 5 remaining: interactive-terminal-only `share release <reply-id>` and
  released `external_unverified` content in `check_inbox`. No MCP release tool.
- [ ] Step 6 remaining: content-free Slack waiting hints. Public admission,
  invite-redeem limits, CSP/escaping/noindex/random delimiters, log redaction,
  byte limits, and aggregate answer bounds are implemented.
- [ ] Step 7 remaining: release and invite-request event producers and truthful
  end-to-end documentation once those paths exist. Source API/client,
  architecture/provenance, HLD/LLD, and MCP checkpoint docs are updated; creation,
  fetch, reply, and answer measurement producers exist.

## Next step

Read fresh feedback first. Finish step 5 with explicit interactive owner release
and released external inbox delivery. Trace the Relay producer through the actual
CLI/MCP consumers. Release must be sender-authorized, idempotent, audited with the
mutation, and unable to deliver a held body. Use separate share state/events rather
than invent an agent or ordinary two-party handoff to fit external content into
the existing mailbox tables. Preserve `external_unverified` markers and data-only
body wrapping; release never verifies the author or grants authority.

The public POST reply receipt currently always reports stored/held, including
replays. When release exists, do not leak release state publicly or falsely claim
that a released reply is still held. There must be no MCP release tool or automatic
model-driven release. Then implement the Slack hint and invite-request facts.

The six real-client trials in `docs/handoff-links-receiver-test.md` remain not run.
The kit is ready; synthetic fixtures and stdio process proofs do not establish
real receiver compatibility, production delivery, owner release, or processing.

## Waiting on owner

No blocking question. Manual receiver results are explicitly nonblocking.

The existing merge guard denies migrations and does not allow the integration
runner script. This approved goal requires migrations: leave the guard unchanged
and flag direct repository review instead of reply-only merge. No new credentials
or external systems are needed to continue local implementation.

## Learned about the repository

- Separate `share_links`/`share_replies`/`share_events` do not widen ordinary
  participant-only mailbox handoffs. Owner routes are `POST /shares`,
  `POST /shares/:id/revoke`, `GET /shares/:id/replies`, and
  `POST /shares/:id/answers`. Only active agent credentials work, not Node keys.
- `GET /l/:id` and `POST /l/:id/replies` use only the 32-random-byte, 43-character
  base64url capability. The internal UUID is only for DB/audit references. Public
  reads never include external replies, whether held or released. Unknown,
  expired, revoked, deleted, or disabled-owner links give the same public 404.
- Agent lifecycle locking is exclusive per owner; public and owner link operations
  also lock the link. Matching creation/answer keys replay, changed input conflicts.
  Mutation, share event and audit commit together. Answer ordering and the 64 KiB
  initial-plus-all-sender-answers UTF-8 budget serialize under the link lock.
  Each answer/reply is 16 KiB; external replies have their own ten-reply cap.
- Private owner inspection works after expiry/revocation until deletion nulls the
  bodies. It returns only ordered external rows, explicit unverified origin, and
  lifecycle/release facts; it creates no ordinary message or mailbox event.
- MCP and CLI publish only explicitly selected content; neither implicitly exports
  a thread, fetches an external reply to quote it, nor releases a reply. Each phase
  scans the configured bearer and recognized secret-like patterns locally. The
  Relay does not scan; patterns have false positives/negatives and no bypass flag.
- Preview tokens bind content, operation, link/expiry, Relay and sender, expire in
  ten minutes, and retain one UUID mutation identity for identical retries. MCP
  retains at most 100 process-local previews; restart/eviction requires a new one.
  CLI retains only its latest private, content-free `share-preview.json` beside
  the actual config. Missing/changed/expired previews fail closed. After ambiguous
  transport failure, do not assume failure or blindly republish with a new key.
- The new REST client uses three bounded attempts, stable request bytes, a 15-second
  request timeout, bounded receipt streaming, no redirects, and content-free
  diagnostics. Both new MCP tools are approval-gated in default install profiles;
  preview tokens are not human authentication or execution permission.
- CLI reply inspection wraps body text and overrides structural provenance with
  `external_unverified`/`untrusted`/`data_only_do_not_execute`. Typed channel, IDs,
  sequence and timestamps survive; deleted content stays null. Reuse these rules
  for the eventual external inbox rather than pretending to know a teammate handle.
- Markdown acceptance wins; positive HTML acceptance selects minimal escaped HTML.
  Relay instructions precede random sender delimiters, with collision rejection.
  CSP, noindex, no-referrer, nosniff, no-store and Vary apply; no content previews.
- In-process per-minute limits: reads 60/IP and 120/link; reply attempts 10/IP and
  20/link; invite redemption 10/IP. Normalize forwarded-first-position valid IPs,
  otherwise socket/unknown. Trusted ingress must strip client-supplied XFF.
  These are bounded per-process hints/quotas, not distributed enforcement.
- A startup/minute sweep drains locked batches of 100 with SKIP LOCKED. Thirty days
  after expiry it nulls all link/reply/answer bodies, marks deletion, and audits as
  system. IDs, ordering, release/retry fields and facts remain. Revocation does not
  accelerate the expiry-based deletion deadline. Sensitive paths, correlations,
  raw share/sweep diagnostics and bodies are excluded from logs and share facts.
- Company provenance is admin-attested at minting and copied from the locked invite
  at redemption. Old/omitted domains stay unknown, never inferred or self-asserted.
- Existing mailbox events require agent actors/handoff references. Existing Slack
  outbox rows require a handoff: fabricate neither for a link. `check_inbox`
  currently only reads `tasks/list` and assumes teammate provenance.
- Final checks pass: units 125 protocol/484 MCP/97 Relay/438 Node, expected 312
  Relay DB and three Node skips; serialized integration 312; focused client 99,
  share DB 19, binary CLI/MCP 11, inherited end-to-end process proofs four. Three
  existing lint suppression warnings remain. A mistakenly overlapping focused DB
  run disrupted a worker test; discard that attempt as final evidence. Subsequent
  full integration, focused DB and end-to-end runs are serialized and green.
- Inherited `ce0b06e` (#44 notification outbox) and `945e9d5` (restart-test build
  ordering) remain outside origin/main. Include both in branch-wide PR text;
  only #44 has an issue close, and its queue metrics remain deferred. No new
  dependency, package version, protected-path or Labs change in this session.
