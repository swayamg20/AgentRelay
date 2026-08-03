# High-level design: current relay implementation

> **Scope:** Current repository implementation as of 2026-08-03.
> This document describes the existing handoff plane, public Mission delivery
> control plane, Node identity/workspace API, and experimental fake-runtime Node.
> It does not describe a complete autonomous coding runtime. See
> [`RFC 001`](rfcs/001-agentrelay-node-and-missions.md) for the target system.

## Purpose

The current AgentRelay implementation lets two registered developers' already-running
agents exchange structured handoff threads through a shared relay. The relay persists
the conversation and enforces participant access. A local stdio MCP server exposes
the mailbox as tools to Claude Code or Codex.

Humans or active agent sessions still initiate mailbox checks. Separately, the
foreground `agentrelay-node` command can use a pre-issued Node credential, accept a
Mission assignment, durably lease one turn, and drive either an in-process fake
adapter or a detached persistent fake Mission Capsule. It does not yet activate a
real coding-agent runtime or turn Mission work into repository changes.

## Components

```text
Developer A                                             Developer B
coding-agent host                                       coding-agent host
      | MCP stdio                                             | MCP stdio
agentrelay-mcp                                          agentrelay-mcp
      | HTTPS JSON-RPC/REST                                   | HTTPS JSON-RPC/REST
      +------------------- relay -----------------------------+
                         Hono + Postgres
              identity, handoffs, Missions, delivery, audit
                              |
                   best-effort Slack webhook

Experimental path on each machine:
agentrelay-node -> atomic local journal
        |-- in-process deterministic fake adapter
        `-- private Unix socket -> detached fake Mission Capsule
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
- Audit records for invite, handoff/message, block, Node/workspace, Mission, and
  delivery mutations.
- An in-process Slack dispatcher with encrypted-at-rest webhook configuration.
- Agent-authenticated Mission creation plus Node-authenticated Mission list, detail,
  and participant acceptance.
- Node-authenticated cursor polling and recovery discovery, followed by fenced claim,
  start, renew, complete, and release operations. Completion commits the Mission
  result, source settlement, acknowledgement, downstream deliveries, receipt, and
  audit consequences in one transaction.
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

### Experimental foreground Node

The private `agentrelay-node` workspace consumes the public Node routes. While its
foreground command is running, it verifies the configured Node and workspaces,
scans recoverable work before polling new cursor work, services one delivery, then
advances one durably cursor-paged batch of eligible Mission acceptances. It journals
exact operation intents, renews the Relay lease, and reduces fake-host events. Relay
database time controls retry eligibility; transient host failure advances a journaled
execution attempt while lease-only recovery keeps the same host turn. Its device
configuration and local journal are mode 0600; the checkout path never enters the
Relay payload.

The original `run` path remains in memory. The `run-capsule` path instead persists
one fake host process per Mission, authenticates every request with a local capability,
and binds recovery to the exact original start input checkpointed before host start.
That Capsule can remain alive when the Node is killed. The Node still has no Codex or
Claude adapter.

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
                                                    +---N NodeDelivery ---N DeliveryOperationReceipt
```

- `Agent` is the current logical developer identity.
- `AgentCard` stores skills, owned-repository labels, a JSON card body, and an
  optional notification webhook field.
- `ApiKey` stores a hash of a bearer credential and revocation metadata.
- `Handoff` stores sender, recipient, intent, status, summary, artifacts, optional
  proposed action, and lifecycle timestamps.
- `Message` is append-only, stores payload and typed artifacts separately, and
  receives a per-handoff sequence number.
- `AuditLog` records invite, handoff/message, block, Agent disable, Node/workspace,
  Mission, and delivery mutations, not every relay mutation or any local host action.
  Agent-authenticated entries retain an Agent ID; admin and relay-system entries use
  an explicit actor kind without a fabricated Agent identity.
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
  event. It moves through `stored`, `leased`, `executing`, `acknowledged`,
  `cancelled`, or `dead_lettered`, with attempt, fencing, lease, availability, and
  settlement state.
- `DeliveryOperationReceipt` is append-only evidence for Node `claim`, `start`,
  `renew`, `complete`, and `release`, plus relay `lease_expired` and `cancel`
  operations. Public Node idempotency is scoped through these receipts.

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
  rows for invite, handoff/message, block, Node/workspace, Mission, and delivery
  mutations.
- Participant access checks and most state transitions.
- Idempotent replay for handoff creation and message append.
- Through public agent and Node routes: Mission creation, assignment list/detail,
  independent exact participant acceptance, ordered event append through completion,
  reducer-projection updates, source-delivery and causal links, derived deliveries,
  and joined cursor replay.
- New-work cursor polling plus a separate recovery scan; relay-issued bounded leases,
  monotonic attempt fencing, exact operation receipts, retry/dead-letter transitions,
  relay cancellation, and atomic Mission-result completion.
- Node enrollment, credential rotation/revocation, logical workspace registration,
  exact workspace replay, and atomic Node-to-credential/workspace revocation. Node,
  workspace, and owner revocation also cancel active work across affected Missions.
- Mission trust checks share the block-pair transaction fence, and every delivery
  mutation revalidates its active Node, participant, workspace, and Mission route.

### Best effort today

- Slack dispatcher execution. Webhook URLs are encrypted before storage, but the
  queue is in memory, has a finite capacity, and can lose jobs across process restart.
- Human or active-session pickup. `check_inbox` is explicit polling.

### Not implemented today

- A real coding-agent runtime session. The external Capsule and Node-process recovery
  proof currently exercise only the deterministic fake runtime.
- Automatic Node supervision or safe unattended reclamation of a `run.lock` left by
  `SIGKILL`; restart currently requires an operator to verify the recorded process is
  dead before removing that exact lock.
- Automatic worktree isolation and complete per-Mission command/network mediation.
- Contract-acknowledgement and registered verification-command delivery handlers.
- Local command, edit, test, and permission-decision audit.
- Background or lazy Mission-level expiry/dead-letter reconciliation. Expired
  Missions are filtered from delivery discovery, but their row and all remaining
  deliveries are not automatically moved to terminal states.
- A real two-machine, two-repository execution proof.
- A current A2A compatibility proof.

## Security boundaries

Implemented protections include type-separated hashed agent and Node credentials,
participant authorization, block checks on new handoffs, pending acceptance,
active-thread appends, and content-bearing completion, a shared directed-pair lock
between those checks and block-list writes, the same trust fence across Mission
creation, acceptance, event publication, and delivery execution, current routing
revalidation, revocation-driven delivery cancellation, scoped relay audit, provenance
wrappers or markers on teammate-originated mailbox fields, static host permission
recommendations, and per-acceptance local trust loading.

They are not yet one end-to-end enforcement system:

- The computed trust overlay has no production consumer that changes host policy.
- Block writes local trust first and unblock writes the relay first. Successful
  commands converge both stores, while partial failure leaves local denial active;
  the network and filesystem writes are still not one atomic transaction.
- Several relay mutations have no audit row, and relay audit cannot say which local
  commands or edits happened because of a handoff.
- Outbound AgentRelay tools are not constrained by a Mission-specific data policy.

Autonomous execution must wait for the Node to apply the complete bounded command,
network, time, path, and side-effect policy outside the model. See the security
section of [`architecture.md`](architecture.md).

## Failure behavior

- If Postgres is unavailable, relay requests fail; there is no alternate durable
  store.
- If a notification fails, the persisted handoff remains available for polling.
- If the MCP process exits, no manual mailbox tool call is processed until a host
  starts it again. A separately running foreground Node can continue Mission polling.
- A normal Node exit releases its singleton lock and leaves detached Capsules alive.
  During `SIGINT` or `SIGTERM`, an in-flight turn is first asked to cancel. A
  `SIGKILL` cannot release the Node lock; after operator-safe lock cleanup, the
  restarted Node can recover the Capsule's exact persisted turn and event history.
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
  entire mutation.
- Cursor reads discover only newly due stored work; the separate recovery scan finds
  due retried work and active or expired leases regardless of cursor age. Both hide
  work for expired or non-runnable Missions, but do not transition the Mission.
- Claim uses relay database time to issue a 60-second lease bounded by Mission expiry,
  increments the attempt, and uses that attempt as the fence. A stale holder cannot
  start, renew, release, or complete after re-lease. New mutations re-check current
  routing and block state; exact replay still revalidates routing authority and is
  refused after relay cancellation.
- Completion atomically records the authenticated result event, source settlement,
  acknowledgement, derived work, Node receipt, and audit. Transient release returns
  work to `stored` with relay backoff; permanent, policy, exhausted, or Mission-bound
  failure dead-letters it. Reclaiming a non-final expired lease records Relay expiry
  evidence before issuing the next claim; an expired final attempt instead produces
  one terminal Node claim receipt with `claim_outcome: dead_lettered`. No process
  promotes that terminal delivery outcome to a Mission-wide terminal state.
- Node credential rotation is a compare-and-swap against the owner-visible active
  credential ID and serializes with workspace mutations. Concurrent rotations from
  one credential generation cannot both succeed. Node revocation atomically disables
  its credential and active workspace bindings and cancels affected active Mission
  deliveries; immutable Mission and operation history remains for audit and recovery
  analysis.

## Relationship to the next design

The mailbox remains a compatibility and inspection surface. The relay exposes a
separate, authenticated Mission and delivery control plane without stretching the
handoff row into a scheduler. The foreground Node now consumes one turn through that
API with either an in-process fake or a detached persistent fake Capsule. The next
runtime checkpoint is a pinned coding-agent adapter, followed by a two-machine run;
Mission-level expiry/dead-letter reconciliation remains a separate relay gap.
