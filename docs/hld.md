# High-level design: current relay implementation

> **Scope:** Current repository implementation as of 2026-08-21.
> This document describes the existing handoff plane, public Mission delivery
> control plane, experimental Node, and guarded Codex runtime checkpoints.
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
adapter or a detached persistent fake Mission Capsule. A provider-neutral Capsule
server, injected Codex runner, provider guardian, strict descriptor, provisioner, and
persistent adapter now exist behind that wire as a guarded checkpoint. Internal APIs
compose them under private authority, but the polling CLI still chooses the fake. The
guardian owns provider-generation spawn and live supervision; its prearmed detached
witness owns post-absence quiescence finalization. No current command activates a real
model turn. A separate Linux-only
containment library can construct the pinned Codex `0.146.0` Bubblewrap boundary. The
internal Codex composition binds exact policy-selected read or write containment to
its durable descriptor. Read mode may continue to the guardian; write mode recovers a
workspace-global patch mediator before the guardian and registers only
`agentrelay.apply_patch/v1` while the provider mount remains physically read-only. The
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
              identity, handoffs, Missions, delivery, audit
                              |
                   best-effort Slack webhook

Experimental path on each machine:
agentrelay-node -> atomic local journal
        |-- in-process deterministic fake adapter
        `-- private grant + Unix socket -> provider-neutral Capsule server
                                      |-- selected today: deterministic fake
                                      `-- internal only: guarded Codex controller
                                               -> detached guardian process group
                                                  |-- pinned provider + descendants
                                                  `-- spawns detached teardown witness
                                                      outside the process group
                                               -> trusted exact patch mediator

Internal Linux composition (not selected by a polling command):
owner-prepared checkout -> policy-selected containment -> pinned Codex sandbox/app-server
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
  audit consequences in one transaction. Delivery discovery and delivery operations
  lazily reconcile eligible terminal causes under the same Mission lock.
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
emit bounded redacted decisions to injected sinks; no general durable authority-
evidence sink is wired for those monitors by default. Owner-local policy may explicitly
add workspace-write authority; omitted
or explicit read preserves the legacy read-only grant and policy hash. See
[research 008](research/008-local-runtime-authority.md).

The wire server is now provider-neutral and accepts a locally injected runtime while
preserving the versioned request/response contract. Schema v1 selects the fake runtime;
a strict schema-v3 descriptor selects the passive Codex controller and exact retained
containment identity. The library also contains a `CodexCapsuleRunner` with probe,
session, start/recover, event, and cancellation behavior. Its state schema 4 exposes a
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
An internal Node factory runs the non-claiming doctor, then pairs the Codex provisioner
and persistent adapter under the private authority monitor. No polling CLI selects
that factory. Its Codex-only launcher can transfer one fresh opaque owner credential
per Capsule generation over fixed inherited fd 3; a controller launched from a
validated descriptor schema 3 owns the channel under one non-resettable 30-second
activation deadline.
Authority-gated provider activation consumes it once for API-key login, then reads the
resulting API-key account state with refresh-token loading disabled. Codex's credential
store is forced ephemeral. The credential appears in neither argv, environment,
durable state, nor `auth.json`. The exact app-server command now selects a retained
Linux profile with Codex-managed CONNECT access only to `api.openai.com`; version
checks, containment probes, and nested workspace sandboxes remain offline. Its exact
argv pins agents and web search off and disables shell, hooks, plugins, apps,
multi-agent, and code-mode features, so no command tool is registered. The provider
process uses its private runtime home as the operating-system working
directory while thread RPCs carry the logical workspace separately. Launch arguments
and per-thread configuration pin that workspace as untrusted. Before start or resume,
bounded `config/read` requires untrusted project state, `shell_tool=false`, and no
effective MCP servers. Afterward, the feature list must contain exactly one disabled
shell tool, the private-home configuration is rechecked, and a private `config.toml`
is rejected. Thread start and every turn select an empty Codex environments list,
suppressing environment-backed shell and native `apply_patch` registration in pinned
Codex `0.146.0`. Resume is allowed only when the stored thread is not
already loaded in that provider process. Under exact local write authority, only
`agentrelay.apply_patch/v1` is registered and accepted. The Capsule durably binds each
request and receipt to provider, Host-turn, and authority identity; the trusted
workspace-global mediator compiles and applies the bounded transaction outside the
read-only provider sandbox. The command flags alone leave native patch eligibility
model-dependent, but the effective path exposes no native file-change tool; any
unexpected file-change approval is declined and made fatal. Command, permission,
user-input, MCP, and other dynamic-tool requests also
remain denied and fatal. There is still no owner-facing credential source,
real model-turn proof, or Claude equivalent. The Codex child environment is allowlisted,
and its private home is derived locally beneath the Capsule and revalidated as
canonical, current-user-owned, and exactly mode 0700. For an inherited
uncertain-interrupt barrier, a fresh generation reads the exact intent once, persists a
terminal provider outcome when present, or records a transient failure only after
proving zero durable patch calls for the exact Host/provider turn. Otherwise the
outcome remains unproved and nonterminal. It never resends the interrupt.
Detailed guardian mechanics live in
[research 007](research/007-codex-provider-guardian.md).

The separate Linux containment library binds an owner-controlled standalone checkout
to an explicit Bubblewrap policy, mandatory runtime canary, and private
`retain_for_review` manifest. Recovery requires the exact manifest path, instance ID,
and binding digest. The internal Codex provisioner stores that handle durably in the
v3 descriptor before Capsule launch and strictly reopens it during dirty recovery;
once any retained same-Mission delivery has a start intent or host-attempt history,
later provisioning is recovery-only rather than creating a new boundary over that
dirty checkout. Current polling commands do not select this path. The
[original containment checkpoint](research/006-mission-workspace-containment.md)
records the earlier offline policy; current mechanics live in the
[low-level design](lld.md#guarded-linux-containment-checkpoint).

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
- Deterministic lazy terminal reconciliation: deadline maps eligible Missions to
  `expired`, otherwise the earliest unsettled dead letter maps them to `failed`, with
  one system event, remaining-work cancellations, receipts, and audits committed
  atomically.
- Node enrollment, credential rotation/revocation, logical workspace registration,
  exact workspace replay, and atomic Node-to-credential/workspace revocation. Node,
  workspace, and owner revocation also cancel active work across affected Missions.
- Mission trust checks share the block-pair transaction fence, and every delivery
  mutation revalidates its active Node, participant, workspace, and Mission route.
- At the guarded library/test boundary, the provider-neutral Capsule wire, Codex
  state schema 4 and adapter identity 0.4.0, stable pre-binding turn, exact fresh-
  generation one-read reconciliation, fail-closed patch-call abandonment, pre-binding
  cancellation, and conservative
  inherited-interrupt terminalization are durable.
- At that same guarded boundary, a stable kernel lock excludes overlapping
  generations. The guardian supervises owner/provider liveness, deadline, and local
  revocation. Its prearmed out-of-group witness terminates and proves the process group
  absent, then authoritatively records durable quiescence; the Capsule waits for that
  proof before releasing replacement authority.
- At the internal provisioning boundary, the exclusive Linux Codex containment
  manifest durably binds the workspace, pinned runtime, private paths, policy grant,
  and `retain_for_review` decision. The v3 descriptor retains its exact recovery handle
  before Capsule launch. The dedicated Linux process job passes as evidence for this
  library boundary, not as Mission activation evidence.
- On the persistent Capsule path, Node journal schema 4 durably stores
  one exact active grant or one predecessor awaiting proven retirement. Independent
  Node and Capsule monitors enforce its scope,
  capability set, lease/fence, renewal, expiry, product denials, and aggregate
  output/usage/artifact limits. Authority loss stops streaming and final Relay
  completion. Decision records are emitted only to an injected evidence sink, and no
  durable sink is selected by default.
- On the internal Codex write path, the provider remains physically read-only and can
  request only `agentrelay.apply_patch/v1`. Capsule state durably binds each call to the
  provider and Host turn plus exact active authority before the separately locked
  workspace mediator acts. The mediator's transaction intent, workspace plan, blobs,
  result, rejection, or indeterminate state survive restart. Exact core inspection,
  receipt persistence, terminal-history attestation, and ordered teardown are required
  before a turn result is publishable.

### Best effort today

- Slack dispatcher execution. Webhook URLs are encrypted before storage, but the
  queue is in memory, has a finite capacity, and can lose jobs across process restart.
- Human or active-session pickup. `check_inbox` is explicit polling.

### Not implemented today

- A production-activated coding-agent runtime session. The Node/Capsule process proof
  still exercises only the deterministic fake; the injected Codex runner is covered
  only by fake-client wire tests and has not executed a model turn.
- Automatic Node installation, OS service supervision, or process respawn. The
  singleton kernel lock now permits direct restart after process death, but it does
  not start the replacement Node.
- A polling Codex command that supplies a credential from an approved owner-facing
  source, selects the fixed provider-only egress and mediated-write boundaries, and
  completes local capability enforcement around every supported side effect.
- Production activation of the internally composed Linux containment boundary. Its
  exact recovery handle is already durable before Capsule launch and its dedicated
  Linux process proof passes, but macOS has no supported equivalent.
- Automatic worktree isolation and complete per-Mission command/network mediation.
- Contract-acknowledgement and registered verification-command delivery handlers.
- Durable local command, edit, test, authority, and permission-decision audit.
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

At the guarded Linux checkpoint, the Node can also require an owner-controlled
standalone checkout and bind exact locally selected logical read or write authority
while keeping the provider workspace and Git metadata read-only inside containment.
Logical write authority is available only through the trusted patch mediator; the
containment still has explicit read, write, and denied roots, private home/temp, fixed
provider-only managed CONNECT egress, offline probes and nested workspace sandboxes,
rejected ambient
Codex configuration, a provider process working directory inside the private runtime
home rather than the logical workspace, locally pinned untrusted project state,
effective shell/MCP attestation, empty thread/turn environment selection, cold-only
resume, exact acceptance of only the locally mediated patch request, and fatal denial
of every other server-initiated request,
disabled legacy Landlock, recursive read-tree alias inspection, and a mandatory
runtime canary. No polling command activates a Mission under these protections yet.

On the persistent Capsule path, the bound grant is enforced outside the
model before runtime lifecycle operations, streamed output/usage/artifacts, and final
Relay completion. Its four limit sources intersect monotonically, and product-denied
effects remain denied even if a peer or Mission asks for them. The internal Codex
composition uses fixed provider-only egress and keeps the provider mount read-only.
Owner-local policy may grant logical workspace write and provision the matching
containment; the only model-requested effect is the exact durable patch mediator. No
polling command selects either mode, and verification execution remains ungranted.

They are not yet one end-to-end enforcement system:

- The computed trust overlay has no production consumer that changes host policy.
- Block writes local trust first and unblock writes the relay first. Successful
  commands converge both stores, while partial failure leaves local denial active;
  the network and filesystem writes are still not one atomic transaction.
- Several relay mutations have no audit row, and relay audit cannot say which local
  commands or edits happened because of a handoff.
- Outbound AgentRelay tools are not constrained by a Mission-specific data policy.

Autonomous execution must still wait for the Node to activate this boundary around a
real runtime and mediate every concrete command, network, path, and side effect outside
the model. See the security section of [`architecture.md`](architecture.md).

## Failure behavior

- If Postgres is unavailable, relay requests fail; there is no alternate durable
  store.
- If a notification fails, the persisted handoff remains available for polling.
- If the MCP process exits, no manual mailbox tool call is processed until a host
  starts it again. A separately running foreground Node can continue Mission polling.
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
- The guarded Codex guardian prearms an out-of-group teardown witness before it
  writes `spawn_maybe_started` or spawns the provider. Capsule loss, guardian loss,
  provider exit, request timeout, deadline, revocation, and explicit shutdown converge
  through one latched cause. The witness sends bounded TERM/KILL to the complete
  guardian/provider group, proves it absent, then records quiescence and closes its
  inherited lock. The Capsule independently proves absence, waits for that matching
  record, and only then releases its lock. Capsule-plus-guardian death therefore
  converges while the witness survives. Witness loss or loss of every lifecycle owner
  fails closed; installed service/cgroup recovery and escaped descendants remain #120.
- The runner resolves an uncertain `turn/start` in the guardian-owned fresh generation
  with one authoritative thread read, never by resending. An exact terminal client-ID
  and text match is finalized; an absent or still-`inProgress` bound turn can be
  abandoned only after the patch coordinator proves zero durable calls for that exact
  Host/provider turn. Prior Codex Capsule state schemas are not migrated to state
  schema 4. If
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

## Relationship to the next design

The mailbox remains a compatibility and inspection surface. The relay exposes a
separate, authenticated Mission and delivery control plane without stretching the
handoff row into a scheduler. The foreground Node now consumes one turn through that
API with either an in-process fake or a detached persistent fake Capsule. A pinned
Codex client, injected runner, provider guardian, strict descriptor, provisioner,
persistent adapter, and durable patch mediator now form an internal activation path
whose provider stays physically read-only. Its dedicated Linux process proof starts
pinned Codex through both guarded boundaries, while the
non-claiming doctor verifies the pinned runtime without Relay work. The next gates are
an owner-facing credential source and polling composition that selects the fixed
provider-only egress and mediated-write boundaries,
contract/artifact carriage,
registered verification execution, durable structured execution evidence, adversarial
evaluation, and Guarded Real Mission 0 through the public pipeline. Installed
service/cgroup containment,
witness/all-owner loss, escaped descendants, and restart/upgrade/rollback remain #120.
The two-machine proof follows; see the roadmap for the dependency order.
