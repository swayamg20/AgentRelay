# Architecture

> **Status:** Canonical system overview as of 2026-08-21.
> Current implementation details live in [`hld.md`](hld.md) and
> [`lld.md`](lld.md). The accepted next target lives in
> [`RFC 001: AgentRelay Node and Missions`](rfcs/001-agentrelay-node-and-missions.md),
> and the shipped lease design is recorded in
> [`Delivery lease control plane`](research/001-delivery-lease-control-plane.md). The
> first local checkpoint is recorded in
> [`Foreground Node runtime`](research/002-foreground-node-runtime.md), and the
> process-survival checkpoint is recorded in
> [`Persistent Mission Capsule`](research/003-persistent-mission-capsule.md). The
> guarded Codex boundaries are recorded in
> [`Guarded Codex client and durable Capsule journal`](research/004-codex-capsule-journal.md)
> and [`Injected Codex Capsule runner`](research/005-codex-capsule-runner.md). The
> Linux-first runtime boundary is recorded in
> [`Mission workspace containment`](research/006-mission-workspace-containment.md).
> The provider-generation ownership boundary is recorded in
> [`Codex provider guardian`](research/007-codex-provider-guardian.md), and the
> private capability checkpoint is recorded in
> [`Local runtime authority`](research/008-local-runtime-authority.md).

## Product thesis

AgentRelay gives independently owned AI agents a secure, persistent way to discover,
communicate, and collaborate across devices and runtimes.

The first proof is software delivery across repositories: a backend agent and an
Android or frontend agent should be able to negotiate a shared contract, implement
their local work, exchange evidence, and finish with compatible, tested changes. The
network is broader than this one workflow; Missions and code artifacts are the first
application on top of it.

## Current implementation

The repository currently ships an authenticated asynchronous mailbox plus its first
durable coordination foundations:

- Postgres-backed developer identities, cards, API keys, invites, blocks, handoffs,
  and messages, with audit records for invite, handoff/message, block,
  Node/workspace, Mission, and delivery mutations.
- A Hono relay with REST onboarding and an A2A-shaped JSON-RPC endpoint.
- Seven stdio MCP tools for sending, receiving, replying to, inspecting, and
  completing handoff threads.
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
- A private capability reference monitor on the persistent Capsule path. The
  Node compiles and journal-checkpoints one grant bound to the Agent, Node, workspace
  resource, Mission, delivery, execution attempt, Relay lease/fence, accepted local
  policy, and expiry. It installs and renews that grant over the private Capsule wire.
  The Capsule gates session/start/recovery/cancellation and cumulative streamed
  output, usage, and artifacts; the Node independently gates final Relay completion
  and aborts the in-flight request when authority is lost. Product policy hard-denies
  push, merge, package publish, deploy, arbitrary network access, secrets, and
  privilege expansion. Redacted decisions can be emitted to injected evidence sinks,
  but are not durably persisted by default. The selected polling command uses this
  boundary only with the fake Capsule; internal Codex composition uses the same
  authority surface during provisioning and activation.
- A provider-neutral persistent Capsule server behind that same versioned wire. The
  existing fake descriptor remains schema v1, while a strict schema-v3 descriptor can
  select the passive Codex controller. No polling command selects that descriptor. An
  unexpected internal runtime failure is redacted and
  retires the running server generation. Runtime shutdown starts while admitted
  handlers drain, and detached background work can request retirement.
- A guarded Codex checkpoint with a pinned app-server client, Capsule state schema 4,
  strict launch descriptor v3, persistent adapter identity 0.4.0, provisioner,
  injected runner, and provider guardian. The provisioner writes the exact locally
  selected read or write containment handle before remote authority installation;
  session establishment remains provider-passive, and start, recovery, or cancellation
  of a durable turn may activate only after the exact start input is durable. Explicit
  write mode validates the retained containment and owner-selected Git artifact, recovers the
  workspace-global patch mediator, and only then opens the credential, guardian, and
  runner. The provider's workspace remains physically read-only; its sole write request
  is the exact `agentrelay.apply_patch/v1` dynamic tool. The guardian
  owns one kernel-locked generation and prearms an out-of-group teardown witness before
  writing the start barrier or spawning the provider. The witness retains the lock,
  independently observes heartbeat and deadline loss, proves the guardian/provider
  group absent, and alone records same-boot teardown quiescence. The runner uses that
  fresh-generation proof to reconcile uncertain starts and inherited interrupts
  without replay. Tests traverse the real Unix wire with fake app-server clients; the
  Linux process gate also starts pinned Codex through the guardian and containment
  boundary. The internal authentication boundary claims one fresh opaque credential
  per Capsule generation and transfers it only over fixed inherited fd 3, never argv,
  environment, or durable state. A Capsule launched from descriptor schema 3 owns that
  channel under one non-resettable 30-second activation deadline and consumes it once
  during authority-gated provider activation. The client performs API-key login and account
  verification with the credential store forced ephemeral; the live handshake leaves
  no `auth.json`. The provider process runs from that private runtime home while the
  logical workspace is carried separately in app-server thread requests. Exact launch
  and per-thread configuration pins the workspace as untrusted. Bounded effective-
  configuration reads require that trust, `shell_tool=false`, and no MCP servers before
  starting or resuming. Afterward, a feature read requires exactly one disabled shell
  tool, and the private home is rechecked and may not persist `config.toml`. Thread
  start and every turn select no Codex environments, suppressing environment-backed
  shell and native `apply_patch` registration in pinned Codex `0.146.0`. Only the exact
  mediated patch request may be handled under local write authority; every other
  provider-initiated request is denied and made fatal.
  The exact app-server command also pins agents and web search off and
  disables shell, hooks, plugins, apps, multi-agent, and code-mode features, removing
  `exec_command`, `write_stdin`, and the legacy shell. Those flags alone leave native
  patch eligibility model-dependent, but the effective thread/turn path exposes no
  native file-change tool; any unexpected file-change approval is declined and fatal.
  The separate exact dynamic patch tool
  durably binds the provider call, Host turn, active authority, transaction, receipt,
  recovery, and terminal history before publication. Native file changes, commands,
  permissions, user input, MCP, and other dynamic tools remain denied and fatal. Prior
  Codex state schemas and adapter 0.3.0 fail closed. No owner-facing credential source
  exists, no polling command selects this path, and no test executes a model turn.
- A Linux containment checkpoint for Codex `0.146.0`. It binds an
  owner-controlled standalone checkout to an explicit Bubblewrap filesystem policy,
  mandatory runtime canary, and exact retained recovery manifest. Its dedicated Linux
  process proof passes. Internal Codex provisioning binds its exact recovery handle in
  the v3 descriptor under matching local workspace-read or workspace-write authority;
  no polling CLI selects it;
  the [original containment checkpoint](research/006-mission-workspace-containment.md)
  records the earlier offline policy, while the current provider-egress contract is in
  the [low-level design](lld.md#guarded-linux-containment-checkpoint).
- Typed engineering artifacts plus provenance wrapping or structural markers on all
  teammate-originated mailbox content.
- An in-process Slack notification dispatcher with encrypted-at-rest webhook setup.
- CLI setup, invite/join, key rotation, doctor, audit, block, and trust commands.

This is useful groundwork, but it is not yet an autonomous agent network. The current
system does not contain:

- A production-activated coding-agent path. The persistent CLI still hosts only the
  deterministic fake runtime; the guarded Codex composition has no polling command,
  owner-facing credential source, service supervisor, or real-turn proof.
- Automatic worktree isolation, complete command/network mediation, or local
  verification and contract-acknowledgement handlers.
- Production command wiring that opens the guarded Codex composition, connects an
  approved owner-facing credential source, and selects its fixed provider-only egress
  and mediated-write boundaries.
- A supported containment boundary outside Linux. macOS explicitly fails closed in
  this checkpoint.
- A real two-machine execution proof through the public control plane.
- Enforcement of the returned per-teammate trust overlay inside a runtime.
- A current A2A v1 Agent Card endpoint or verified A2A compatibility.
- End-to-end traces of local commands, edits, policy decisions, and tests.

Do not describe the current release as autonomous, fully A2A-compliant, or protected
by an end-to-end four-layer trust guarantee.

## Target system

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

The product has three clear boundaries.

### Relay: durable coordination plane

The relay owns:

- Logical agent and device identity.
- Discovery and explicit routing.
- Mission truth and accepted revisions.
- Ordered messages, artifacts, and durable delivery events.
- Claims, acknowledgements, retries, expiry, audit, and revocation.
- Store-and-forward behavior while a node is offline.

The relay does not run a model, inspect a local checkout, choose a working directory,
or decide which command a coding agent may execute.

### AgentRelay Node: local execution plane

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

### Runtime adapter: host-specific activation

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

The first adapter targets Codex app-server over local stdio or a Unix socket. Claude
follows through its Agent SDK or headless CLI. Experimental remote transports are not
part of the correctness boundary.

The Codex adapter library now implements this interface behind the provider-neutral
Capsule server with adapter identity 0.4.0. Its child environment is allowlisted, and
its home is derived locally beneath the Capsule and revalidated as canonical, current-
user-owned, and exactly mode
0700. The provider uses that home as its process working directory rather than loading
from the logical workspace. Thread RPCs remain explicitly scoped to the logical
workspace, whose effective configuration must stay untrusted, shell-disabled, and
MCP-free. `CodexProviderGuardian.openGeneration()` atomically owns the kernel lock,
durable generation barrier, provider spawn, Capsule-owner heartbeat, deadline,
revocation, and process-group teardown. A runner receives that owned generation only
after the guardian has armed a detached teardown witness, written the barrier, and
started the provider.

The Node-owned containment library can wrap both the pinned Codex version probe and
app-server spawn on Linux. Its returned recovery handle is local authority, not Relay
evidence: the internal Codex provisioner durably stores the manifest path, instance ID,
and binding digest in the strict v3 descriptor before Capsule launch, then reopens only
that retained instance during recovery. No polling CLI constructs this composition.

## Why MCP, A2A, and SSE are not the Node

- **MCP** exposes local tools and context to a model host. An MCP server cannot
  portably require a host to start a new model turn. `tools/list_changed` means the
  tool registry changed; it is not proof of message processing.
- **A2A** provides public agent, message, task, artifact, streaming, and discovery
  semantics. It does not launch a process on an offline developer machine or define
  the local sandbox.
- **SSE or WebSocket** can signal that work is available. The connection may drop,
  restart, or duplicate a notification. Durable database events and cursor replay
  remain the source of truth.

AgentRelay uses each at its natural boundary instead of asking one protocol to solve
all three problems.

## Collaboration model

### Handoffs today

The current mailbox stores a two-party handoff with `pending`, `accepted`,
`completed`, and `cancelled` states. Humans or already-running agents explicitly call
MCP tools to advance it. This API remains a compatibility and inspection surface
while the Node slice is built.

### Missions and fake execution today

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
artifact limits and stop final publication on authority loss. The selected fake paths
expose no filesystem, command, or network handler and do not execute registered
verification commands. The internal Codex write path now mediates only the exact
bounded patch tool; it does not grant command or verification authority. Those hard
limits must remain outside the model
because the relay cannot trust usage or effects it has not observed. The system does
not add a manager LLM with global access to every repository.

The guarded Codex library strengthens the available local boundary: an optional
Mission runtime provisioner prepares or strictly recovers the Linux containment
instance under the matching local workspace-read or workspace-write authority, then
durably stores its exact handle in a v3 descriptor. Omitted or explicit read policy
retains the legacy read-only grant and policy hash; only an explicit accepted write
profile adds workspace-write authority. The Node installs Capsule authority only after
provisioning and before activation. Once retained same-Mission start intent or attempt
history exists, later provisioning is recovery-only and must reopen that exact
containment over the expected dirty checkout. Write mode recovers the exact durable
patch mediator before provider activation and keeps the provider mount read-only. No
polling command opens this composition, so this is not a production runtime path.

### Guarded Codex execution checkpoint

The same private Capsule wire can now host an injected `CodexCapsuleRunner` in tests.
Its state schema 4 makes the AgentRelay turn reference and first `accepted` event
durable before any provider turn ID exists. Duplicate starts coalesce on that logical
turn. If `turn/start` may have crossed the provider boundary, a replacement provider
generation performs one authoritative thread read and accepts only one exact client-ID
and text match. An unbound start with no exact terminal match becomes a durable
`failed` or `cancelled` result; it never causes a blind resend. If a provider turn was
already durably bound, an absent or still-running match can be terminalized only after
the patch coordinator proves that exact Host/provider turn has zero durable patch
calls. Any durable call leaves the outcome unproved and nonterminal.

If a fresh provider generation inherits `interrupt_maybe_sent`, it does not issue a
second interrupt. It performs one exact-intent thread read: an exact terminal turn is
normalized authoritatively, while an absent or still-running turn becomes a transient
`failed` result only after the same exact empty patch-call proof because the prior
provider was already proven quiescent.

This is a library and fault-harness checkpoint. The fake Capsule descriptor and CLI
remain unchanged, and the guardian boundary's detached reaper is the authoritative
quiescence finalizer. No real Codex model turn has crossed the Mission delivery path.

For a locally granted write turn, the runner binds at most 32 exact
`agentrelay.apply_patch/v1` calls to Capsule, provider thread/turn/call, Host turn, and
the active authority grant before any mediator effect. The trusted mediator compiles
at most 1 MiB of raw patch input with a pinned owner-selected Git executable, applies
each filesystem mutation through the live write-authority callback under one
workspace-global lock, and records recoverable committed, rejected, or indeterminate
transaction state. A terminal provider turn is publishable only after every durable
receipt matches mediator state and exactly one corresponding provider-history item;
unexpected tool, command, native file-change, missing, duplicate, conflicting, or
unproved history fails closed.

## Delivery semantics

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

The guarded Codex journal extends the same local rule to the pre-provider-binding
window: state schema 4 exposes a stable logical turn immediately, persists the exact
provider intent before `turn/start`, and only reconciles in a fresh provider
generation after the witness has finalized matching prior-generation quiescence.
Prior Codex Capsule state schemas are not migrated by this checkpoint.

## Security model

Remote agent content is untrusted data. The receiving owner controls local authority.

### Implemented safeguards

- Hashed and revocable agent and Node credentials with disjoint bearer formats and
  route scopes.
- Participant-only handoff access and role-specific state transitions.
- Relay-side block checks when creating, accepting, appending to, or completing a
  content-bearing handoff. A shared directed-pair transaction lock makes a committed
  block a fence for those mutations. Mission creation, acceptance, event publication,
  and delivery operations re-check the same participant trust boundary, so a
  committed block fences later Mission activation and execution.
- Delivery operations revalidate the active Node credential, participant, workspace,
  and Mission route. Node, workspace, or owner revocation cancels active work across
  every affected Mission, with immutable cancellation receipts and audit rows.
- Provenance wrappers on teammate text and non-spoofable structural markers on
  teammate payloads, proposals, and artifacts returned by mailbox MCP tools.
- Fail-safe CLI synchronization: block writes local trust first; unblock clears the
  relay first. The running MCP reloads trust before every acceptance decision.
- AES-GCM encrypted notification webhooks at rest, restricted to exact HTTPS Slack
  incoming-webhook targets and dispatched without redirects.
- An allowlisted Codex child environment, a locally derived canonical owner-owned
  exact-mode-0700 home, and generic internal Capsule errors that retire the affected
  running server generation. Concurrent runtime close fences admitted work, and a
  detached driver failure requests retirement. These apply only to the internally
  composed Codex checkpoint. The owner API key enters a Capsule launched from descriptor
  schema 3 only through the fixed fd 3 channel and is consumed by the ephemeral login
  handshake. The provider
  starts from the private home, not the logical workspace; exact launch and thread
  configuration pins that workspace untrusted, effective configuration must show the
  shell disabled and no MCP servers, no Codex environments are supplied on thread
  start or turns, and warm resume is rejected. Only the exact mediated patch request
  may be handled under local write authority; every other server request is denied and
  fatal.
- Kernel-locked provider-generation ownership with a private redacted lifecycle
  record, owner heartbeat, absolute deadline, local revocation signal, provider exit
  and request-timeout observation, reboot-gated recovery, and an out-of-group witness
  that records quiescence only after process-group teardown. This is a guarded
  library boundary, not a production Mission runtime.
- On the persistent Capsule path, independent Node and Capsule reference monitors
  validate the exact grant scope, capability, lease/fence, policy digest, expiry, and
  aggregate output/usage/artifact limits. Product-denied effects cannot be granted.
  Authority loss aborts the local stream and final Relay completion.
- A Linux-only, fail-closed Codex containment library. This is library capability,
  not an active Mission security claim.
- Static recommended host permission configuration.
- Local per-teammate trust parsing and decision output.

### Gaps before autonomous execution

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
- The private reference monitor is composed with the guarded Codex descriptor only
  behind internal APIs. Its redacted evidence goes only to injected sinks and is not
  durably persisted by default. Local verification commands and peer- or workspace-
  chosen network effects are not enabled. Owner-local policy can grant logical
  workspace write and provision the exact matching containment, but the provider
  receives only a read-only mount and the one exact mediated patch tool. The retained
  runtime
  authority grants no network capability; the outer Codex sandbox separately configures
  a fixed provider transport whose hostname allowlist contains only `api.openai.com`.
- The Linux containment boundary and its exact durable recovery handle are selected by
  internal Codex provisioning, not by a polling Node command. Its dedicated Linux
  process proof verifies exact command/profile selection, managed-proxy environment
  injection for the app-server case, and failed direct socket access. It does not prove
  live OpenAI reachability. Owner-facing credential sourcing, general Relay-visible
  authority/execution evidence (#99), registered verification authority, and real-turn
  evidence are absent; macOS remains unsupported.

### Target invariant

The effective capability is the intersection of the Mission request and a local,
pre-authorized policy. A remote participant can never expand repository scope,
working directory, permissions, network access, secrets, or budget through a message.
The Node applies policy outside the model before every turn and mediated side effect.

The first slice allows bounded edits and tests inside an isolated worktree. It denies
push, merge, publish, deploy, arbitrary network effects, and production credentials.

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
own MCP process for interactive tools. The experimental AgentRelay Node is a separate
foreground process today. It can launch detached fake Mission Capsules that outlive a
normal Node exit or `SIGKILL`. Its kernel-held singleton ownership is released on
process death, so a replacement Node can restart directly and recover the same
Capsule turn. No OS service manager currently installs, monitors, or automatically
respawns that foreground process. The detached provider guardian and its independent
teardown witness handle Capsule-plus-guardian loss as long as the witness survives.
Loss of the witness or every local lifecycle owner fails closed; an installed
service/cgroup boundary is still needed for restart, upgrade, rollback, and descendants
that escape the supervised process group (#120). The provider-neutral server,
guardian, injected Codex runner, provisioner, Linux containment library, and durable
patch mediator form an internal activation path whose provider remains read-only, but
do not change which runtime the current polling CLI launches.

A sleeping or powered-off machine remains offline. The relay queues work and the Node
processes it after reconnecting.

## Documentation hierarchy

- [`README.md`](../README.md): product entry point and honest current status.
- [`architecture.md`](architecture.md): canonical current/target boundary overview.
- [`hld.md`](hld.md): high-level reference for the current relay implementation.
- [`lld.md`](lld.md): concrete current routes, tables, tools, and known gaps.
- [`RFC 001`](rfcs/001-agentrelay-node-and-missions.md): next build contract.
- [`Delivery lease control plane`](research/001-delivery-lease-control-plane.md):
  implemented lease, recovery, fencing, and receipt decisions.
- [`Foreground Node runtime`](research/002-foreground-node-runtime.md): initial local
  journal, in-process fake-adapter, and runner-reconstruction checkpoint.
- [`Persistent Mission Capsule`](research/003-persistent-mission-capsule.md): detached
  fake-host persistence and Node-process recovery checkpoint.
- [`Guarded Codex client and durable Capsule journal`](research/004-codex-capsule-journal.md):
  pinned read-only provider boundary and local correlation checkpoint.
- [`Injected Codex Capsule runner`](research/005-codex-capsule-runner.md):
  provider-neutral server, the earlier turn-lifecycle checkpoint, and wire-level
  fake-client proof.
- [`Mission workspace containment`](research/006-mission-workspace-containment.md):
  original offline Linux workspace policy, retained recovery identity, and activation
  gates.
- [`Codex provider guardian`](research/007-codex-provider-guardian.md): kernel-locked
  provider ownership, liveness, authority inputs, and teardown-witness proof.
- [`Local runtime authority`](research/008-local-runtime-authority.md): private bound
  grants, Node/Capsule reference monitors, crash-safe renewal, and current nonclaims.
- [`roadmap.md`](roadmap.md): implementation order and stop/go gates.
- [`auto-mode.md`](auto-mode.md) and [`ambient-agent.md`](ambient-agent.md):
  superseded explorations retained as decision records.

Code and tests define shipped behavior. Accepted RFCs define intended behavior. When
they disagree, document the gap; do not present the target as already shipped.

## Glossary

- **Agent:** a logical network identity owned by a person or organization.
- **Node:** a separately authenticated relay device identity plus an experimental
  foreground daemon that launches detached fake Mission Capsules. Its library also
  contains a guarded provider-neutral Capsule/Codex path, provider guardian, and Linux
  containment boundary; in the target, it is a supervised persistent per-device
  execution boundary.
- **Workspace binding:** a relay-visible logical alias and repository/base-ref
  constraint that the current Node maps locally to an approved checkout.
- **Runtime adapter:** host-specific control of a coding-agent session.
- **Handoff:** the current manually consumed two-party mailbox thread.
- **Mission:** a bounded, versioned collaborative objective coordinated by the relay
  and intended for execution by Nodes.
- **Delivery:** transport and processing state for one durable event.
- **Run:** one participant's local runtime session, worktree, policy, usage, and
  evidence for a Mission.
