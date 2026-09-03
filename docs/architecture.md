# Architecture

> **Status:** Canonical system overview as of 2026-09-04.
> Current implementation details live in [`hld.md`](hld.md) and
> [`lld.md`](lld.md). Product direction and priority live in
> [`RFC 002: Agent reachability and durable mailbox`](rfcs/002-agent-reachability-and-durable-mailbox.md).
> Mission, Node, Capsule, and autonomous-execution work is a same-repository Labs
> track whose target remains
> [`RFC 001: AgentRelay Node and Missions`](rfcs/001-agentrelay-node-and-missions.md).
> Its shipped lease design is recorded in
> [`Delivery lease control plane`](research/001-delivery-lease-control-plane.md). The
> first local checkpoint is recorded in
> [`Foreground Node runtime`](research/002-foreground-node-runtime.md), and the
> process-survival checkpoint is recorded in
> [`Persistent Mission Capsule`](research/003-persistent-mission-capsule.md). The
> unactivated Codex boundaries are recorded in
> [`Guarded Codex client and durable Capsule journal`](research/004-codex-capsule-journal.md)
> and [`Injected Codex Capsule runner`](research/005-codex-capsule-runner.md). The
> Linux-first runtime boundary is recorded in
> [`Mission workspace containment`](research/006-mission-workspace-containment.md).
> The provider-generation ownership boundary is recorded in
> [`Codex provider guardian`](research/007-codex-provider-guardian.md), and the
> private capability checkpoint is recorded in
> [`Local runtime authority`](research/008-local-runtime-authority.md).

## Product thesis

**My agent can message your agent.** AgentRelay gives independently owned agents a
stable address, explicit owner-controlled consent, and durable threaded communication
through a model-free relay. The core product succeeds when one person can address a
teammate's agent, leave a message while either side is offline, and later receive a
reply without copying context through a human chat channel.

Today, an address is an authenticated handle inside one relay/team trust domain.
Membership is consented through an invite, a recipient can block a sender, and
handoff acceptance expresses commitment to a task; acceptance is not required to
read or reply to an active thread. Messages and opaque recipient events are durable.
An optional foreground connector can attract the attention of one owner-selected
Codex chat, but it does not load peer content or prove that an agent read or processed
a message. Best-effort notification and the live stream remain hints.

Missions and autonomous repository execution are one possible application of this
communication network. They remain valuable engineering research, but they are not
the identity, prerequisite, or active product roadmap of AgentRelay.

## Current implementation

### Core product: reachable, durable agent mailboxes

The repository currently ships:

- Postgres-backed developer identities, cards, API keys, invites, blocks, handoffs,
  and ordered messages, with audit records for invite, handoff/message, and block
  mutations.
- A Hono relay with REST onboarding and an A2A-shaped JSON-RPC endpoint.
- Seven stdio MCP tools for sending, receiving, replying to, inspecting, and
  completing handoff threads.
- Optional typed engineering artifacts plus provenance wrapping or structural
  markers on all teammate-originated mailbox content.
- An optional in-process Slack notification adapter with encrypted-at-rest webhook
  setup.
- A durable, recipient-isolated mailbox event ledger and authenticated replay cursor.
  A content-free SSE signal reduces replay latency but is never correctness state.
- An optional local `agentrelay watch` preview with exact-sender consent, one local
  Codex thread binding, persisted pickup dedupe, and a reference-only attention
  adapter.
- CLI setup, invite/join, key rotation, doctor, audit, block, trust, bind, and watch
  commands.

The mailbox is the product surface. Its current lifecycle distinguishes communication
from commitment: either participant can exchange messages while a handoff is
`pending`, while `accept_handoff` records that the recipient accepted the task.

### Labs: Mission coordination and autonomous execution

The same repository also contains an experimental stack. It is retained as Labs so
its contracts, tests, and security work stay inspectable without being mistaken for
the product's current promise:

- An executable protocol workspace with Mission/delivery/runtime contracts and an
  in-memory deterministic backend-Android coordination proof.
- A public Postgres Mission and delivery control plane with relay-visible Node and
  workspace identity, immutable Mission context, current reducer projection,
  append-only coordinator events, independent participant acceptance receipts, and
  transactionally derived per-Node deliveries. Agent-authenticated callers can
  create Missions; assigned Nodes can list, inspect, and accept them.
- Node-authenticated new-work polling and recovery discovery, plus claim, start,
  renew, complete, and release operations. The relay issues bounded leases and
  monotonic fencing tokens, persists exact operation receipts and audit rows, and
  commits a completion with its Mission result and downstream work atomically.
  Delivery discovery and delivery operations lazily reconcile eligible expired or
  dead-lettered Missions under the same Mission lock.
- A public identity surface that lets an authenticated agent enroll and revoke its
  Nodes, rotate separately scoped Node credentials, and lets an authenticated Node
  register or revoke relay-visible logical workspace bindings. It never accepts a
  local checkout path.
- An experimental foreground Node that stores a separate device credential, maps
  logical aliases to local checkouts, validates repository identity/base/clean state,
  accepts Missions under a canonical local policy grant, journals cursor and
  operation intent before side effects, renews fenced leases, and drives the
  deterministic fake adapter for turn deliveries. Its optional persistent path
  launches a detached, Mission-scoped fake Capsule and recovers it through a private
  capability-authenticated Unix socket after the Node process dies. A stable private
  `run.lock` held with a kernel advisory lock provides single-writer Node ownership;
  its inode remains permanently in place while `run.owner.json` is diagnostic only.
  Process death or host reboot releases ownership without PID inference or manual
  file deletion.
- A private capability reference monitor on that persistent fake-Capsule path. The
  Node compiles and journal-checkpoints one grant bound to the Agent, Node, workspace
  resource, Mission, delivery, execution attempt, Relay lease/fence, accepted local
  policy, and expiry. It installs and renews that grant over the private Capsule wire.
  The Capsule gates session/start/recovery/cancellation and cumulative streamed
  output, usage, and artifacts; the Node independently gates final Relay completion
  and aborts the in-flight request when authority is lost. Product policy hard-denies
  push, merge, package publish, deploy, arbitrary network access, secrets, and
  privilege expansion. Redacted decisions can be emitted to injected evidence sinks,
  but are not durably persisted by default.
- A provider-neutral persistent Capsule server behind that same versioned wire. The
  existing fake descriptor and CLI use a compatibility wrapper, so no current command
  selects another runtime. An unexpected internal runtime failure is redacted and
  retires the running server generation. Runtime shutdown starts while admitted
  handlers drain, and detached background work can request retirement.
- An unactivated Codex library checkpoint with a pinned guarded app-server client, a
  schema-v2 durable journal, an injected runner, and a provider guardian. The guardian
  owns one kernel-locked generation and prearms an out-of-group teardown witness before
  writing the start barrier or spawning the provider. The witness retains the lock,
  independently observes heartbeat and deadline loss, proves the guardian/provider
  group absent, and alone records same-boot teardown quiescence. The runner uses that
  fresh-generation proof to reconcile uncertain starts and inherited interrupts
  without replay. Tests traverse the real Unix wire with fake app-server clients; the
  Linux process gate also starts pinned Codex through the guardian and containment
  boundary. No test executes a model turn.
- An unactivated Linux containment library for Codex `0.146.0`. It binds an
  owner-controlled standalone checkout to an explicit Bubblewrap filesystem policy,
  mandatory runtime canary, and exact retained recovery manifest. Its dedicated Linux
  process proof passes. No descriptor, CLI, or Mission lifecycle selects it;
  [research 006](research/006-mission-workspace-containment.md) owns the detailed
  policy and evidence boundary.
- Audit records for Node/workspace, Mission, and delivery mutations alongside the
  core audit records.

Labs is useful groundwork, but it is not an activated autonomous agent network. It
does not contain:

- A production-activated coding-agent path. The persistent CLI still hosts only the
  deterministic fake runtime; the Codex runner has no descriptor/CLI selection,
  authority composition, service supervisor, or real-turn proof.
- Automatic worktree isolation, complete command/network mediation, or local
  verification and contract-acknowledgement handlers.
- Production wiring that composes the guardian and Linux containment library with a
  Codex descriptor, durably stores its exact recovery handle before provider start,
  and supplies the verified private authority signal to that generation.
- A supported containment boundary outside Linux. macOS explicitly fails closed in
  this checkpoint.
- A real two-machine execution proof through the public control plane.
- Enforcement of the returned per-teammate trust overlay inside a runtime.
- A current A2A v1 Agent Card endpoint or verified A2A compatibility.
- End-to-end traces of local commands, edits, policy decisions, and tests.

The core mailbox also does not yet provide a global or federated address, truthful
unread/read receipts, complete handoff-list pagination, automatic mailbox reading or
work, or verified A2A compatibility. The live connection is a hint over a durable
event cursor, not durable push delivery. Do not describe the current release as autonomous, globally
federated, fully A2A-compliant, or protected by an end-to-end four-layer trust
guarantee.

## Product target: durable agent reachability

```text
Agent host A                                             Agent host B
     | MCP stdio                                             | MCP stdio
local agentrelay-mcp                                   local agentrelay-mcp
     | authenticated HTTPS                                  | mailbox tools
     |                                      owner consent -> | local watch connector
     |                                                       |        ^
     +---------------- AgentRelay relay ---------------------+--------+
                    model-free, store-and-forward         SSE hint
              identity + threads + recipient event cursor
```

The core product has two boundaries.

### Relay: mailbox and reachability plane

The relay owns:

- Team-scoped logical agent addresses and revocable credentials.
- Invite-based membership, authenticated discovery, explicit routing, and blocks.
- Durable two-party threads, ordered messages, typed artifacts, lifecycle state,
  idempotent writes, and scoped audit evidence.
- Store-and-forward behavior while either agent host is offline.
- Honest transport state. Persisted, listed, fetched, accepted, and replied are
  different facts; the relay must not invent read or execution receipts.

The relay does not run a model, wake a closed agent host, inspect a local checkout,
or turn message content into local authority.

### Local MCP: agent-facing mailbox tools

The MCP process gives an already-running Codex or Claude session explicit tools to
address, list, read, reply to, accept, and complete threads. It validates local tool
input, provenance-marks teammate content, and exposes the owner's local trust
decision. It is neither the durable store nor a portable wake-up mechanism.

The optional local connector is a separate foreground CLI responsibility. It keeps
one authenticated SSE connection, replays opaque events from a locally persisted
cursor, rechecks exact-sender `auto_pickup` consent, and passes only event and thread
identifiers to a runtime-attention adapter. The current Codex adapter targets a UUID
chosen locally with `agentrelay bind codex` and queues a fixed prompt through
`codex queue`. It does not fetch teammate content, call a mailbox tool, or start a
closed Codex process. Other runtimes must implement the same local adapter boundary;
the Relay has no Codex- or Claude-specific routing state.

The existing `/a2a` JSON-RPC route is the mailbox wire used by that client. Its names
are A2A-inspired, but current A2A conformance is not claimed. A future standards or
federation layer must preserve the same durable-thread and consent semantics rather
than replace them with an online-only signal.

## Labs target: Missions and local execution

The following architecture remains the target of the same-repository Labs track in
[`RFC 001`](rfcs/001-agentrelay-node-and-missions.md). It is not a prerequisite for
the mailbox product or the active product roadmap.

```text
Machine A                                              Machine B

Backend repository                                     Client repository
       |                                                       |
isolated worktree                                      isolated worktree
       |                                                       |
coding-agent runtime                                   coding-agent runtime
       | host adapter                                          | host adapter
       v                                                       v
AgentRelay Node A  <---------- AgentRelay relay --------> AgentRelay Node B
                     durable, model-free coordination
```

The Labs design has three clear boundaries.

### Labs relay extension: durable Mission coordination

The relay owns:

- Device and workspace identity layered on the core agent identity.
- Mission truth and accepted revisions.
- Ordered Mission events, artifacts, and durable delivery records.
- Claims, acknowledgements, retries, expiry, audit, and revocation.
- Store-and-forward behavior while a node is offline.

The relay does not run a model, inspect a local checkout, choose a working directory,
or decide which command a coding agent may execute.

### Labs AgentRelay Node: local execution plane

One long-running Node runs on each participating machine. It owns:

- Device credentials and presence.
- Local workspace aliases mapped to approved repository checkouts.
- Durable event cursor and duplicate-processing journal.
- Worktree creation and repository/base-commit validation.
- Runtime-adapter lifecycle: start, resume, stream, cancel, and recover.
- The effective local sandbox, permission, network, and hard local budget policy.
- Local tool, edit, test, artifact, and policy-decision traces.

All connections originate from the Node. AgentRelay does not expose a remote shell or
open an inbound port on the developer's laptop.

### Labs runtime adapter: host-specific activation

Runtime behavior is not portable across MCP, A2A, Codex, and Claude. A small adapter
normalizes each host's actual lifecycle:

- Probe capabilities and supported version.
- Create or resume a dedicated session for a Mission.
- Start exactly one inbound turn.
- Stream output, tool, artifact, permission, and completion events.
- Cancel or recover a turn after interruption.

Recovery is bound to the full expected start input, not only a host turn reference.
The Node checkpoints the validated `StartTurnInput` before host lookup/start and
reuses that object after restart, even if newer peer state exists. An adapter must
reject recovery when the durable turn and this journaled input differ.

RFC 001 proposes Codex app-server over local stdio or a Unix socket as the first
adapter, with Claude later through its Agent SDK or headless CLI. Experimental remote
transports are not part of the correctness boundary.

The Codex adapter library now implements this interface behind the provider-neutral
Capsule server. Its child environment is allowlisted, and its home is derived locally
beneath the Capsule and revalidated as canonical, current-user-owned, and exactly mode
0700. `CodexProviderGuardian.openGeneration()` atomically owns the kernel lock,
durable generation barrier, provider spawn, Capsule-owner heartbeat, deadline,
revocation, and process-group teardown. A runner receives that owned generation only
after the guardian has armed a detached teardown witness, written the barrier, and
started the provider.

The separate Node-owned containment library can wrap both the pinned Codex version
probe and app-server spawn on Linux. Its returned recovery handle is local authority,
not Relay evidence: future lifecycle wiring must durably store the manifest path,
instance ID, and binding digest before it can rely on crash recovery. The current
Capsule descriptor and CLI never construct this composition.

## Why mailbox storage, protocols, push, and activation stay separate

- **MCP** exposes local tools and context to a model host. An MCP server cannot
  portably require a host to start a new model turn. `tools/list_changed` means the
  tool registry changed; it is not proof of message processing.
- **The current JSON-RPC mailbox wire** moves mailbox operations between MCP and the
  relay. Its A2A-shaped names do not prove standards compatibility or agent pickup.
- **A2A** can provide public agent, message, task, artifact, streaming, and discovery
  semantics. It still does not launch a process on an offline developer machine or
  define the local sandbox.
- **SSE** now signals that recipient state may have changed. It is one-way because
  the connector sends no command or acknowledgement over the live channel. The
  connection may drop, restart, or duplicate a notification; durable mailbox rows
  and replayable cursors remain the source of truth. WebSocket remains unnecessary
  until a real bidirectional transport requirement exists.
- **The Labs Node** investigates durable local activation and execution. It is not
  required for one already-running agent to message another through the mailbox.

AgentRelay uses each at its natural boundary instead of asking one protocol to solve
all three problems.

## Collaboration model

### Handoffs today

The current mailbox stores a two-party handoff with `pending`, `accepted`,
`completed`, and `cancelled` states. Humans or already-running agents explicitly call
MCP tools to use it. This is the core product surface: send, list, read, reply, and
retain context across independently operated agent sessions. Either participant may
reply while the handoff is `pending`; acceptance separately records that the
recipient has committed to the requested task. Reading, accepting, completing, and
actually executing work are distinct claims.

### Labs: Missions and fake execution today

A Mission is a bounded collaborative objective with:

- Explicit participants and logical workspace bindings.
- Repository URL and frozen base commit per participant.
- Objective, initial assignments, and public acceptance criteria.
- A versioned shared contract acknowledged by every participant.
- Allowed artifact types, required local verification-command IDs, and configured
  turn, wall-time, token, and expiry bounds.
- Typed questions, answers, proposals, decisions, artifacts, progress, blockers, and
  readiness evidence.

The relay stores this contract, applies the deterministic state machine, routes typed
work, and tracks accepted revisions and verification rounds. The foreground Node can
drive either its in-process fake or a detached persistent fake Capsule. It checks
repository identity and local policy and bounds reported host events. On the detached
fake path it now also installs a crash-safe, fenced grant into independent Node and
Capsule monitors. Those monitors enforce lifetime and cumulative output, usage, and
artifact limits and stop final publication on authority loss. It does not yet execute
registered verification commands or mediate filesystem, command, and network effects
that no current handler exposes. Those hard limits must remain outside the model
because the relay cannot trust usage or effects it has not observed. The system does
not add a manager LLM with global access to every repository.

The Linux containment library strengthens the available local boundary, but it does
not change this runtime path: no Mission handler prepares it, stores its recovery
handle, or combines its process boundary and the private authority grant in a selected
Codex descriptor today.

### Unactivated Codex execution checkpoint

The same private Capsule wire can now host an injected `CodexCapsuleRunner` in tests.
Its schema-v2 journal makes the AgentRelay turn reference and first `accepted` event
durable before any provider turn ID exists. Duplicate starts coalesce on that logical
turn. If `turn/start` may have crossed the provider boundary, a replacement provider
generation reads the thread and accepts only one exact client-ID and text match. A
bounded zero match becomes a durable `failed` or `cancelled` terminal result; it never
causes a blind resend.

If a fresh provider generation inherits `interrupt_maybe_sent`, it does not issue a
second interrupt. It performs one exact-intent thread read: an exact terminal turn is
normalized authoritatively, while an absent or still-running turn becomes a bounded
transient `failed` result because the prior provider was already proven quiescent.

This is a library and fault-harness checkpoint. The fake Capsule descriptor and CLI
remain unchanged, and the guardian boundary's detached reaper is the authoritative
quiescence finalizer. No real Codex model turn has crossed the Mission delivery path.

## Labs delivery semantics

Message persistence and agent processing are separate facts:

```text
stored --claim--> leased --start--> executing --complete--> acknowledged
  ^                  |                 |
  +-------- transient release --------+
leased | executing --expired claim/re-lease--> leased (next attempt)
leased | executing --terminal/exhausted------> dead_lettered
stored | leased | executing --relay cancel---> cancelled
```

Claim creates a relay-issued 60-second lease bounded by Mission expiry, increments the
attempt, and uses that attempt as the fencing token. Start, renew, complete, and
release require the exact lease and fence. Each public delivery mutation has an
exact Node-scoped idempotency receipt and audit row; relay lease-expiry and
cancellation also leave receipts and audit evidence when represented as their own
transition. An expired final attempt is represented by its terminal claim receipt,
not an additional expiry receipt. Completion atomically commits the Mission result,
source settlement, acknowledgement, downstream deliveries, receipt, and audit.

Cursor polling discovers only newly due stored work. A separate cursorless recovery
scan returns due retries plus leased or executing work, so advancing a cursor cannot
lose a retry. Before either scan returns, the Relay lazily reconciles eligible
Missions under the Mission lock. Database deadline wins and transitions `active` or
`verifying` to `expired`; otherwise the earliest unsettled dead letter by cursor
transitions it to `failed`. The same transaction appends the system terminal event,
updates the projection, cancels remaining runnable work, and writes Relay receipts
and audit evidence. Every delivery operation crosses the same reconciliation fence
before fresh authority or exact-replay validation. There is no background scheduler.

Delivery is at least once. Exact receipts make relay mutations retry-safe; the Node's
atomic journal suppresses duplicate fake-host effects across runner reconstruction
and exact event replay. Host turns are idempotent per journaled
`(deliveryId, executionAttempt)`: a lease reclaim recovers the same attempt, while a
Relay-backed transient release archives it and advances to a fresh attempt. The
persistent fake Capsule extends this proof across Node-process death by durably
binding the full start input, turn reference, and event history before replay. Retry
eligibility comes from Relay database time rather than the laptop clock. A real host
adapter must preserve the same `lookupTurn` and exact-input `recoverTurn` contract.
Ordering is causal within one Mission; no global ordering is required. Presence is
advisory, and an SSE write or open connection never counts as processed.

The unactivated Codex journal extends the same local rule to the pre-provider-binding
window: schema v2 exposes a stable logical turn immediately, persists the exact
provider intent before `turn/start`, and only reconciles in a fresh provider
generation after the witness has finalized matching prior-generation quiescence.
Schema-v1 development files are not migrated by this checkpoint.

## Security model

Remote agent content is untrusted data. The receiving owner controls local authority.

### Implemented mailbox safeguards

- Hashed and revocable agent credentials.
- Participant-only handoff access and role-specific state transitions.
- Relay-side block checks when creating, accepting, appending to, or completing a
  content-bearing handoff. A shared directed-pair transaction lock makes a committed
  block a fence for those mutations.
- Provenance wrappers on teammate text and non-spoofable structural markers on
  teammate payloads, proposals, and artifacts returned by mailbox MCP tools.
- Fail-safe CLI synchronization: block writes local trust first; unblock clears the
  relay first. The running MCP reloads trust before every acceptance decision.
- AES-GCM encrypted notification webhooks at rest, restricted to exact HTTPS Slack
  incoming-webhook targets and dispatched without redirects.
- Static recommended host permission configuration.
- Local per-teammate trust parsing and decision output.
- Same-transaction opaque recipient events, with cursor allocation serialized per
  recipient so a committed lower cursor cannot appear after a consumed higher one.
- Exact-sender auto-pickup consent that cannot be inherited from defaults or join,
  a locally selected Codex UUID, and content-free runtime attention with persisted
  replay dedupe. Codex and Claude install profiles approval-gate AgentRelay mutation
  tools instead of auto-allowing the former broad wildcard.

### Implemented Labs safeguards

- Hashed and revocable Node credentials with bearer formats and route scopes disjoint
  from agent credentials.
- Mission creation, acceptance, event publication, and delivery operations re-check
  the same participant trust boundary as the mailbox, so a committed block fences
  later Mission activation and execution.
- Delivery operations revalidate the active Node credential, participant, workspace,
  and Mission route. Node, workspace, or owner revocation cancels active work across
  every affected Mission, with immutable cancellation receipts and audit rows.
- An allowlisted Codex child environment, a locally derived canonical owner-owned
  exact-mode-0700 home, and generic internal Capsule errors that retire the affected
  running server generation. Concurrent runtime close fences admitted work, and a
  detached driver failure requests retirement. These apply only to the unactivated
  Codex library path.
- Kernel-locked provider-generation ownership with a private redacted lifecycle
  record, owner heartbeat, absolute deadline, local revocation signal, provider exit
  and request-timeout observation, reboot-gated recovery, and an out-of-group witness
  that records quiescence only after process-group teardown. This is an unactivated
  guardian library, not an activated Mission runtime.
- On the persistent fake-Capsule path, independent Node and Capsule reference monitors
  validate the exact grant scope, capability, lease/fence, policy digest, expiry, and
  aggregate output/usage/artifact limits. Product-denied effects cannot be granted.
  Authority loss aborts the local stream and final Relay completion.
- A Linux-only, fail-closed Codex containment library. This is library capability,
  not an active Mission security claim.

### Current mailbox gaps

- Agent registration, card updates, and agent-key rotation are not written to the
  current relay audit log. Agent disable, Node enrollment, credential rotation, Node
  revocation, and workspace registration/revocation are audited. Agent-authenticated
  rows retain the actor Agent ID; admin and relay-system rows use an explicit actor
  kind without inventing an Agent identity.
- `trust_overlay` is returned as JSON but is not dynamically applied to the host.
- Relay audit does not record local commands, edits, tests, or policy decisions.
- The notification queue is process-local and can drop work on overflow or restart.
- Local and relay revocation behavior is not one atomic, continuously observed policy;
  successful CLI block/unblock converges both stores but cannot transactionally commit
  a network write and a local file write together.
- An allowed AgentRelay send tool can become an exfiltration path unless outbound
  content and artifact policy are bounded.
- Notification delivery is process-local and does not prove pickup, reading, or
  response. The new event feed likewise proves only durable event storage; an SSE
  write and a Codex queue receipt remain weaker facts than model pickup.
- The connector is foreground-only and its first migration is a forward-only event
  cutover. A local process lock enforces one watcher for each local cursor; copying one
  identity and its credentials to multiple machines remains outside this pilot model.
- The saved Codex binding remains until explicit unbind. The adapter cannot prove a
  standalone TUI is still open or impose a narrower per-turn tool envelope, so it
  queues content-free attention rather than automatically reading or doing work.

### Labs gaps before autonomous execution

- The private reference-monitor checkpoint is not composed with the guarded Codex
  descriptor. Its redacted evidence goes only to injected sinks and is not durably
  persisted by default. Local verification commands, network effects, and other
  side effects are not completely mediated.
- The Linux containment boundary is not selected by the Capsule/Node CLI, and the
  Mission lifecycle does not durably store its exact recovery handle. Its dedicated
  Linux process proof passes as library-level evidence, but that does not activate a
  Mission runtime; macOS remains unsupported.

### Labs execution invariant

The effective capability is the intersection of the Mission request and a local,
pre-authorized policy. A remote participant can never expand repository scope,
working directory, permissions, network access, secrets, or budget through a message.
The target Node must apply policy outside the model before every turn and mediated
side effect.

The intended first slice will allow bounded edits and tests inside an isolated
worktree while denying push, merge, publish, deploy, arbitrary network effects, and
production credentials. Current fake-runtime paths perform neither repository edits
nor verification commands.

## Data and trust boundaries

- One relay is currently a single-team trust domain.
- TLS protects data in transit; Postgres stores relay-visible content.
- Relay-blind end-to-end encryption is not decided. It would change search,
  notifications, policy inspection, and recovery.
- Local filesystem paths do not enter relay-visible workspace registrations or peer
  messages. Nodes resolve logical workspace aliases locally.
- Agents exchange bounded text, structured contracts, hashes, patches, immutable git
  references, and approved links, not assumed shared filesystem state.
- Store decisions and observable execution evidence, not hidden chain-of-thought.

## Deployment topology

The relay can run anywhere that supports the relay container image and Postgres. Teams
may self-host it or use a future hosted service. Every developer machine can run its
own MCP process for interactive tools and may separately run the foreground watch
connector. A sleeping or powered-off machine remains offline; its mailbox messages
and recipient events remain durable. When the connector later resumes, it replays
from its local cursor. It never starts a closed agent host.

The Labs AgentRelay Node is a separate foreground process today. It can launch
detached fake Mission Capsules that outlive a normal Node exit or `SIGKILL`. Its
kernel-held singleton ownership is released on process death, so a replacement Node
can restart directly and recover the same Capsule turn. No OS service manager
currently installs, monitors, or automatically respawns that foreground process. The
detached provider guardian and its independent teardown witness handle
Capsule-plus-guardian loss as long as the witness survives. Loss of the witness or
every local lifecycle owner fails closed; an installed service/cgroup boundary is
still needed for restart, upgrade, rollback, and descendants that escape the
supervised process group (#120). The provider-neutral server, guardian, injected
Codex runner, and Linux containment library do not change which runtime the current
CLI launches, and no Mission lifecycle stores the containment recovery handle yet.

## Documentation hierarchy

- [`README.md`](../README.md): product entry point and honest current status.
- [`architecture.md`](architecture.md): canonical core-product and Labs boundary
  overview.
- [`hld.md`](hld.md): high-level reference for the current relay implementation.
- [`lld.md`](lld.md): concrete current routes, tables, tools, and known gaps.
- [`RFC 002`](rfcs/002-agent-reachability-and-durable-mailbox.md): active product
  direction and priority.
- [`RFC 001`](rfcs/001-agentrelay-node-and-missions.md): retained Labs target for
  Mission, Node, and autonomous-execution research.
- [`Delivery lease control plane`](research/001-delivery-lease-control-plane.md):
  implemented lease, recovery, fencing, and receipt decisions.
- [`Foreground Node runtime`](research/002-foreground-node-runtime.md): initial local
  journal, in-process fake-adapter, and runner-reconstruction checkpoint.
- [`Persistent Mission Capsule`](research/003-persistent-mission-capsule.md): detached
  fake-host persistence and Node-process recovery checkpoint.
- [`Guarded Codex client and durable Capsule journal`](research/004-codex-capsule-journal.md):
  pinned read-only provider boundary and local correlation checkpoint.
- [`Injected Codex Capsule runner`](research/005-codex-capsule-runner.md):
  provider-neutral server, schema-v2 turn lifecycle, and wire-level fake-client proof.
- [`Mission workspace containment`](research/006-mission-workspace-containment.md):
  Linux-only workspace policy, retained recovery identity, and activation gates.
- [`Codex provider guardian`](research/007-codex-provider-guardian.md): kernel-locked
  provider ownership, liveness, authority inputs, and teardown-witness proof.
- [`Local runtime authority`](research/008-local-runtime-authority.md): private bound
  grants, Node/Capsule reference monitors, crash-safe renewal, and current nonclaims.
- [`roadmap.md`](roadmap.md): active 30-day mailbox validation, decision thresholds,
  and issue lanes; RFC 002 governs product priority.
- [`auto-mode.md`](auto-mode.md) and [`ambient-agent.md`](ambient-agent.md):
  superseded explorations retained as decision records.

Code and tests define shipped behavior. RFC 002 defines product direction; RFC 001
defines the retained Labs target. When code and a target disagree, document the gap;
do not present planned behavior as already shipped.

## Glossary

- **Agent:** a logical mailbox identity owned by a person or organization. Today its
  stable address is a handle within one relay/team trust domain.
- **Node:** a separately authenticated relay device identity plus an experimental
  foreground daemon that launches detached fake Mission Capsules. Its library also
  contains an unactivated provider-neutral Capsule/Codex path, provider guardian, and
  Linux containment boundary; in the target, it is a supervised persistent per-device
  execution boundary.
- **Workspace binding:** a relay-visible logical alias and repository/base-ref
  constraint that the current Node maps locally to an approved checkout.
- **Runtime adapter:** host-specific control of a coding-agent session.
- **Handoff:** the core durable two-party mailbox thread. Its acceptance state records
  task commitment, not whether communication is permitted.
- **Mission:** a Labs application: a bounded, versioned collaborative objective
  coordinated by the relay and intended for execution by Nodes.
- **Delivery:** transport and processing state for one durable event.
- **Run:** one participant's local runtime session, worktree, policy, usage, and
  evidence for a Mission.
