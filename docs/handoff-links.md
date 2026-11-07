# Handoff links: sender client and Relay checkpoint

The current source implements the Relay routes below. This is not yet the complete
client product: owner release, released inbox delivery, invite-request measurement, and Slack waiting hints are
not wired. Do not publish sensitive content through this API while expecting a
server-side secret scanner. The approved boundary is
[RFC 003](rfcs/003-verified-handoff-links.md); ordinary mailbox participants, blocks,
and lifecycle remain unchanged.

The [receiver test kit](handoff-links-receiver-test.md) is ready for the owner to
run. Its synthetic replies are not evidence that real clients work with these
routes, or that a reply has been released or processed.

## Sender clients in the current source

Source builds add MCP `share_handoff`, MCP `answer_share`, and `agentrelay share`.
These additions are not a package release or real-receiver compatibility claim.
They publish only explicitly supplied text, never implicitly export a mailbox
thread, read an external reply, or quote it into an answer.

MCP creation first takes `{"content":"selected text","expires_in_days":7}`
and returns the exact preview, expiry, boundary warning, and `preview_token` with
no network mutation. After reviewing it, repeat the exact content and expiry with
that token to publish. `answer_share` uses `link_id` and `content` in the same
two-phase flow. Previews bind operation, link, content, expiry, Relay, and local
sender identity; a changed, absent, or expired preview fails closed. They expire
after ten minutes and survive identical retries with the same UUID mutation key.
The running MCP retains at most 100 previews; restart or eviction requires a new
preview. No MCP release tool exists.

The CLI uses the same exact-content contract across separate invocations:

```bash
agentrelay share --file selected-handoff.md --expires-in-days 7
agentrelay share --file selected-handoff.md --expires-in-days 7 --confirm <preview-token>
agentrelay share replies <link-id>
agentrelay share answer <link-id> --file selected-answer.md
agentrelay share answer <link-id> --file selected-answer.md --confirm <preview-token>
```

Without `--confirm`, creation/answer is preview-only. Source files must be regular
files containing valid bounded UTF-8 text. JSON output escapes control characters;
failed scans/confirmations leave stdout empty and do not publish. The latest CLI
preview per local config replaces the preceding one; pending tokens, a content
digest, timestamp, and retry key are saved beside the config in mode-0600
`share-preview.json`, without content or credentials. Identical confirmation
retries use that saved key. If a preview expires after an ambiguous network
failure, do not assume the operation failed or blindly create a new link.

Both phases scan locally and block on the configured bearer, recognized private
keys, provider/access-token formats, credential-bearing URLs, Slack webhook URLs,
JWT-like tokens, and secret-like assignments. There is no bypass flag. This
pattern scan has false positives and false negatives; arbitrary secrets and
sensitive business content are not guaranteed detectable. Review the exact
preview and remove sensitive content yourself. The Relay does not scan secrets.
Authenticated HTTP requests do not follow redirects or expose response/error
bodies in diagnostics. Default local install profiles approval-gate both new MCP
tools; a preview token is not human authentication or execution permission.

`share replies` preserves typed reply fields and marks external text and records
with origin `external_unverified`, untrusted/data-only policy, and an explicit
text wrapper. Inspection does not release, verify, accept, or deliver a reply to
`check_inbox`. The owner-release command and external inbox path are not wired yet.

## Sender-authenticated API

Agent API keys authenticate these routes. Node credentials do not.

| Method | Path | Input and result |
|---|---|---|
| `POST` | `/shares` | JSON `content`, UUID `idempotency_key`, optional integer `expires_in_days` (default 7, range 1–30). Returns `link_id`, canonical `url`, expiry/revocation/deletion timestamps, and `replayed`. |
| `POST` | `/shares/:id/revoke` | No body. Only the sender may revoke. Returns lifecycle timestamps and `replayed`; repeated revocation adds no audit entry. |
| `GET` | `/shares/:id/replies` | Sender-only ordered external replies, with IDs, channel, nullable content, creation/release timestamps, and origin `external_unverified`. Inspection does not release or verify a reply. |
| `POST` | `/shares/:id/answers` | JSON `content` and UUID `idempotency_key`. Publishes a sender answer, returning `answer_id`, `link_id`, sequence, creation timestamp, and `replayed` (201 new, 200 identical retry, 409 changed-key input). |

Creation returns 201, or 200 for an identical sender-scoped retry. Changed content
or expiry with the same key returns 409, rather than republishing a changed link.
Initial content is capped at 65,536 UTF-8 bytes. Empty/NUL text, unknown fields, and
invalid keys/expiry are rejected. Request bodies are stream-bounded independently
of `Content-Length`. The link capability is 32 random bytes encoded as 43 base64url
characters, distinct from the internal database UUID. Capability URLs and content
must be treated as sensitive; forwarding the URL forwards its read/reply power.

Answers require an active sender-owned link, are capped at 16,384 UTF-8 bytes each,
and share a 65,536-byte aggregate published-content budget with the initial text.
Per-link locking protects ordering, idempotency, and that budget under contention.
External replies do not consume the published budget and are never implicitly
quoted in answers. Sender inspection remains available after expiry/revocation;
after retention deletion, reply bodies are `null`. No inspection creates ordinary
messages or mailbox events. Clients must provenance-mark external text before
returning it to a local agent.

## Public receiver API

`GET /l/:id` needs only the capability. Explicit `Accept: text/markdown` wins;
otherwise a positive `text/html` acceptance selects minimal HTML, and other clients
(including curl's `*/*`) receive Markdown. Both formats show Relay instructions
first, then only sender-authored content and any stored sender-authored answers
inside a random per-response delimiter. Content containing that delimiter is
rejected. External replies are never included, even if already released. A fetch is
not evidence of agent pickup, understanding, processing, or consent.

The instructions distinguish unknown from admin-attested company-domain provenance.
Attestation is not cryptographic verification, external-author verification, trust,
or execution authority. HTML escapes text rather than rendering sender Markdown.
There are no scripts, external assets, Open Graph previews, or content-bearing meta
tags. Responses use strict CSP, `X-Robots-Tag: noindex`, `nosniff`, `no-referrer`,
`Cache-Control: no-store`, and `Vary: Accept`. These headers are not access control.

`POST /l/:id/replies` accepts JSON `{"content":"reply"}`. An optional UUID
`idempotency_key` makes an identical retry return 200 without another mutation;
changed content or channel returns 409. Without a key each POST is a new submission.
The HTML page also provides a URL-encoded fallback form with a generated retry key.
Duplicate form fields and all unknown payload fields are rejected. Replies are
capped at 16,384 UTF-8 bytes; at most ten external replies can be stored on one link,
including concurrent submissions. Retrying an existing key at the cap still works.

A new reply returns 201 and a content-free storage/held receipt, not a reply ID or
any other reply's content. It is stored outside ordinary messages and mailbox
events. There is no public reply enumeration or owner-release route at this
checkpoint. Nothing in a link or reply authorizes local or sender-side execution.

Expired, revoked, deleted, unknown, or disabled-sender links return an unavailable
404 for both reads and submissions. Sender disablement and link revocation fence
public operations through the same transaction locks used for creation. Link
revocation is permanent; key rotation is not link revocation.

## Admission, retention, and facts

The in-process fixed-window limits are separate for reads and writes:

| Scope | Per client IP per minute | Per link per minute |
|---|---|---|
| Link reads | 60 | 120 |
| Link reply attempts | 10 | 20 |
| Invite redemption attempts | 10 | not applicable |

Rejected attempts count toward admission. A rate rejection returns 429 with
`Retry-After: 60`. The first valid IP in `X-Forwarded-For`'s first position is used;
an invalid/missing first value falls back to the socket. IPv6 equivalents and mapped
IPv4 normalize to one bucket. Deploy behind a proxy that strips untrusted forwarded
headers and writes its own: this Relay honors that header and cannot authenticate
an arbitrary client's assertion. Limits are bounded to 10,000 buckets per limiter,
reset on process restart, and are not a distributed quota across Relay replicas.
They do not use the legacy `RELAY_RATE_LIMIT_RPS` configuration value.

Each Relay process runs a retention sweep at startup and every minute. It claims
expired links in batches of 100 with `SKIP LOCKED`, and drains complete batches.
Thirty days after expiry it transactionally nulls initial content and all reply/
answer bodies, marks deletion, and writes a system audit fact. Link/reply IDs,
ordering, release state, idempotency keys, and content-free measurement/audit remain.
Revocation does not move the expiry-based deletion deadline earlier. When a process
is down, deletion resumes at its next sweep; backups have their own retention.

Creation, reply, and answer mutations commit with their audit and measurement facts;
revocation commits with audit. `share_events` currently emits `link.created`,
`link.fetched` (HTML/Markdown and a known-bot user-agent hint), `reply.posted`
(API/form), and `answer.posted`. Raw user agents, IPs, bodies, and capability URLs are not recorded in
these facts. Sensitive route paths, caller-supplied request IDs, and raw failure
diagnostics are excluded from request logs. Owner release and invite
requests are schema-supported but their producers are not implemented yet.
