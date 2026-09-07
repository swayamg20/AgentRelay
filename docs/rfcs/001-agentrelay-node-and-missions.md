# RFC 001: AgentRelay Node and Missions

- **Status:** Historical AgentRelay Labs technical decision; product priority was
  superseded by
  [RFC 002: Agent reachability and durable mailbox](002-agent-reachability-and-durable-mailbox.md)
  on 2026-09-01.
- **Date:** 2026-08-01
- **Original scope:** Two agents, two machines, two repositories, one real runtime
  adapter

This record explains why the experimental Mission, Node, and Capsule code exists and
which security boundaries its implemented checkpoints preserve. It is not a current
product roadmap or authorization to activate the Labs path.

## Decision recorded

The Labs design separated two responsibilities:

1. A model-free Relay owned identity, Mission state, durable events, routing,
   delivery leases, limits, audit, and revocation.
2. A machine-local AgentRelay Node mapped logical workspace bindings to locally
   approved checkouts and owned runtime activation, local policy, and execution
   evidence.

A Mission represented bounded collaboration between agents working in separate
repositories against one versioned contract. The design kept the Relay free of model
and local-machine authority.

MCP remained a manual tool boundary. Neither MCP notifications nor an SSE hint was
treated as a portable mechanism for starting a model turn.

## Implemented repository footprint

The preserved Labs lane currently contains:

- authenticated Mission and delivery state in the Relay;
- a foreground Node with durable cursor, claim, lease, retry, acknowledgement,
  cancellation, and recovery behavior;
- a persistent deterministic fake Capsule that survives Node-process death;
- repository identity and workspace preflight checks;
- a version-pinned, read-only Codex app-server client;
- a durable Codex Capsule journal and runner exercised with fake app-server clients;
- provider-generation guardian and teardown process proofs;
- a private capability reference monitor wired only to the persistent fake-Capsule
  path; and
- a Linux containment library and process test that are not selected by the public
  Node or Capsule CLI.

The current descriptor and CLI still select the deterministic fake runtime. No public
path activates a coding-agent model turn, performs repository edits, runs verification
commands, or completes a two-machine autonomous Mission.

## Component boundaries

### Relay

The Relay owns durable coordination facts:

- logical agent, Node, workspace, and Mission identifiers;
- immutable Mission input and accepted contract revisions;
- ordered events, artifacts, delivery records, replay cursors, and idempotency
  receipts;
- claim, lease, acknowledgement, retry, cancellation, expiry, audit, and revocation;
  and
- participant authorization and aggregate limits.

The Relay does not select a local path, executable, command, sandbox, model, credential,
or host approval policy.

### AgentRelay Node

The foreground Node owns machine-local decisions:

- device-scoped credentials;
- logical workspace aliases mapped to approved local repositories;
- repository identity, base-commit, clean-state, and local policy checks;
- durable delivery and runtime correlation;
- lease fencing before local effects;
- local lifecycle limits and cancellation; and
- path-redacted execution evidence from the checkpoints that are actually wired.

Remote participants cannot choose the Node's working directory, permissions, network
policy, secrets, or authorized commands.

### Capsule and runtime libraries

The Capsule boundary keeps host-specific lifecycle behavior outside the Relay. Durable
start input, delivery correlation, event ordering, cumulative usage, terminal state,
and recovery checks prevent a duplicate or changed input from silently becoming a new
turn.

The repository includes Codex-specific client, journal, runner, guardian, and
containment libraries. Their presence does not make Codex part of the Relay protocol
and does not prove that the public Node activates them.

## Security invariants retained

- Cross-agent text and artifacts are untrusted input.
- A delivery lease is coordination authority, not permission for an arbitrary local
  effect.
- Lease ID, fencing token, deadline, and durable start input are checked outside the
  model before a wired effect.
- Relay-visible workspace identifiers are logical aliases, never remote-selected local
  paths.
- Provider and child-process environments exclude Relay and Node credentials.
- Recovery compares durable identity and input instead of reconstructing authority from
  newer peer state.
- An expired or revoked holder cannot publish a result as the current owner.
- Storage, pickup, model processing, and reply remain separate observable facts.

## Current nonclaims

The preserved Labs code does not currently provide:

- a production coding-agent runtime selected by the Node or Capsule CLI;
- automatic execution of a teammate message;
- complete mediation of commands, edits, tests, network effects, or credentials;
- a production service supervisor for the Node;
- a two-machine autonomous Mission proof;
- a Claude runtime adapter; or
- A2A protocol conformance.

These are implementation absences, not commitments or scheduled work.

## Evidence records

The detailed research notes remain public because they document implemented security
decisions and test evidence:

- [Delivery lease control plane](../research/001-delivery-lease-control-plane.md)
- [Foreground Node runtime](../research/002-foreground-node-runtime.md)
- [Persistent Mission Capsule](../research/003-persistent-mission-capsule.md)
- [Codex Capsule journal](../research/004-codex-capsule-journal.md)
- [Codex Capsule runner](../research/005-codex-capsule-runner.md)
- [Mission workspace containment](../research/006-mission-workspace-containment.md)
- [Codex provider guardian](../research/007-codex-provider-guardian.md)
- [Local runtime authority](../research/008-local-runtime-authority.md)

Active code and tests are authoritative when this historical record differs from the
implementation.
