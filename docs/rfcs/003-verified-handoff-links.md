# RFC 003: Verified handoff links — bounded amendment to RFC 002

- **Status:** Accepted design for owner-approved handoff-link work; not a claim of
  shipped routes or client support
- **Date:** 2026-11-07
- **Amends:** [RFC 002](002-agent-reachability-and-durable-mailbox.md), only the four
  decisions below, and only for the separate handoff-link surface
- **Implementation evidence:** Active code and tests; the
  [receiver test kit](../handoff-links-receiver-test.md) is a mock, not evidence of
  production delivery or real-client compatibility

RFC 002 remains the public product and sovereignty decision. Ordinary authenticated
mailbox handoffs remain two-party, participant-only correspondence. This amendment
does not turn those handoffs into public links or change their lifecycle or consent.

## 1. Public reads of sender-authored link content

An authenticated sender may explicitly publish selected handoff content behind an
unguessable, expiring, revocable capability URL after a preview and a client-side
secret scan. Possession of the link is the only public-read capability. It is not
an agent credential or authorization to read the sender's other correspondence.

Public reads contain only the sender's published content and sender-authored
answers. External replies, whether held or released, are never rendered publicly.
Forwarding a link forwards its read/reply capability; the sender must assume anyone
with it can use it. Neither a robots directive nor an obscure URL is identity
verification. Link reads do not prove agent pickup or processing.

The sender's company domain, when available, is explicitly **admin-attested** at
invite minting, not cryptographically verified, self-asserted by the receiver, or
inferred from a handle/email. Existing identities have unknown company provenance.
"Verified handoff link" must not imply a verified external author, signed content,
or local execution permission. All sender text remains untrusted to the receiver.
Relay-authored instructions precede delimited sender content; these instructions
explain the boundary but do not enforce the receiver's local permissions.

This is the narrow exception to RFC 002's participant-only correspondence boundary:
explicitly published sender-authored **link** content, never ordinary mailbox rows.

## 2. Unauthenticated external replies held for owner release

A person may give the URL to their own agent, which may read and reply using its
existing network tools without an AgentRelay installation or receiver account.
Local owner approval and host policy still govern that agent's requests. The link
capability permits submitting a bounded external reply, not asserting a verified
person, organization, or agent identity.

External replies enter a held state. They are neither ordinary inbox content nor
public link content. The sender's authenticated client may inspect them with clear
untrusted provenance. Only an explicit sender-owner release, through the
interactive-terminal release path, makes a reply eligible for `check_inbox`.
There is no MCP release tool or model-driven automatic release. Repeated release
must not duplicate inbox delivery or its audit fact.

Released text retains provenance origin `external_unverified`. Release means the
owner allowed that particular content into the mailbox; it does not verify its
author, make it trusted, grant authority, or accept a task. A content-free Slack
hint may say a reply is waiting. The Relay's POST receipt proves durable storage
only, never release, agent processing, or a sender reply.

## 3. Link threads may have more than two parties

A link has one authenticated sender and may receive replies from multiple external
holders. These holders are not registered participants and cannot enumerate each
other or read each other's replies. Public sender answers may be read by every
holder; publishing an answer is a distinct sender decision and must not
automatically quote a held or released external reply.

The separate link thread does not widen the participant set of an existing mailbox
handoff. RFC 002's two-party thread vocabulary continues to describe ordinary
handoffs. Ordering, storage, expiry, revocation, and owner release are deterministic
Relay state, not a manager model's decision. A link does not create cross-company
delegation, acceptance, commitment, or execution authority.

## 4. Audit entries may name actors that are not agents

Audit distinguishes authenticated `agent`, authenticated `admin`, unauthenticated
`external`, and Relay `system` actors. Only an authenticated agent actor carries an
agent ID; an external submission or fetch must never be attributed to the sender
merely because it uses that sender's link. Non-agent actor entries do not assert a
verified identity. Admin invite-domain attestation is attributed to the admin, not
to the inviter agent named in the request.

State-changing link operations and their audit facts commit together. Content-free
`share_events` measure creation, reads (HTML/Markdown and known-bot classification),
reply submission (API/form), release, sender answers, and invite requests. A fetch
event is a fetch, not evidence of understanding or consent. Measurement and audit
must not store message bodies, capability URLs, credentials, or claimed external
identity as verification evidence. Sender-scoped audit remains owner-isolated.

## All other RFC 002 promises remain

The Relay is model-free. Cross-agent content is untrusted, including typed
artifacts. Durable state and replay are truth; presence, push, Slack, and MCP are
not portable wake-up or processing mechanisms. Authentication, ordinary mailbox
participant checks, blocking, revocation, transactionally consistent audit, and
retry idempotency retain their owning boundaries. A published link must not bypass
a directed block through an authenticated mailbox operation.

No link, reply, release, or answer selects local files, commands, repositories,
permissions, secrets, or budgets. Security-relevant local decisions remain enforced
outside the model. Mission/Node/Capsule Labs boundaries are unchanged. Receiver
accounts, self-serve signup, email, cryptographic signing, live sessions, wake-up,
federation/A2A conformance, and execution are not introduced by this amendment.

Implementation documentation must continue distinguishing decisions from shipped
behavior and storage receipts from release, processing, and reply state.
