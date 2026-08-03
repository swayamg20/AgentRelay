# Architecture

> **Status:** Canonical system overview as of 2026-08-01.
> Current implementation details live in [`hld.md`](hld.md) and
> [`lld.md`](lld.md). The accepted next target lives in
> [`RFC 001: AgentRelay Node and Missions`](rfcs/001-agentrelay-node-and-missions.md).

## Product thesis

AgentRelay gives independently owned AI agents a secure, persistent way to discover,
communicate, and collaborate across devices and runtimes.

The first proof is software delivery across repositories: a backend agent and an
Android or frontend agent should be able to negotiate a shared contract, implement
their local work, exchange evidence, and finish with compatible, tested changes. The
network is broader than this one workflow; Missions and code artifacts are the first
application on top of it.

## Current implementation

The repository currently ships an authenticated asynchronous mailbox:

- Postgres-backed developer identities, cards, API keys, invites, blocks, handoffs,
  and messages, with audit records for invite and handoff/message mutations.
- A Hono relay with REST onboarding and an A2A-shaped JSON-RPC endpoint.
- Seven stdio MCP tools for sending, receiving, replying to, inspecting, and
  completing handoff threads.
- An executable protocol workspace with Mission/delivery/runtime contracts and an
  in-memory deterministic backend-Android coordination proof.
- Typed engineering artifacts plus provenance wrapping or structural markers on all
  teammate-originated mailbox content.
- An in-process Slack notification dispatcher with encrypted-at-rest webhook setup.
- CLI setup, invite/join, key rotation, doctor, audit, block, and trust commands.

This is useful groundwork, but it is not yet an autonomous agent network. The current
system does not contain:

- A persistent local daemon that consumes work and starts or resumes agent turns.
- Durable delivery events, replay cursors, processing claims, or acknowledgements.
- Distinct device, workspace, runtime-session, or mission-lease identity.
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

### Missions next

A Mission is a bounded collaborative objective with:

- Explicit participants and logical workspace bindings.
- Repository URL and frozen base commit per participant.
- Objective, constraints, and executable acceptance criteria.
- A versioned shared contract acknowledged by every participant.
- Allowed paths, commands, artifact types, and denied external effects.
- Turn, wall-time, token, cost, expiry, and cancellation limits.
- Typed questions, answers, proposals, decisions, artifacts, progress, blockers, and
  readiness evidence.

The relay uses a deterministic state machine. It routes work, tracks global counters,
and decides completion from typed readiness and verification records. Each Node
enforces hard local limits because the relay cannot trust usage it has not received.
The system does not add a manager LLM with global access to every repository.

## Delivery semantics

Message persistence and agent processing are separate facts:

```text
stored -> node_claimed -> host_turn_started -> response_recorded
```

Delivery is at least once. A lease may expire and cause redelivery. Nodes suppress
duplicate effects with the durable event ID and local processing journal. An SSE
write, notification webhook, or open TCP connection never counts as processed.

Ordering is causal within one Mission; no global ordering is required. Presence is
advisory. Offline nodes catch up from the durable event cursor.

## Security model

Remote agent content is untrusted data. The receiving owner controls local authority.

### Implemented safeguards

- Hashed and revocable API keys.
- Participant-only handoff access and role-specific state transitions.
- Relay-side block checks when creating, accepting, appending to, or completing a
  content-bearing handoff. A shared directed-pair transaction lock makes a committed
  block a fence for those mutations. Invite, handoff/message, and block mutations are
  audited.
- Provenance wrappers on teammate text and non-spoofable structural markers on
  teammate payloads, proposals, and artifacts returned by mailbox MCP tools.
- Fail-safe CLI synchronization: block writes local trust first; unblock clears the
  relay first. The running MCP reloads trust before every acceptance decision.
- AES-GCM encrypted notification webhooks at rest, restricted to exact HTTPS Slack
  incoming-webhook targets and dispatched without redirects.
- Static recommended host permission configuration.
- Local per-teammate trust parsing and decision output.

### Gaps before autonomous execution

- Registration, card updates, key rotation, and agent disable are not written to the
  current relay audit log.
- `trust_overlay` is returned as JSON but is not dynamically applied to the host.
- Relay audit does not record local commands, edits, tests, or policy decisions.
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
- Local filesystem paths do not travel in peer messages. Nodes resolve logical
  workspace aliases locally.
- Agents exchange bounded text, structured contracts, hashes, patches, immutable git
  references, and approved links, not assumed shared filesystem state.
- Store decisions and observable execution evidence, not hidden chain-of-thought.

## Deployment topology

The relay can run anywhere that supports the relay container image and Postgres. Teams may
self-host it or use a future hosted service. Every developer machine runs its own
MCP process for interactive tools; the future AgentRelay Node is a separate persistent
process.

A sleeping or powered-off machine remains offline. The relay queues work and the Node
processes it after reconnecting.

## Documentation hierarchy

- [`README.md`](../README.md): product entry point and honest current status.
- [`architecture.md`](architecture.md): canonical current/target boundary overview.
- [`hld.md`](hld.md): high-level reference for the mailbox implementation on `main`.
- [`lld.md`](lld.md): concrete current routes, tables, tools, and known gaps.
- [`RFC 001`](rfcs/001-agentrelay-node-and-missions.md): next build contract.
- [`roadmap.md`](roadmap.md): implementation order and stop/go gates.
- [`auto-mode.md`](auto-mode.md) and [`ambient-agent.md`](ambient-agent.md):
  superseded explorations retained as decision records.

Code and tests define shipped behavior. Accepted RFCs define intended behavior. When
they disagree, document the gap; do not present the target as already shipped.

## Glossary

- **Agent:** a logical network identity owned by a person or organization.
- **Node:** the persistent per-device AgentRelay daemon.
- **Workspace binding:** a local mapping from a stable alias to an approved checkout.
- **Runtime adapter:** host-specific control of a coding-agent session.
- **Handoff:** the current manually consumed two-party mailbox thread.
- **Mission:** a bounded, versioned collaborative objective executed by Nodes.
- **Delivery:** transport and processing state for one durable event.
- **Run:** one participant's local runtime session, worktree, policy, usage, and
  evidence for a Mission.
