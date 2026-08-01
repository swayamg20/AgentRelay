# RFC 001: AgentRelay Node and Missions

- **Status:** Accepted for the next vertical slice
- **Date:** 2026-08-01
- **Scope:** Two agents, two machines, two repositories, one real runtime adapter

## Decision

AgentRelay will have two cooperating planes:

1. A model-free relay that owns identity, Mission state, durable events, routing,
   delivery leases, global limits, audit, and revocation.
2. A long-running AgentRelay Node on each machine that owns workspace bindings,
   local runtime activation, hard local policy limits, and execution evidence.

The first application is a **Mission**: a bounded collaboration in which two agents
work in separate repositories toward one versioned shared contract.

MCP remains the tool boundary for the current manual mailbox. A2A remains the target
public interoperability boundary. Neither is used as a portable way to wake a local
coding-agent session.

## Why

The current repository is an authenticated, durable mailbox. It can store handoffs
and messages, expose MCP tools, and audit relay mutations. It cannot notice work on a
developer machine, start or resume a model turn, enforce a collaboration-specific
local policy, or prove that an agent processed a message.

SSE alone does not close that gap. A socket notification can be lost or duplicated,
and MCP `tools/list_changed` refreshes a tool registry rather than starting a model
turn. The missing product primitive is the local Node.

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

- A device-scoped revocable credential bound to one logical agent.
- Local workspace aliases mapped to approved repository checkouts.
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
	lookupTurn(deliveryId: string): Promise<HostTurnRef | null>;
	startTurn(input: TurnInput & { deliveryId: string }): AsyncIterable<HostEvent>;
	recoverTurn(ref: HostTurnRef): AsyncIterable<HostEvent>;
	cancelTurn(ref: HostTurnRef): Promise<void>;
}
```

`startTurn` is idempotent by `deliveryId`: if the host already accepted that delivery,
the adapter returns or recovers the existing turn rather than starting another one.

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

### Shared-contract revisions

Do not version the entire Mission for every discussion change. Version one shared
contract artifact, such as the API schema.

- A participant proposes a new contract only as its turn disposition.
- The relay pauses new turns while both participants acknowledge the new version.
- Revisions happen only between turns, so no host turn runs against two versions.
- Every subsequent event records the accepted contract version.
- Refusal or acknowledgement timeout moves the Mission to `blocked`, `cancelled`, or
  `expired` according to its policy.

## Agent output

Every runtime turn returns exactly one structured disposition:

```typescript
type TurnDisposition =
	| { kind: "reply"; message: string; artifacts?: ArtifactRef[] }
	| { kind: "propose_contract"; artifact: ArtifactRef }
	| { kind: "ready"; evidence: VerificationEvidence[] }
	| { kind: "blocked"; reason: string; requestedInput?: string }
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
```

Delivery is at least once. Each retry increments attempt count and applies bounded
backoff. A true terminal delivery failure becomes `dead_lettered`; Mission policy then
moves the Mission to `blocked` or `failed`.

"Written to a socket" is not a delivery state. Polling the durable Node cursor is the
first correct implementation. SSE may later reduce pickup latency without changing
these states.

## Deterministic coordinator

The relay coordinator reduces typed events; it does not reason about repository code.

- Only the current participant may submit the next turn disposition.
- `reply` schedules the other participant.
- `propose_contract` pauses turns until both acknowledge.
- `blocked` stops scheduling until required input is supplied.
- `ready` marks that participant ready for the current contract version.
- When both are ready, each Node runs locally registered verification command IDs.
- A command ID resolves locally to structured argv, workspace alias, timeout, and
  environment allowlist. Peer-provided shell strings are never executable authority.
- Nodes submit pass/fail evidence. The relay completes only when every required local
  verification record passes for the current contract version.
- A failed check returns the Mission to `active` if budget remains; otherwise it fails.

The hidden evaluator used to measure the experiment is separate from public Mission
acceptance. It does not influence the agents' shared contract or runtime completion.

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
- Deny push, merge, publish, deploy, credentials, and arbitrary network effects.
- Observe cancellation, expiry, and credential revocation before claiming new work.
- Bound outbound text and artifacts so AgentRelay cannot become an unrestricted data
  exfiltration channel.

The current MCP `trust_overlay` is advisory. Autonomous writes are not safe to claim
until the Node consumes locally approved policy and enforces it outside the model.

## Relay-visible versus local data

Relay-visible run summaries contain Mission, participant, Node, runtime version,
turn reference, usage counters, disposition, artifact hashes, and verification result.

The Node's local journal may contain checkout path, worktree path, effective local
policy details, raw bounded tool output, and host recovery metadata. Local filesystem
paths and secrets do not travel in peer messages or relay-visible run summaries.

## Protocol boundary

The first slice keeps the current mailbox API for compatibility and uses an internal
AgentRelay envelope for Node delivery. It does not add an A2A gateway yet.

After the Mission loop is proved, map the public surface explicitly to current A2A
Agent Cards, Messages, Tasks, Artifacts, and task states, then run a current
compatibility suite. Internal `awaiting_acceptance`, `verifying`, delivery leases, and
Node cursors remain AgentRelay implementation details.

## Acceptance tests

The slice is complete only when all of these pass:

1. Two real Nodes with different repositories complete one Mission without human
   input after kickoff.
2. One participant starts offline; queued work runs after its Node reconnects.
3. Duplicate polling results do not create duplicate host turns or outputs.
4. Kill a Node before claim, after claim, and after host acceptance; leases and
   `lookupTurn`/`recoverTurn` converge correctly.
5. A second delivery waits while the Mission's runtime session is busy.
6. Repository URL, base commit, or clean-state mismatch prevents host invocation and
   produces `blocked` evidence.
7. Attempts to change local path, sandbox, approval policy, or external-effect
   permissions are rejected.
8. Turn limit, deadline, cancellation, and Node revocation prevent future execution.
9. A contract revision pauses turns and subsequent work uses only the acknowledged
   version.
10. Every Mission event correlates to delivery, Node, host session/turn, and audit
    evidence; terminal Missions reject delayed output.
11. Backend, client, shared-contract, and public user-scenario checks pass.

The evaluation harness then runs one hidden end-to-end check that agents did not see.

## Build order

1. Fix current payload-preservation, provenance, and block-state gaps.
2. Add Mission, shared-contract, event, delivery, Node, workspace-binding, and run
   schemas with state-machine tests.
3. Implement transactional event/delivery append, Node cursor polling, leases,
   acknowledgement, retry, and duplicate suppression.
4. Add a foreground `node/` daemon with enrollment, workspace registration, local
   journal, policy profiles, and a fake adapter.
5. Pass disconnect, crash, duplicate, busy-session, cancellation, and adversarial
   tests with the fake adapter.
6. Add and pin the Codex app-server adapter.
7. Run the two-machine backend-and-client pilot and compare it with one strong
   baseline using the same starting commits and budget.
8. Decide whether to continue before adding SSE, Claude, A2A interoperability, or
   broader product surfaces.

## Stop/go gate

Primary success is strict integrated completion with no human intervention after
kickoff and no forbidden effect. Also record wall time, tokens, turns, clarification
loops, contract revisions, replay behavior, and policy denials.

Continue only if structured collaboration improves integrated completion or preserves
a valuable repository-ownership boundary at an acceptable coordination cost. Stop or
reshape if agents need pickup nudges, regularly finish with incompatible contracts,
fail recovery, or introduce unauthorized writes, secret disclosure, or capability
escalation.

## Explicitly deferred

- Automatic worktree creation and cleanup.
- SSE/WebSocket live signaling.
- Claude and other runtime adapters.
- A2A gateway and public Agent Cards.
- Multiple eligible Nodes, dynamic routing, group Missions, and parallel actors.
- External artifact links and unrestricted fetch.
- Auto-push, PR creation, merge, deploy, publish, and production access.
- Relay-blind encryption, federation, multi-tenancy, billing, and desktop UI.
