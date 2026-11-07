# Nightshift state

## Goal as understood

The owner changed the goal from the exhausted `core-mailbox` issue inventory to
verified handoff links on November 7, 2026. Implement the seven supplied steps in
order, with passing checks and small commits. Receiver accounts, self-serve
signup, email, signing, live sessions, wake-up, Missions/Node, federation, and
execution remain out of scope. Nothing in a link grants sender-side authority.

Run 42361776481, session 1, completes steps 1–3. Production link routes and client
tools are not implemented yet. Continue this run; do not create STOP or wait for
manual receiver results.

## Plan

- [x] Read prior memory, history, instructions, and relevant designs; run harness
  setup and inspect the initially clean working tree.
- [x] Step 1: static Markdown/HTML, runnable synthetic receiver server, focused
  tests, and the six-trial 15-minute manual receiver matrix (`ef1b781`).
- [x] Step 2: RFC 003 narrowly amends RFC 002 with the four approved exceptions;
  ordinary mailbox promises remain (`9a1b703`).
- [x] Step 3: share tables/migration and external audit actors (`c0048d5`), plus
  admin-attested invite domains copied during redemption (`3f8f1a4`).
- [ ] Step 4: production capability reads, held JSON/form replies, revocation,
  expiry, and the in-process retention sweep.
- [ ] Step 5: preview/secret-scan MCP and CLI creation/answers, interactive owner
  release, and `external_unverified` inbox delivery.
- [ ] Step 6: production byte/admission limits, IP/link rate limiting and invite
  redemption, secure rendering/instructions, and content-free Slack hints.
- [ ] Step 7: truthful architecture/provenance/MCP documentation and event producers.

## Next step

Read any new feedback first, then implement step 4 against the separate share
tables. Trace sender-authenticated creation/revocation and public reads/replies
together. Include necessary safety at the edge before mounting a public route;
do not land an unsafe intermediate implementation while deferring step 6.

`docs/handoff-links-receiver-test.md` is ready for the owner. Its mock receipts
prove only a fixture POST, not real-client compatibility, durability, or release.
Keep the six real-client trials marked not run until actual evidence arrives.

## Waiting on owner

No blocking question. Receiver test results are explicitly not a prerequisite for
further work. The previous next-mailbox-scope request is superseded by the supplied
new goal; do not resurrect the old backlog-selection loop.

The existing merge path guard denies database migrations and does not allow the
integration-runner script. This owner-approved goal explicitly requires migrations;
implement them, but leave the guard unchanged and note that direct repository review
is needed rather than reply-only merge. No new credentials or external systems are
needed to continue local implementation.

## Learned about the repository

- Share correspondence is separate from ordinary two-party `handoffs`/`messages`.
  No public route or share event producer is mounted yet.
- `share_links.id` is an internal UUID for foreign keys/audit; `public_id` is a
  unique 43-character base64url capability. Creation must generate 32 random bytes;
  the schema checks shape, not entropy. Creation keys are sender-scoped.
- Links default to seven days and cap expiry at thirty days. Nullable content and
  `content_deleted_at` support deletion while retaining content-free history.
- Replies/answers have one per-link sequence, `author_kind` sender/external,
  `channel` api/form, author-scoped idempotency keys, and explicit release fields.
  The schema checks release shape, not authenticated owner authority.
- DB byte caps cover initial link content (64 KiB) and each reply/answer (16 KiB).
  Aggregate public content, ten external replies, lifecycle, retention, and
  authorization must still be enforced transactionally by production services.
- `share_events` supports the six requested kinds, non-agent actor identity,
  exact reply/link foreign keys, unique creation/reply mutation facts, and repeated
  fetches. Metadata must remain content-free; do not put URLs or bodies there.
- Invite `company_domain` is optional, normalized ASCII DNS/punycode, admin-audited
  at minting, and copied from the stored row during locked redemption. Existing
  agents/invites and omitted domains remain NULL; never infer from email/handle.
  Signed tokens and existing response shapes are unchanged. Receiver assertions
  cannot set provenance. The new optional CLI flag is source-only, not published.
- Invite mint audit now identifies the authenticated admin, not the named inviter.
  Agent self-audit remains actor-scoped; it does not expose admin mint records.
- The global logger currently logs raw request paths and unhandled errors. Public
  capability routes require path/error redaction so IDs, URLs, and bodies never leak.
- Existing mailbox events require authenticated agent actors and handoff references;
  do not fabricate an agent identity to fit an external reply into that ledger.
  Existing notification-outbox rows also require a handoff; Slack is only a hint.
- All six checks pass after every product concern. Final units: 125 protocol,
  401 MCP, 82 database-free Relay, 438 Node; expected 292 Relay DB/three Node skips.
  Integration passes 292 tests. The inherited mailbox/restart proofs pass four.
  Lint retains three existing unused-suppression warnings. No dependencies changed.
- The inherited branch still contains `ce0b06e` (#44 notification outbox) and
  `945e9d5` (restart-test typecheck ordering) outside `origin/main`. Include them
  in branch-wide PR text; only #44 is closed, and its metrics remain deferred.
