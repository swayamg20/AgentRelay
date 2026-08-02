# High-level design: current relay implementation

> **Scope:** Current repository implementation as of 2026-08-02.
> This document describes the existing handoff plane, durable-ledger kernel, and
> Node identity/workspace API, not the autonomous Node runtime target.
> See [`RFC 001`](rfcs/001-agentrelay-node-and-missions.md) for the next system.

## Purpose

The current AgentRelay implementation lets two registered developers' already-running
agents exchange structured handoff threads through a shared relay. The relay persists
the conversation and enforces participant access. A local stdio MCP server exposes
the mailbox as tools to Claude Code or Codex.

Humans or active agent sessions still initiate inbox checks and every subsequent
tool call. The relay can enroll a Node and issue its separate credential, but there
is no daemon, authenticated delivery claim, or runtime activation loop.

## Components

```text
Developer A                                             Developer B
coding-agent host                                       coding-agent host
      | MCP stdio                                             | MCP stdio
agentrelay-mcp                                          agentrelay-mcp
      | HTTPS JSON-RPC/REST                                   | HTTPS JSON-RPC/REST
      +------------------- relay -----------------------------+
                         Hono + Postgres
                    identity, handoffs, audit
                              |
                   best-effort Slack webhook
```

### Relay

The relay is a Node/TypeScript Hono service backed by Postgres and Drizzle. It owns:

- Admin registration and one-time API-key issue.
- Signed, expiring, single-use invite creation and redemption.
- Bearer authentication and developer identity resolution.
- Agent roster and self-managed card metadata.
- API-key rotation and block records.
- Handoff and ordered-message persistence.
- Participant authorization and lifecycle transitions.
- Audit records for invite, handoff/message, block, Node/workspace, and internal
  Mission mutations.
- An in-process Slack dispatcher with encrypted-at-rest webhook configuration.
- An internal Mission-ledger service that persists Mission projections and append-only
  events, derives stored per-Node deliveries in the same transaction, and reads them
  through an opaque cursor. No HTTP route invokes this service yet.
- Agent-authenticated Node enrollment, credential rotation, and revocation routes,
  plus Node-authenticated logical workspace registration and revocation. These
  operations are audited in the same transaction as their state changes.

The HTTP application is stateless with respect to durable domain rows, but the
notification queue is process-local and not durable.

### MCP server

`agentrelay-mcp` is a stdio child process of an agent host. It:

- Loads the relay URL and developer credential from local config.
- Validates tool inputs with Zod.
- Translates seven tools to relay calls.
- Wraps or marks every teammate-authored mailbox field returned by its inbox and
  thread tools, while preserving the shape of structured payloads and artifacts.
- Loads local `trust.yaml` and returns a computed trust overlay.

The MCP process is not persistent when its host is closed. It does not subscribe to
the relay, start model turns, manage worktrees, or apply a dynamic runtime policy.

### CLI

The `agentrelay` binary supports registration, invite/join, client installation, key
rotation, doctor/fix, audit, block/unblock, trust management, and starting the stdio
MCP server.

## Core data model

```text
Agent 1---1 AgentCard
  |
  +---N ApiKey
  +---N Invite (as inviter or redeemer)
  +---N AgentBlock
  |
  +---N Handoff ---N Message
             |
             +----- mutation AuditLog rows

Agent 1---N Node ---N NodeCredential
                 \---N WorkspaceBinding
                 \---N MissionParticipant ---1 Mission ---N MissionEvent
                                                    |
                                                    +---N NodeDelivery
```

- `Agent` is the current logical developer identity.
- `AgentCard` stores skills, owned-repository labels, a JSON card body, and an
  optional notification webhook field.
- `ApiKey` stores a hash of a bearer credential and revocation metadata.
- `Handoff` stores sender, recipient, intent, status, summary, artifacts, optional
  proposed action, and lifecycle timestamps.
- `Message` is append-only, stores payload and typed artifacts separately, and
  receives a per-handoff sequence number.
- `AuditLog` records invite, handoff/message, block, Node/workspace, and internal
  Mission mutations, not every relay mutation or any local host action.
- `AgentBlock` prevents a blocked sender from creating a new handoff for the blocker
  or appending another message to an existing thread whose receiver blocked them.
- `Invite` records signed-token identity, expiry, and one-time redemption.
- `Node` and `WorkspaceBinding` are relay-visible routing identities without a local
  checkout path or executable command authority.
- `NodeCredential` stores only the hashed, separately revocable credential used by
  one active Node. Its raw token is returned only when enrolled or rotated.
- `Mission` stores the immutable coordinator config plus a reducer projection;
  `MissionEvent` is append-only and ordered within that Mission.
- `NodeDelivery` points one Node cursor to work derived from a committed Mission
  event. Verification work is bound to one coordinator round. This checkpoint can
  logically settle consumed or invalidated work, but transport state remains
  `stored`; it cannot claim or run deliveries.

Exact tables and current route names are summarized in [`lld.md`](lld.md). Source
under `relay/src/db/schema.ts` remains authoritative for column-level behavior.

## Handoff lifecycle

```text
pending --accept--> accepted --complete--> completed
   |
   +--cancel--------------------------------> cancelled
```

- Only the recipient may accept or complete.
- Only the sender may cancel, and only while pending.
- Either participant may append messages while pending or accepted.
- Completed and cancelled handoffs are terminal.
- State transitions and audit writes happen transactionally.
- Per-handoff message sequence allocation is protected with a Postgres advisory lock.
- Handoff creation and message append accept client idempotency keys and can replay a
  previous result. Complete and cancel do not have replay receipts.

## Main flows

### Invite and join

1. A registered team member uses the admin token to mint an invite for a handle and
   role.
2. The relay stores the invite and returns a URL whose fragment contains the signed
   token.
3. The joiner submits the token to the relay's redemption endpoint.
4. The relay locks the invite, validates signature, expiry, hash, and unused state,
   then creates the agent and initial API key in one transaction.
5. The CLI writes local config, adds the inviter to local trust, and installs MCP
   settings for supported clients.

### Send and receive

1. The sender's running agent calls `handoff_to_teammate`.
2. The MCP server posts `message/send` with an idempotency key.
3. The relay authenticates the sender, checks the recipient and block relationship,
   then stores the handoff, first message, and audit entry.
4. After commit, the relay enqueues a best-effort notification.
5. The recipient later calls `check_inbox`, then `accept_handoff`.
6. The MCP server returns the thread with provenance-wrapped text, marked structured
   teammate data, and the local trust decision.

### Clarify and complete

Either participant can call `send_message` while the handoff is active. Generic
payload and typed artifacts remain distinct across the round trip. The recipient
eventually calls `complete_handoff`; the relay persists the summary and completion
artifacts, marks the handoff terminal, and records the mutation. There is no
background loop that ensures the other agent notices the new message.

An explicit handoff question and caller metadata also round-trip through both MCP read
tools. Peer metadata is structurally marked, its known free-form question is wrapped,
and the relay-owned idempotency key is not exposed to the model.

## Correctness boundaries

### Durable today

- Handoffs, messages, lifecycle state, identities, invites, and blocks, plus audit
  rows for invite, handoff/message, block, Node/workspace, and internal Mission
  mutations.
- Participant access checks and most state transitions.
- Idempotent replay for handoff creation and message append.
- Through the internal ledger service: Mission creation, ordered event append,
  independent exact participant-acceptance receipts, reducer-projection updates,
  source-delivery and causal links, derived stored deliveries, logical settlement,
  audit, stable event/delivery-ID replay, and joined cursor replay. Each mutation and
  its consequences share one Postgres transaction.
- Node enrollment, credential rotation/revocation, logical workspace registration,
  exact workspace replay, and atomic Node-to-credential/workspace revocation.

### Best effort today

- Slack dispatcher execution. Webhook URLs are encrypted before storage, but the
  queue is in memory, has a finite capacity, and can lose jobs across process restart.
- Human or active-session pickup. `check_inbox` is explicit polling.

### Not implemented today

- An authenticated polling route over the internal Mission and delivery records.
- Delivery claim, transport acknowledgement, retry lease, dead-letter transition, or
  general transport-operation receipt.
- Runtime-session start/resume/cancel.
- Local worktree isolation and per-Mission policy enforcement.
- Local command, edit, test, and permission-decision audit.
- A current A2A compatibility proof.

## Security boundaries

Implemented protections include type-separated hashed agent and Node credentials,
participant authorization, block checks on new handoffs, pending acceptance,
active-thread appends, and content-bearing completion, a shared directed-pair lock
between those checks and block-list writes, scoped relay audit, provenance wrappers
or markers on teammate-originated mailbox fields, static host permission
recommendations, and per-acceptance local trust loading.

They are not yet one end-to-end enforcement system:

- The computed trust overlay has no production consumer that changes host policy.
- Block writes local trust first and unblock writes the relay first. Successful
  commands converge both stores, while partial failure leaves local denial active;
  the network and filesystem writes are still not one atomic transaction.
- Several relay mutations have no audit row, and relay audit cannot say which local
  commands or edits happened because of a handoff.
- Outbound AgentRelay tools are not constrained by a Mission-specific data policy.

Autonomous execution must wait for the Node to apply a bounded policy outside the
model. See the security section of [`architecture.md`](architecture.md).

## Failure behavior

- If Postgres is unavailable, relay requests fail; there is no alternate durable
  store.
- If a notification fails, the persisted handoff remains available for polling.
- If the MCP process exits, no work is processed until a host starts it again.
- If a handoff creation or message append is retried with the same client idempotency
  key and matching checked fields, the relay returns the recorded result even after a
  later block or terminal transition. Same-key concurrent retries are serialized.
  Complete and cancel do not provide the same replay contract.
- Concurrent lifecycle transitions are serialized by row locks and state checks.
- Block/unblock and content-bearing mutations use the same directed-pair transaction
  lock, so no new content mutation can commit after a successful block response.
- A terminal handoff rejects new messages and transitions.
- Mission-event append takes a Mission-scoped transaction lock, reconstructs the
  current projection from stored events, then commits the new event, projection,
  source-work settlement, derived deliveries, and audit together. Each participant
  acceptance is its own exact receipt; the second receipt atomically derives the
  aggregate activation event and first turn. A failed delivery insert rolls back that
  entire mutation. Cursor reads do not imply claim, execution, or acknowledgement.
- Node credential rotation is a compare-and-swap against the owner-visible active
  credential ID and serializes with workspace mutations. Concurrent rotations from
  one credential generation cannot both succeed. Node revocation atomically disables
  its credential and active workspace bindings; immutable Mission rows remain for
  audit and recovery analysis.

## Relationship to the next design

The current APIs remain a compatibility and inspection surface while Missions are
proved. The relay now enrolls separately authenticated Nodes and their logical
workspace bindings, while the internal kernel stores Missions, events, and unclaimed
deliveries without stretching the handoff row into a scheduler. The next checkpoint
adds authenticated polling and fenced lease/claim/completion APIs before any local
runtime is allowed to consume that work.
