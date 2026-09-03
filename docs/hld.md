# High-level design: mailbox core and Labs implementation

> **Scope:** Current repository implementation as of 2026-09-04.
> This document describes the core handoff mailbox and the same-repository Mission,
> Node, Capsule, and Codex Labs track. Product direction and priority live in
> [`RFC 002`](rfcs/002-agent-reachability-and-durable-mailbox.md). The Labs target
> remains [`RFC 001`](rfcs/001-agentrelay-node-and-missions.md); it is not a complete
> or activated autonomous coding runtime.

## Purpose

The core AgentRelay implementation lets two registered developers' independently
operated, already-running agents address each other and exchange durable handoff
threads through a shared relay. The relay persists ordered messages and enforces
participant access. A local stdio MCP server exposes the mailbox as tools to Claude
Code or Codex.

An AgentRelay address is currently a handle inside one relay/team trust domain, not a
global or federated address. Invite redemption establishes membership, blocks provide
negative consent, and handoff acceptance records task commitment. Either participant
can read or reply while a handoff remains `pending`, so communication does not depend
on accepting the task. A foreground connector can now place content-free attention
in one locally selected Codex chat after exact-sender consent. The user still decides
whether to inspect the message; an event, live hint, or local queue receipt does not
prove pickup, reading, or processing.

Separately, in Labs, the foreground `agentrelay-node` command can use a pre-issued
Node credential, accept a
Mission assignment, durably lease one turn, and drive either an in-process fake
adapter or a detached persistent fake Mission Capsule. A provider-neutral Capsule
server, injected Codex runner, and provider guardian now exist behind that wire as a
tested library checkpoint, but the descriptor and CLI still choose the fake. The
guardian owns provider-generation spawn and live supervision; its prearmed detached
witness owns post-absence quiescence finalization. No current command activates a real
model turn or turns Mission work into repository changes. A separate Linux-only
containment library can construct the pinned Codex `0.146.0` Bubblewrap boundary, but
no Mission lifecycle or runtime descriptor composes it with the guardian. The
persistent fake-Capsule path now carries one private, fenced capability grant through
independent Node and Capsule reference monitors; this is an enforcement checkpoint,
not Codex activation.

## Components

```text
Developer A                                             Developer B
coding-agent host                                       coding-agent host
      | MCP stdio                                             | MCP stdio
agentrelay-mcp                                          agentrelay-mcp
      | HTTPS JSON-RPC/REST                                   | HTTPS JSON-RPC/REST
      +------------------- relay -----------------------------+
                         Hono + Postgres
       core: identity, consent, handoffs, messages, events, audit
                              |
                   best-effort Slack webhook

Optional receiver pickup path:
Postgres event + NOTIFY -> content-free SSE -> agentrelay watch
    -> exact-sender consent -> locally bound runtime-attention adapter

Same-repository Labs path on each machine:
agentrelay-node -> atomic local journal
        |-- in-process deterministic fake adapter
        `-- private grant + Unix socket -> provider-neutral Capsule server
                                      |-- selected today: deterministic fake
                                      `-- tested only: injected Codex runner
                                               -> detached guardian process group
                                                  |-- pinned provider + descendants
                                                  `-- spawns detached teardown witness
                                                      outside the process group

Labs, unactivated Linux composition:
owner-prepared checkout -> containment library -> pinned Codex sandbox/app-server
```

### Relay

The relay is a Node/TypeScript Hono service backed by Postgres and Drizzle. It owns:

- Admin registration and one-time API-key issue.
- Signed, expiring, single-use invite creation and redemption.
- Bearer authentication and developer identity resolution.
- Agent roster and self-managed card metadata.
- API-key rotation and block records.
- Handoff and ordered-message persistence.
- Opaque recipient-event persistence, per-recipient commit-safe cursor allocation,
  authenticated replay, and a content-free SSE hint.
- Participant authorization and lifecycle transitions.
- Audit records for invite, handoff/message, and block mutations.
- An optional in-process Slack notification adapter with encrypted-at-rest webhook
  configuration.

Its Labs routes additionally own:

- Audit records for Node/workspace, Mission, and delivery mutations.
- Agent-authenticated Mission creation plus Node-authenticated Mission list, detail,
  and participant acceptance.
- Node-authenticated cursor polling and recovery discovery, followed by fenced claim,
  start, renew, complete, and release operations. Completion commits the Mission
  result, source settlement, acknowledgement, downstream deliveries, receipt, and
  audit consequences in one transaction. Delivery discovery and delivery operations
  lazily reconcile eligible terminal causes under the same Mission lock.
- Agent-authenticated Node enrollment, credential rotation, and revocation routes,
  plus Node-authenticated logical workspace registration and revocation. These
  operations are audited in the same transaction as their state changes.

The HTTP application is stateless with respect to durable domain rows. One process
level PostgreSQL listener fans content-free changes out to local SSE streams; missed
hints are recovered through durable replay. The separate Slack notification queue is
still process-local and not durable.

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
The optional foreground `agentrelay watch` connector is separate from MCP stdio. It
replays opaque events, rechecks local trust, coalesces duplicate attention, and calls
a host adapter with event/thread identifiers only.

### CLI

The `agentrelay` binary supports registration, invite/join, client installation, key
rotation, doctor/fix, audit, block/unblock, trust management, local runtime
bind/unbind, the foreground watch connector, and starting the stdio MCP server.

### Labs: experimental foreground Node

The private `agentrelay-node` workspace consumes the public Node routes. While its
foreground command is running, it verifies the configured Node and workspaces,
scans recoverable work before polling new cursor work, services one delivery, then
advances one durably cursor-paged batch of eligible Mission acceptances. It journals
exact operation intents, renews the Relay lease, and reduces fake-host events. Relay
database time controls retry eligibility; transient host failure advances a journaled
execution attempt while lease-only recovery keeps the same host turn. Its device
configuration and local journal are mode 0600; the checkout path never enters the
Relay payload. Before opening the journal or Capsule registry, the Node holds a stable
private `run.lock` with a nonblocking kernel advisory lock. PID and owner metadata are
written separately to `run.owner.json` and are diagnostic only; they do not grant
ownership. The `run.lock` inode remains permanently in place.

The original `run` path remains in memory. The `run-capsule` path instead persists
one fake host process per Mission, authenticates every request with a local capability,
and binds recovery to the exact original start input checkpointed before host start.
That Capsule can remain alive when the Node is killed.

After Relay authorization and workspace preflight, that path compiles a grant bound
to the Agent, Node, workspace resource, Mission, delivery, execution attempt, active
lease/fence, accepted local-policy digest, and hard expiry. Node journal schema 4
checkpoints the exact grant before activation and retains an older-fence predecessor
until its Capsule generation is retired. A private wire extension installs,
renews, revalidates, and revokes it. The Capsule monitor gates session, start,
recovery, cancellation, and cumulative streamed output, usage, and artifacts. The
Node monitor separately gates final Relay completion and passes its live abort signal
into the request. Product policy cannot grant push, merge, package publish, deploy,
arbitrary network access, secret access, or privilege expansion. Both monitors can
emit bounded redacted decisions to injected sinks; no durable evidence sink is wired
by default. See [research 008](research/008-local-runtime-authority.md).

The wire server is now provider-neutral and accepts a locally injected runtime while
preserving the fake descriptor, CLI entry point, and versioned request/response
contract. The library also contains a `CodexCapsuleRunner` with probe, session,
start/recover, event, and cancellation behavior. Its schema-v2 journal exposes a
stable logical turn before a provider ID is known. `CodexProviderGuardian` gives the
runner one fresh generation only after it owns the stable kernel lock, durable start
barrier, provider process group, owner heartbeat, deadline, and revocation watchdog.
Before the barrier, the guardian prearms a detached witness outside its process group;
the witness holds the same lock and is the only same-boot teardown process that records
quiescence after proving the entire guardian/provider group absent.
Unexpected internal runtime failures are redacted and retire the running server
generation. Runtime shutdown starts concurrently with handler drain so `close()` can
release and fence admitted work; detached background work can request the same
retirement through the runtime lifecycle.

This Codex path is tested through the real Unix wire with fake app-server clients. Its
guardian tests use real OS process trees, and the Linux process gate starts pinned
Codex through the guardian and containment boundary without executing a model turn.
It has no descriptor/CLI selection, composition with the private authority monitor,
real model-turn proof, or Claude equivalent. The Codex child environment is
allowlisted, and its private home is derived locally beneath the Capsule and
revalidated as canonical, current-user-owned, and exactly mode 0700. For an inherited uncertain-interrupt
barrier, a fresh generation reads the exact intent once, persists a terminal provider
outcome when present, or records a transient failure without resending the interrupt.
Detailed guardian mechanics live in
[research 007](research/007-codex-provider-guardian.md).

The separate Linux containment library binds an owner-controlled standalone checkout
to an explicit Bubblewrap policy, mandatory runtime canary, and private
`retain_for_review` manifest. Recovery requires the exact manifest path, instance ID,
and binding digest. Future Mission lifecycle wiring must store that handle durably;
current commands do not. Detailed mechanics live in
[research 006](research/006-mission-workspace-containment.md).

## Data model

The first branch below is the core mailbox model. The second is the Labs Mission and
execution extension; sharing a schema does not make that extension a prerequisite for
mailbox operation.

```text
Agent 1---1 AgentCard
  |
  +---N ApiKey
  +---N Invite (as inviter or redeemer)
  +---N AgentBlock
  +---N MailboxEvent (as recipient or actor)
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
- `MailboxEvent` is an opaque, append-only recipient signal derived in the same
  transaction as a mailbox mutation. It stores relay-owned identities and references,
  never message text or artifacts. Its bigint cursor is serialized per recipient.
- `AuditLog` records invite, handoff/message, block, Agent disable, Node/workspace,
  Mission, and delivery mutations, not every relay mutation or any local host action.
  Agent-authenticated entries retain an Agent ID; admin and relay-system entries use
  an explicit actor kind without a fabricated Agent identity.
- `AgentBlock` prevents a blocked sender from creating a new handoff for the blocker
  or appending another message to an existing thread whose receiver blocked them.
- `Invite` records signed-token identity, expiry, and one-time redemption.

The Labs extension adds:

- `Node` and `WorkspaceBinding` are relay-visible routing identities without a local
  checkout path or executable command authority.
- `NodeCredential` stores only the hashed, separately revocable credential used by
  one active Node. Its raw token is returned only when enrolled or rotated.
- `Mission` stores the immutable coordinator config plus a reducer projection;
  `MissionEvent` is append-only and ordered within that Mission. Events have explicit
  `agent` or `system` actors; Relay-owned `mission_terminal` has no Agent actor.
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
- Acceptance records task commitment; it is not required to read or reply.
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
   then stores the handoff, first message, recipient event, and audit entry in one
   transaction.
4. Commit releases a content-free PostgreSQL notification. Connected SSE clients use
   it only as a reason to replay the durable recipient-event cursor.
5. Without local pickup consent, the recipient later calls `check_inbox` as before.
   With exact-sender consent and a bound Codex thread, `agentrelay watch` may queue a
   fixed content-free attention turn; it does not read the thread.
6. If the recipient is committing to the requested task, it separately calls
   `accept_handoff`.
7. The MCP server returns teammate content with provenance-wrapped text, marked
   structured data, and the local trust decision.

### Clarify and complete

Either participant can call `send_message` while the handoff is active. Generic
payload and typed artifacts remain distinct across the round trip. The recipient
eventually calls `complete_handoff`; the relay persists the summary and completion
artifacts, marks the handoff terminal, records the mutation, and creates an opaque
counterparty event. On a healthy live path, a running connector notices the durable
event without interval polling, but it does not turn that observation into a lifecycle
transition.

An explicit handoff question and caller metadata also round-trip through both MCP read
tools. Peer metadata is structurally marked, its known free-form question is wrapped,
and the relay-owned idempotency key is not exposed to the model.

## Correctness boundaries

### Durable core mailbox today

- Handoffs, messages, lifecycle state, identities, invites, and blocks, plus audit
  rows for invite, handoff/message, and block mutations.
- Same-transaction recipient events for fresh thread/message and lifecycle mutations,
  with authenticated recipient-only replay and content-free live hints.
- Participant access checks and most state transitions.
- Idempotent replay for handoff creation and message append.

### Durable Labs state today

- Audit rows for Node/workspace, Mission, and delivery mutations.
- Through public agent and Node routes: Mission creation, assignment list/detail,
  independent exact participant acceptance, ordered event append through completion,
  reducer-projection updates, source-delivery and causal links, derived deliveries,
  and joined cursor replay.
- New-work cursor polling plus a separate recovery scan; relay-issued bounded leases,
  monotonic attempt fencing, exact operation receipts, retry/dead-letter transitions,
  relay cancellation, and atomic Mission-result completion.
- Deterministic lazy terminal reconciliation: deadline maps eligible Missions to
  `expired`, otherwise the earliest unsettled dead letter maps them to `failed`, with
  one system event, remaining-work cancellations, receipts, and audits committed
  atomically.
- Node enrollment, credential rotation/revocation, logical workspace registration,
  exact workspace replay, and atomic Node-to-credential/workspace revocation. Node,
  workspace, and owner revocation also cancel active work across affected Missions.
- Mission trust checks share the block-pair transaction fence, and every delivery
  mutation revalidates its active Node, participant, workspace, and Mission route.
- At the unactivated library/test boundary, the provider-neutral Capsule wire, Codex
  schema-v2 journal, stable pre-binding turn, exact fresh-generation reconciliation,
  bounded zero-match terminalization, pre-binding cancellation, and conservative
  inherited-interrupt terminalization are durable.
- At that same unactivated boundary, a stable kernel lock excludes overlapping
  generations. The guardian supervises owner/provider liveness, deadline, and local
  revocation. Its prearmed out-of-group witness terminates and proves the process group
  absent, then authoritatively records durable quiescence; the Capsule waits for that
  proof before releasing replacement authority.
- At a second unactivated library boundary, the exclusive Linux Codex containment
  manifest durably binds the workspace, pinned runtime, private paths, policy grant,
  and `retain_for_review` decision. The API returns an exact recovery handle, but the
  Mission lifecycle does not persist it. The dedicated Linux process job passes as
  evidence for this library boundary, not as Mission activation evidence.
- On the selected persistent fake-Capsule path, Node journal schema 4 durably stores
  one exact active grant or one predecessor awaiting proven retirement. Independent
  Node and Capsule monitors enforce its scope,
  capability set, lease/fence, renewal, expiry, product denials, and aggregate
  output/usage/artifact limits. Authority loss stops streaming and final Relay
  completion. Decision records are emitted only to an injected evidence sink, and no
  durable sink is selected by default.

### Best effort in the core mailbox today

- Slack dispatcher execution. Webhook URLs are encrypted before storage, but the
  queue is in memory, has a finite capacity, and can lose jobs across process restart.
- Local runtime attention. The connector is foreground-only, Codex may take roughly
  ten seconds to observe an externally queued turn in standalone mode, and a queue
  receipt is not proof of model pickup.

### Not implemented in the core mailbox today

- A global or federated address beyond one relay/team trust domain.
- Durable push or portable wake-up of a closed agent host.
- Automatic teammate-content loading, answering, or work from the pickup connector.
- Truthful unread/read receipts and complete list pagination.
- A current A2A compatibility proof.

### Not implemented in Labs today

- A production-activated coding-agent runtime session. The Node/Capsule process proof
  still exercises only the deterministic fake; the injected Codex runner is covered
  only by fake-client wire tests and has not executed a model turn.
- Automatic Node installation, OS service supervision, or process respawn. The
  singleton kernel lock now permits direct restart after process death, but it does
  not start the replacement Node.
- Composition of the verified private authority grant with the guarded Codex
  descriptor, plus complete local capability enforcement around every concrete side
  effect.
- Descriptor/CLI and Mission-lifecycle wiring for the Linux containment boundary,
  including durable storage of its exact recovery handle before provider start. The
  dedicated Linux process proof passes, but macOS has no supported equivalent.
- Automatic worktree isolation and complete per-Mission command/network mediation.
- Contract-acknowledgement and registered verification-command delivery handlers.
- Durable local command, edit, test, authority, and permission-decision audit.
- A real two-machine, two-repository execution proof.

## Security boundaries

Core mailbox protections include hashed and revocable agent credentials, participant
authorization, block checks on new handoffs, pending acceptance, active-thread
appends, and content-bearing completion, plus a shared directed-pair lock between
those checks and block-list writes. They also include scoped relay audit, provenance
wrappers or markers on teammate-originated mailbox fields, static host permission
recommendations, and per-acceptance local trust loading.

Labs adds separately scoped Node credentials, the same trust fence across Mission
creation, acceptance, event publication, and delivery execution, current routing
revalidation, and revocation-driven delivery cancellation.

At an unactivated Linux library boundary, the Node can also require an owner-controlled
standalone checkout, a writable worktree with read-only Git metadata, explicit read
and denied roots, private home/temp, no network, rejected ambient Codex configuration,
disabled legacy Landlock, recursive read-tree alias inspection, and a mandatory
runtime canary. No active Mission receives these protections yet.

On the selected persistent fake-Capsule path, the bound grant is enforced outside the
model before runtime lifecycle operations, streamed output/usage/artifacts, and final
Relay completion. Its four limit sources intersect monotonically, and product-denied
effects remain denied even if a peer or Mission asks for them. This checkpoint exposes
no command executor, does not grant verification execution, and is not wired to Codex.

They are not yet one end-to-end enforcement system:

- The computed trust overlay has no production consumer that changes host policy.
- Block writes local trust first and unblock writes the relay first. Successful
  commands converge both stores, while partial failure leaves local denial active;
  the network and filesystem writes are still not one atomic transaction.
- Several relay mutations have no audit row, and relay audit cannot say which local
  commands or edits happened because of a handoff.
- Outbound AgentRelay tools are not constrained by a Mission-specific data policy.

Labs autonomous execution must still wait for the Node to activate this boundary
around a real runtime and mediate every concrete command, network, path, and side
effect outside the model. This is not a mailbox product gate. See the security
section of [`architecture.md`](architecture.md).

## Failure behavior

- If Postgres is unavailable, relay requests fail; there is no alternate durable
  store.
- If a notification fails, the persisted handoff remains available for polling.
- If an SSE connection drops, the connector reconnects and replays from its local
  cursor. It advances only after policy deliberately skips an event or the runtime
  accepts the content-free attention item; ambiguous enqueue failures may duplicate
  attention but cannot duplicate a mailbox mutation.
- If the MCP process exits, no manual mailbox tool call is processed until a host
  starts it again. `agentrelay watch` is a separate foreground process; stopping it
  stops live attention without affecting durable mail. A separately running
  foreground Node can continue Mission polling.
- A normal Node exit releases its singleton lock and leaves detached Capsules alive.
  During `SIGINT` or `SIGTERM`, an in-flight turn is first asked to cancel. A
  `SIGKILL` or host reboot releases the kernel lock without deleting the stable
  `run.lock`, so a replacement Node can restart directly and recover the Capsule's
  exact persisted turn and event history. A stopped or stalled live Node retains the
  lock; ownership is never stolen on a heartbeat timeout. Every legacy schema-1 PID
  lock fails closed before local state is opened because PID-only evidence cannot
  exclude a live old Node in another PID namespace. Its one-time migration is an
  explicit offline operator action.
- The provider-neutral Capsule server authenticates before invoking a runtime. An
  unexpected runtime exception is returned only as a generic internal error; the
  server removes its owned socket and closes that runtime generation. Shutdown starts
  runtime close while handlers drain so the runtime can release and fence admitted
  operations. Detached runtime work can call `lifecycle.retire()` to trigger the same
  teardown.
- The unactivated Codex guardian prearms an out-of-group teardown witness before it
  writes `spawn_maybe_started` or spawns the provider. Capsule loss, guardian loss,
  provider exit, request timeout, deadline, revocation, and explicit shutdown converge
  through one latched cause. The witness sends bounded TERM/KILL to the complete
  guardian/provider group, proves it absent, then records quiescence and closes its
  inherited lock. The Capsule independently proves absence, waits for that matching
  record, and only then releases its lock. Capsule-plus-guardian death therefore
  converges while the witness survives. Witness loss or loss of every lifecycle owner
  fails closed; installed service/cgroup recovery and escaped descendants remain #120.
- The runner resolves an uncertain `turn/start` in the guardian-owned fresh generation
  by an exact client-ID and text match or a bounded durable zero-match terminal result,
  never by resending. Schema-v1 development state is not migrated to schema v2. If
  that fresh generation inherits `interrupt_maybe_sent`, it performs one exact-intent
  read, persists an exact terminal outcome when present, or records a transient
  failure without issuing a second interrupt.
- The Linux containment library fails before returning a provider boundary when the
  platform, workspace identity, pinned runtime/helper, private configuration,
  approved read tree, ambient system configuration, runtime canary, manifest, or
  exact recovery handle does not match. Recovery permits expected dirty Mission edits
  but never resets or deletes the retained checkout.
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
  due retried work and active or expired leases regardless of cursor age. Both
  reconcile before reading. Every delivery operation also reconciles before applying
  fresh authority or validating exact replay. Deadline wins over dead letter;
  otherwise the earliest unsettled dead-letter cursor is authoritative. Reconciliation
  is serialized with normal Mission mutation, no-ops after terminalization, cancels
  remaining `stored`/`leased`/`executing` work, and fences delayed output.
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
  one terminal Node claim receipt with `claim_outcome: dead_lettered`, which then
  reconciles the Mission to `failed` when the deadline has not already expired it.
- Node credential rotation is a compare-and-swap against the owner-visible active
  credential ID and serializes with workspace mutations. Concurrent rotations from
  one credential generation cannot both succeed. Node revocation atomically disables
  its credential and active workspace bindings and cancels affected active Mission
  deliveries; immutable Mission and operation history remains for audit and recovery
  analysis.

## Product direction and Labs boundary

The mailbox is the core product surface. [`RFC 002`](rfcs/002-agent-reachability-and-durable-mailbox.md)
governs its next priorities: prove that real pairs can address each other, retain
thread context, reply asynchronously, and return to the workflow before adding
autonomous activation. The relay database remains the source of truth; the implemented
SSE signal improves latency but cannot stand in for durable state or a processing
receipt.

The relay also exposes a separate, authenticated Mission and delivery control plane
without stretching the handoff row into a scheduler. That plane, the foreground Node,
the fake and provider-neutral Capsules, the Codex guardian, and Linux containment are
same-repository Labs governed by [`RFC 001`](rfcs/001-agentrelay-node-and-missions.md).
Their remaining gates include contract/artifact carriage, registered verification
execution, descriptor/CLI composition of the authority checkpoint with durable
recovery-handle storage, durable structured execution evidence, adversarial
evaluation, Guarded Real Mission 0, installed service/cgroup containment, and a real
two-machine execution proof. Those gates are retained research work, not the active
product dependency order.
