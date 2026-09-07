# RFC 001: AgentRelay Node and Missions

- **Status:** Historical AgentRelay Labs technical design; product priority was
  superseded by
  [`RFC 002: Agent reachability and durable mailbox`](002-agent-reachability-and-durable-mailbox.md)
  on 2026-09-01. Relay control-plane steps 1-3, the foreground Node, the
  persistent fake-Capsule recovery checkpoint, crash-releasable singleton Node
  ownership, and unactivated Codex client, journal, runner, guardian, and Linux
  containment checkpoints are implemented; a private capability reference monitor is
  wired only to the persistent fake-Capsule path; descriptor/CLI activation and the
  two-machine proof remain unimplemented.
- **Date:** 2026-08-01
- **Original scope:** Two agents, two machines, two repositories, one real runtime
  adapter

This RFC explains the implementation and security boundaries of the preserved Labs
code. Its unimplemented sections are historical design, not a public roadmap or an
authorization to expand or activate the path. New scope requires an explicit
owner-approved task or a currently scoped public issue.

## Decision

AgentRelay will have two cooperating planes:

1. A model-free relay that owns identity, Mission state, durable events, routing,
   delivery leases, global limits, audit, and revocation.
2. A long-running AgentRelay Node on each machine that maps Relay-visible logical
   workspace bindings to locally approved checkouts and owns runtime activation, hard
   local policy limits, and execution evidence.

The first application is a **Mission**: a bounded collaboration in which two agents
work in separate repositories toward one versioned shared contract.

MCP remains the tool boundary for the current manual mailbox. A2A remains the target
public interoperability boundary. Neither is used as a portable way to wake a local
coding-agent session.

## Why

The repository now contains an authenticated mailbox, a durable Mission/delivery
control plane, and a foreground Node with an independently persistent fake Mission
Capsule. That Node notices work, checks repository identity and a local policy
profile, and starts or resumes a deterministic fake-host turn. Its Capsule retains
host state across Node-process death. That fake-Capsule path now receives one private,
fenced grant and enforces its lifecycle, output, usage, artifact, expiry, and final
publication boundary outside the model. It cannot yet activate a real coding-agent
runtime or mediate command/network/path effects whose handlers do not exist. The
repository also has a version-pinned read-only app-server client and a pure durable
Codex Capsule journal, but neither is reachable from the Node or Capsule CLI.

SSE alone does not close that gap. A socket notification can be lost or duplicated,
and MCP `tools/list_changed` refreshes a tool registry rather than starting a model
turn. For this Labs experiment, the remaining execution primitive is a supervised
production Node with a persistent real-runtime Capsule and adapter.

## First-slice boundary

Build only this:

- One relay and one team.
- Two logical agents, each explicitly bound to one Node and one workspace.
- One Mission at a time with one active turn at a time.
- One pre-registered clean checkout or operator-created worktree per participant.
- One Codex app-server adapter over local stdio or a Unix socket.
- Polling over a durable event ledger. SSE comes after replay and recovery pass.
- Text, one versioned shared-contract artifact, bounded patches, and verification
  evidence.
- Maximum turns, wall time, provider-reported tokens, expiry, cancellation, and
  revocation.
- Human input only for initial Mission and local policy approval, then final review.

Do not add multi-party Missions, automatic worktree lifecycle, smart routing, a tray
app, hosted billing, federation, parallel agents, dollar-cost enforcement, or a
second runtime adapter to this slice.

## System shape

```text
Machine A                                              Machine B

approved backend workspace                             approved client workspace
          |                                                       |
     Codex runtime                                            Codex runtime
          | adapter                                               | adapter
          v                                                       v
 AgentRelay Node A  <--------- AgentRelay relay ---------> AgentRelay Node B
                       durable, model-free coordination
```

A sleeping laptop remains offline. The relay queues work until its Node reconnects.
"Wake" means starting or resuming a runtime while the machine and Node are online.

All Node connections are outbound. AgentRelay does not expose a remote shell or open
an inbound laptop port.

## Responsibilities

### Relay

The relay owns:

- Logical agent identity and Node enrollment.
- Mission manifest, shared-contract version, and lifecycle.
- Append-only Mission events with Mission-local sequence numbers.
- Durable per-Node deliveries with replay cursors.
- Claims, lease expiry, retry, acknowledgement, cancellation, and dead-letter state.
- Explicit participant routing, global turn/time/token counters, audit, and
  revocation.

The relay does not choose a local path, executable command, sandbox, model, or host
approval policy. It does not run repository verification itself.

### AgentRelay Node

The Node owns:

- Safe storage and use of a Relay-issued, device-scoped revocable credential bound to
  one logical agent.
- Mapping Relay-visible logical workspace aliases to approved local repository
  checkouts.
- A durable delivery cursor and processing journal.
- Repository URL, base commit, clean-state, and workspace-policy checks.
- Runtime session and delivery-to-turn mappings.
- Hard local path, command, network, time, token, expiry, and revocation limits.
- Local tool, patch, verification, and policy-decision evidence.

The Node persists a claimed delivery locally before invoking the runtime. It renews
the lease while a turn runs and acknowledges only after the resulting Mission event
or terminal failure is committed to the relay.

### Runtime adapter

The adapter must make crash recovery and duplicate suppression explicit:

```typescript
interface AgentHostAdapter {
	probe(): Promise<AdapterInfo>;
	ensureSession(input: SessionInput): Promise<HostSessionRef>;
	lookupTurn(deliveryId: string, executionAttempt: number): Promise<HostTurnRef | null>;
	startTurn(input: StartTurnInput): AsyncIterable<HostEvent>;
	recoverTurn(ref: HostTurnRef, expectedInput: StartTurnInput): AsyncIterable<HostEvent>;
	cancelTurn(ref: HostTurnRef): Promise<void>;
}
```

`startTurn` is idempotent by `(deliveryId, executionAttempt)`: if the host already
accepted that execution attempt, the adapter returns or recovers the existing turn
rather than starting another one. A deliberate retry advances the positive,
journaled `executionAttempt` and may create a fresh host turn for the same Relay
delivery. Lease authority does not enter the runtime adapter or `HostTurnRef`; the
execution attempt is correlation, not a fence. Before starting, recovering,
cancelling, or publishing a host result, the Node atomically checks the delivery's
current lease ID, fencing token, and unexpired deadline in durable state. A newly
leased Node may recover the same journaled execution attempt; an expired holder is
rejected before it reaches the adapter.

Before host lookup/start, the Node checkpoints the complete validated
`StartTurnInput`. `recoverTurn` must compare that journaled object with the durable
start intent for the turn rather than reconstructing it from newer Relay state.
Matching IDs are insufficient: changed Mission text, session scope, contract version,
peer messages, or artifacts must fail closed instead of replaying output under
different input.

Every normalized host event has one stable, turn-local sequence number so full replay
can be deduplicated after recovery. Events cover acceptance, bounded output, tool and
permission lifecycle, artifact references, cumulative turn token usage or explicit
usage unavailability, completion, failure, and cancellation. A later usage event
supersedes an earlier usage event; consumers do not sum snapshots, and no terminal
event is accepted before usage or explicit unavailability. Provider events do not
become a side channel around Node policy or evidence capture.

The Node applies one stream reducer across live events and full recovery replay. It
requires contiguous acceptance-first sequencing, monotonic cumulative usage, one
terminal event, and locally configured aggregate event, output-byte, artifact-count,
artifact-byte, and reported-token limits. Every event must retain the accepted host
turn correlation, and the initial acceptance must match the requested Mission,
delivery, session, and contract version. The delivery-to-host-turn mapping is durable
as soon as the host accepts; a malformed later provider event cannot erase it and
cause a second host turn.

The first adapter pins one supported Codex app-server version. Preview host channels,
Codex remote control, remote ACP, and generic MCP notifications are not dependencies
of delivery correctness.

### Current MCP server

The existing MCP server remains the manual create/query/reply/inspect surface. The
first autonomous slice does not use broad relay credentials inside the coding-agent
session. The Node submits one structured turn input and consumes one structured turn
result.

## Identity and enrollment

Keep these identities distinct:

- **Owner:** the person or organization granting authority.
- **Agent:** the stable network address.
- **Node:** one enrolled machine process with a separate credential.
- **Workspace binding:** a stable local alias for one approved checkout.
- **Runtime session:** a host-specific session used for one Mission.

Enrollment flow:

1. An existing authenticated owner enrolls a Node once.
2. The relay returns a Node-scoped credential bound to that logical agent.
3. The owner registers a workspace alias locally with repository URL and allowed base
   refs.
4. A Mission targets `agent + workspace alias`, never a raw path.
5. The first slice rejects zero or multiple eligible Node matches instead of choosing
   dynamically.

## Mission contract

The immutable creation manifest contains:

- Objective and public acceptance criteria.
- Exactly two participants and their roles.
- Workspace alias, repository URL, and expected base commit for each participant.
- Initial assignment for each participant.
- Shared-contract artifact version 1.
- Local policy-profile name requested from each Node.
- Maximum turns, wall time, token budget, expiry, and allowed artifact types.

The remote manifest may request a policy profile. Only local configuration defines
what that profile permits.

The relay authenticates the Mission creator and attaches that actor separately from
the immutable manifest. The Node derives objective, assignment, and acceptance text
from this authenticated Mission context; a runtime caller cannot select its own
provenance label.

### Shared-contract revisions

Do not version the entire Mission for every discussion change. Version one shared
contract artifact, such as the API schema.

- A participant proposes a new contract only as its turn disposition.
- The relay pauses new turns while both participants acknowledge the new version.
- A proposal does not implicitly acknowledge its proposer. Both authenticated
  participants submit explicit coordinator acknowledgements for the exact revision
  ID, version, artifact ID, and hash.
- After both acknowledgements, the accepted version becomes active and the next turn
  belongs deterministically to the participant opposite the proposer.
- Revisions happen only between turns, so no host turn runs against two versions.
- Every subsequent event records the accepted contract version.
- Refusal or acknowledgement timeout moves the Mission to `blocked`, `cancelled`, or
  `expired` according to its policy.

## Agent output

Every runtime turn returns exactly one structured disposition:

```typescript
type TurnDisposition =
	| { kind: "reply"; message_type: MessageType; message: string; artifacts?: ArtifactRef[] }
	| { kind: "propose_contract"; artifact: ArtifactRef }
	| { kind: "ready"; evidence: VerificationEvidence[] }
	| { kind: "blocked"; reason: string; requested_input?: string }
	| { kind: "failed"; class: "transient" | "permanent" | "policy_denied" };
```

The Node validates and publishes the disposition. Agent-authored text cannot directly
change Mission, delivery, policy, or budget state.

The first slice uses structured output rather than letting the runtime call the public
AgentRelay MCP tools. Narrow Node-local tools may be added only if the runtime needs
artifact publication, and they must not expose relay credentials or arbitrary send.

## Events and ordering

Keep three streams separate:

1. **Mission events** carry a `mission_id` and monotonic Mission sequence. They record
   assignments, agent results, contract proposals/acknowledgements, verification, and
   terminal state.
2. **Node deliveries** carry a per-Node durable cursor. They point to work derived from
   Mission events and support offline replay.
3. **Node/runtime events** record online state, turn lifecycle, and local evidence.
   They do not require a Mission sequence when no Mission is involved.

Every durable record has its own ID, actor, timestamp, idempotency key, and causal
parent where applicable. Store observable decisions and execution evidence, not hidden
chain-of-thought.

Mission event and delivery rows are written in the same Postgres transaction as the
domain mutation, or through a transactional outbox that provides the same crash
guarantee. A message must never commit without replayable delivery work.

## State machines

### Mission

```text
awaiting_acceptance -> active -> verifying -> completed
          |              ^  |        |
          |              |  v        +-> active (verification failed)
          |              +--blocked--+
          |
          +-> cancelled | expired | failed

active/verifying/blocked -> cancelled | expired | failed
```

- Both participants accept the same manifest, contract version, and local policy
  grant before `active`.
- `blocked -> active` requires the declared input or authority resolution.
- `verifying -> active` occurs when a required check fails and the Mission can still
  make progress within budget.
- Terminal Missions reject delayed output.

### Delivery

```text
stored -> leased -> executing -> acknowledged
   ^         |          |
   +---------+----------+  retryable failure or lease expiry
   |
   +--------------------> dead_lettered

stored | leased | executing -> cancelled  (Relay-owned revocation/invalidation)
```

Delivery is at least once. Each retry increments attempt count and applies bounded
backoff. A true terminal delivery failure becomes `dead_lettered`; Mission policy then
moves an eligible Mission deterministically. Its database deadline produces
`expired`; otherwise its earliest unsettled dead-lettered delivery produces `failed`.
These causes never select `blocked` or `cancelled`. Reconciliation cancels remaining
runnable deliveries and rejects delayed output.

Each new lease also advances a monotonic fencing token. Node-owned start, renewal,
release, and result publication must present the active lease ID and token before the
lease deadline, so a delayed or expired holder cannot mutate a re-leased delivery.
Relay-owned cancellation instead runs under the same Node-to-Mission lock hierarchy
as revocation and invalidates any current lease.

"Written to a socket" is not a delivery state. Polling the durable Node cursor is the
first correct implementation. SSE may later reduce pickup latency without changing
these states.

## Deterministic coordinator

The relay coordinator reduces typed events; it does not reason about repository code.

- Only the current participant may submit the next turn disposition.
- `reply` schedules the other participant.
- `propose_contract` pauses turns until both acknowledge.
- `blocked` stops scheduling until required input is supplied.
- `ready` marks that participant ready for the current contract version. Its evidence
  array may be empty because required Node verification runs only after both are ready.
- When both are ready, each Node runs locally registered verification command IDs.
- A command ID resolves locally to structured argv, workspace alias, timeout, and
  environment allowlist. Peer-provided shell strings are never executable authority.
- Nodes submit pass/fail evidence. The relay completes only when every required local
  verification record passes for the current contract version.
- Every transition into `verifying` increments a verification round. Evidence must
  name the active round, so a delayed result from an earlier readiness cycle cannot
  complete a retry.
- A failed check returns the Mission to `active` only when enough turn budget remains
  for both participants to establish a fresh readiness cycle; otherwise it fails.

The hidden evaluator used to measure the experiment is separate from public Mission
acceptance. It does not influence the agents' shared contract or runtime completion.

Stage 1 remains a pure, replayable in-memory proof of coordinator semantics. The
separate Relay control-plane implementation now adds durable receipts, transactional
event append, authenticated ingestion, fenced leases, recovery scans, and revocation
races. See
[`Delivery lease control plane`](../research/001-delivery-lease-control-plane.md) for
the implemented boundary and its remaining nonclaims.

## Security invariants

- Remote content and artifacts are untrusted data.
- Effective authority is the intersection of the Mission request and local policy.
- A peer may propose a command, but only a locally registered command ID can execute.
- Local paths remain local; peers see workspace aliases and repository/base identity.
- The Node verifies repository and base commit before every turn.
- The peer cannot expand participants, writable paths, tools, network access, budget,
  sandbox, approval policy, or credentials through conversation.
- Provenance-mark every peer-originated text-bearing field while preserving typed
  artifact structure.
- Preserve the exact bounded UTF-8 artifact text identified by its hash. JSON input
  carries that source text and a structured value derived from it; the Node rejects a
  supplied mismatch instead of silently reserializing it. Artifact version and source
  actor remain attached.
- Deny push, merge, publish, deploy, credentials, and arbitrary network effects.
- Observe cancellation, expiry, and credential revocation before claiming new work.
- Bound outbound text and artifacts so AgentRelay cannot become an unrestricted data
  exfiltration channel.

The current MCP `trust_overlay` is advisory. The foreground Node consumes a locally
approved profile for repository preflight and reported-event limits, and its fake
Capsule receives neither the Relay/Node credentials nor unrelated owner secrets. On
the persistent fake path, independent Node and Capsule monitors now enforce an exact
journaled grant derived from current Relay authority and trusted local inputs. The
grant hard-denies push, merge, publish, deploy, arbitrary network access, secret
access, and privilege expansion; authority loss stops streamed output and final Relay
completion. This is not composed with Codex, does not grant verification execution,
and does not durably persist decision evidence by default. Autonomous writes are not
safe to claim until the Node activates the boundary and mediates every concrete
command, network, path, and side effect outside the model.

## Relay-visible versus local data

Relay-visible run summaries contain Mission, participant, Node, runtime version,
turn reference, usage counters, disposition, artifact hashes, and verification result.

The Node's local journal may contain checkout path, worktree path, effective local
policy details, raw bounded tool output, and host recovery metadata. Local filesystem
paths and secrets do not travel in peer messages or relay-visible run summaries.

## Protocol boundary

The mailbox API and the internal Mission/Node delivery envelope are separate. The
repository does not implement an A2A gateway. Internal Mission states, delivery leases,
Node cursors, runtime grants, fencing, workspace-resource identity, and effective local
policy are not public A2A fields or peer-selectable authority.

## Current implementation status

The repository implements:

- Mission, shared-contract, event, delivery, Node, workspace-binding, and run schemas
  with deterministic state-machine tests;
- transactional Relay event/delivery append, Node cursor polling, leases,
  acknowledgement, retry, exact replay, revocation, and recovery discovery;
- a foreground Node with durable local journal, repository and local-profile preflight,
  fake runtime execution, and exact receipt replay;
- a detached deterministic fake Capsule with recovery after Node-process loss;
- a pinned but unactivated Codex app-server client behind a provider-neutral Capsule
  interface;
- a provider guardian, teardown witness, Linux containment library, and a private
  capability monitor on the persistent fake-Capsule path; and
- tests for several duplicate, retry, stale-fence, cancellation, shutdown, and
  ambiguous-response boundaries.

The current public pipeline does not execute a real model through a Mission, complete a
real two-machine Mission, expose a Claude adapter or A2A gateway, mediate every concrete
side effect, or provide automatic push, merge, deployment, publication, or production
access. These are current nonclaims, not a published implementation schedule.
