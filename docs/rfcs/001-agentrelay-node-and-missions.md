# RFC 001: AgentRelay Node and Missions

- **Status:** Accepted; Relay control-plane steps 1-3, the foreground Node, the
  persistent fake-Capsule recovery checkpoint, crash-releasable singleton Node
  ownership, and a guarded internal Codex client, journal, runner, guardian, Linux
  containment, strict descriptor v3, Codex state schema 4, adapter 0.4.0, one-shot
  authentication, provider-bootstrap isolation, and exact mediated-patch checkpoints
  are implemented; the private capability reference monitor is selected by
  the fake polling path and by the explicit experimental `run-codex` composition;
  Guarded Real Mission 0 and the two-machine proof remain
- **Date:** 2026-08-01
- **Scope:** Two agents, two machines, two repositories, one real runtime adapter

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
runtime through those fake commands or mediate command/network/path effects whose
handlers do not exist. The
repository also has a version-pinned read-only app-server client, durable Codex Capsule
journal, strict schema-v3 descriptor, provisioner, persistent adapter, provider
guardian, one-shot owner API-key handoff, and fixed provider-only managed CONNECT
egress selected by the explicit experimental `run-codex` command. The Capsule entry
point can construct that guarded
controller. Owner-local policy can also opt into workspace-write authority and exact
write-mode containment. The provider now starts from its private runtime home instead
of the logical workspace, pins that workspace untrusted, attests effective shell/MCP
state, selects no Codex environments for thread start or turns, permits only cold
resume, and denies all server requests except the exact `agentrelay.apply_patch/v1`
request under locally granted write authority. Write activation revalidates the
owner-selected Git artifact, recovers the durable workspace-global mediator before
provider startup, and keeps the provider mount physically read-only. Provider calls,
Host turns, active authority, transaction state, receipts, recovery, terminal history,
and teardown are fail-closed. `run-codex` admits one operator-selected inherited FIFO
or Unix-socket credential fd numbered 3 or higher, completes the doctor and any
owner-pinned Git preflight before reading it, retains and later zeroizes the source,
and supplies a fresh claim to each actual Capsule start on fixed child fd 3. There is
no registered verification-command authority or real model-turn/live OpenAI proof.
Git is required only when a configured workspace references a write profile; an
explicit Git path remains identity- and hash-pinned in read mode. Command shutdown
aborts launcher admission, closes the retained source or unread fd, then releases the
Node `run.lock`. It deliberately leaves detached Capsules alive for recovery.

SSE alone does not close that gap. A socket notification can be lost or duplicated,
and MCP `tools/list_changed` refreshes a tool registry rather than starting a model
turn. The remaining product primitive is a supervised production Node with a
persistent real-runtime Capsule and adapter.

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
completion. Internal APIs now compose that authority with the guarded Codex descriptor
and exact policy-selected Linux containment boundary. Omitted or explicit read policy
preserves the legacy read-only grant and hash; explicit accepted write policy adds
logical workspace-write authority and exact write containment while keeping the
provider mount physically read-only. It recovers the durable patch mediator before
provider activation. A fresh opaque owner credential can cross
only fixed inherited fd 3 under one non-resettable 30-second Capsule activation
deadline, then is consumed once by an ephemeral API-key login. The exact app-server
command has fixed provider-only egress to `api.openai.com`; version checks, containment
probes, and nested workspace sandboxes remain offline. Its process cwd is the private
runtime home, separate from the logical workspace carried in app-server requests.
Exact launch and thread configuration pins that workspace untrusted; effective config
and feature reads require the shell disabled and MCP absent, start and every turn pass
`environments: []`, suppressing environment-backed shell and native `apply_patch`
registration in pinned Codex `0.146.0`, and warm resume is rejected. Only the exact
`agentrelay.apply_patch/v1` request may be handled under write authority; every other
server request remains fatal.
It also pins agents and web
search off and disables shell, hooks, plugins, apps, multi-agent, and code-mode
features, removing command tools. Those flags alone leave native patch eligibility
model-dependent, but the effective thread/turn path exposes no native file-change tool;
any unexpected file-change approval is declined and fatal. The exact dynamic patch
call is durably bound to provider, Host-turn, active authority, transaction, receipt,
recovery, terminal-history, and teardown state before
publication. Experimental `run-codex` selects this boundary and its inherited owner
credential source, but does not provide verification authority, command execution, or
durable Relay-visible write/decision evidence.
Autonomous writes are not safe to claim until every supported effect remains mediated
outside the model and a real turn produces general Relay-visible authority/execution
evidence.

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
Node cursors remain AgentRelay implementation details. Runtime grants, fencing,
workspace-resource identity, and effective local policy also remain on the private
Node-to-Capsule control plane; they are not A2A fields or peer-selectable authority.

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

1. **Complete:** fix payload-preservation, provenance, and block-state gaps.
2. **Complete:** add Mission, shared-contract, event, delivery, Node,
   workspace-binding, and run schemas with state-machine tests.
3. **Implemented at the Relay boundary:** transactional event/delivery append, Node
   cursor polling, leases, acknowledgement, retry, exact replay, and revocation.
   A journaled client covers runner reconstruction, and a real Relay-process restart
   proof converges public cursor polling, recovery discovery, and exact receipt replay.
4. **In progress:** the foreground `node/` daemon now consumes a pre-issued device
   credential, registers logical workspaces, journals cursor/operation/session/event
   state, enforces repository and local-profile preflight, and drives the fake adapter
   for turn deliveries. Contract acknowledgement and registered verification
   deliveries remain.
5. **In progress:** duplicate polling, runner reconstruction, an injected in-process
   failure after host acceptance, lost Relay responses, stale fences, transient
   retry, cancellation, shutdown, local-policy denial, and paginated assignment
   starvation are covered. A detached fake Capsule now proves exact-turn recovery
   after the Node is killed following host acceptance. The stable kernel-held Node
   lock permits direct restart without file deletion and refuses a stopped live
   contender. Pre-claim/after-claim process cuts, busy-session, and full adversarial
   coverage remain.
6. **In progress:** the Codex `0.146.0` app-server protocol/client is pinned. The
   guarded provider-neutral Capsule server, state schema 4, injected runner, strict v3
   descriptor, persistent adapter identity 0.4.0, provisioner, provider guardian, Linux
   containment boundary prove local at-most-once barriers, ambiguous-start recovery
   without resend, exact-input replay, redacted terminal normalization, cancellation
   intent, and provider teardown. Internal composition carries the private authority
   grant and a one-shot fixed-fd3 owner credential into the guarded Codex controller,
   whose client forces ephemeral API-key login and whose exact app-server command uses
   fixed provider-only managed CONNECT egress. Owner-local policy now adds opt-in
   workspace-write authority and exact write containment provision/recovery. Write
   activation revalidates and recovers the workspace-global patch mediator before
   provider startup while keeping the provider workspace physically read-only. Retained
   same-Mission start intent or host-attempt history forces recovery-only provisioning.
   The provider starts from the private runtime home, pins and attests the logical
   workspace as untrusted with shell/MCP disabled, selects no Codex environments,
   requires cold resume, and accepts only `agentrelay.apply_patch/v1` under exact write
   authority. The mediated call has durable request-before-effect,
   receipt-before-response, recovery, and terminal-attestation barriers. Experimental
   `run-codex` now selects this composition, forwards its `runtimeProvisioner`, and
   reads an inherited FIFO/Unix-socket owner credential only after the doctor and
   optional owner-pinned Git preflight. Registered verification, bounded artifact
   carriage,
   general Relay-visible authority/execution evidence (#99), adversarial evaluation,
   Guarded Real Mission 0, and a real model turn remain.
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
