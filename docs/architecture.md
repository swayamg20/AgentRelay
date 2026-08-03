# Architecture

> **Status:** Canonical system overview as of 2026-08-02.
> Current implementation details live in [`hld.md`](hld.md) and
> [`lld.md`](lld.md). The accepted next target lives in
> [`RFC 001: AgentRelay Node and Missions`](rfcs/001-agentrelay-node-and-missions.md),
> and the shipped lease design is recorded in
> [`Delivery lease control plane`](research/001-delivery-lease-control-plane.md). The
> first local checkpoint is recorded in
> [`Foreground Node runtime`](research/002-foreground-node-runtime.md).

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
- A public identity surface that lets an authenticated agent enroll and revoke its
  Nodes, rotate separately scoped Node credentials, and lets an authenticated Node
  register or revoke relay-visible logical workspace bindings. It never accepts a
  local checkout path.
- An experimental foreground Node that stores a separate device credential, maps
  logical aliases to local checkouts, validates repository identity/base/clean state,
  accepts Missions under a canonical local policy grant, journals cursor and
  operation intent before side effects, renews fenced leases, and drives the
  deterministic fake adapter for turn deliveries.
- Typed engineering artifacts plus provenance wrapping or structural markers on all
  teammate-originated mailbox content.
- An in-process Slack notification dispatcher with encrypted-at-rest webhook setup.
- CLI setup, invite/join, key rotation, doctor, audit, block, and trust commands.

This is useful groundwork, but it is not yet an autonomous agent network. The current
system does not contain:

- A real coding-agent adapter or a host capsule that survives Node-process death.
- Automatic worktree isolation, complete command/network mediation, or local
  verification and contract-acknowledgement handlers.
- Mission-level expiry or dead-letter reconciliation that moves the Mission to a
  terminal state and cancels its remaining work. Discovery hides expired Missions,
  while delivery expiry is reconciled only when that delivery is reclaimed.
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

The first adapter targets Codex app-server over local stdio or a Unix socket. Claude
follows through its Agent SDK or headless CLI. Experimental remote transports are not
part of the correctness boundary.

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
work, and tracks accepted revisions and verification rounds. The foreground Node now
checks repository identity and local policy and bounds reported host-event usage, but
it does not yet execute registered verification commands or enforce the complete
wall-time, token-budget, network, path, and side-effect policy. Those hard limits must
remain outside the model because the relay cannot trust usage or effects it has not
observed. The system does not add a manager LLM with global access to every
repository.

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
lose a retry. Both discovery paths require an active or verifying, unexpired Mission.
They do not lazily transition an expired Mission or reconcile a dead-lettered
delivery into Mission-wide failure.

Delivery is at least once. Exact receipts make relay mutations retry-safe; the
foreground Node's atomic journal suppresses duplicate fake-host effects across runner
reconstruction and exact event replay. Host turns are idempotent per journaled
`(deliveryId, executionAttempt)`: a lease reclaim recovers the same attempt, while a
Relay-backed transient release archives it and advances to a fresh attempt. Retry
eligibility comes from Relay database time rather than the laptop clock. A real host
adapter must preserve `lookupTurn`/`recoverTurn` state across process failure before
the same claim extends to an OS-level crash. Ordering is causal within one Mission;
no global ordering is required. Presence is advisory, and an SSE write or open
connection never counts as processed.

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
- Expired Missions and dead-lettered deliveries have no background or lazy
  Mission-terminal reconciler.
- The notification queue is process-local and can drop work on overflow or restart.
- Local and relay revocation behavior is not one atomic, continuously observed policy;
  successful CLI block/unblock converges both stores but cannot transactionally commit
  a network write and a local file write together.
- An allowed AgentRelay send tool can become an exfiltration path unless outbound
  content and artifact policy are bounded.

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
foreground process today; the target is a persistent managed process with an
independently recoverable host capsule.

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
- [`Foreground Node runtime`](research/002-foreground-node-runtime.md): current local
  journal, fake-adapter, and recovery checkpoint.
- [`roadmap.md`](roadmap.md): implementation order and stop/go gates.
- [`auto-mode.md`](auto-mode.md) and [`ambient-agent.md`](ambient-agent.md):
  superseded explorations retained as decision records.

Code and tests define shipped behavior. Accepted RFCs define intended behavior. When
they disagree, document the gap; do not present the target as already shipped.

## Glossary

- **Agent:** a logical network identity owned by a person or organization.
- **Node:** a separately authenticated relay device identity plus an experimental
  foreground daemon; in the target, a persistent per-device execution boundary.
- **Workspace binding:** a relay-visible logical alias and repository/base-ref
  constraint that the current Node maps locally to an approved checkout.
- **Runtime adapter:** host-specific control of a coding-agent session.
- **Handoff:** the current manually consumed two-party mailbox thread.
- **Mission:** a bounded, versioned collaborative objective coordinated by the relay
  and intended for execution by Nodes.
- **Delivery:** transport and processing state for one durable event.
- **Run:** one participant's local runtime session, worktree, policy, usage, and
  evidence for a Mission.
