# Roadmap

> **Updated:** 2026-08-02. This roadmap replaces the old mailbox -> Auto Mode ->
> Ambient Agent release sequence. The architectural contract is
> [`RFC 001: AgentRelay Node and Missions`](rfcs/001-agentrelay-node-and-missions.md).

## Direction

AgentRelay is a cross-device communication and collaboration network for independently
owned agents. Coding across separate repositories is the first proving vertical, not
the product's final boundary.

The current repository combines an authenticated asynchronous mailbox with a mounted
Mission and delivery control plane: Node enrollment, logical workspace routing,
Mission creation and acceptance, cursor polling, Relay-issued fenced leases,
completion, retry, dead-lettering, audit, and revocation. The next milestone is a
persistent local Node that can journal this authority and start or resume a bounded
agent turn, plus process-restart evidence for the Relay APIs.

We progress through evidence gates, not calendar promises or version hype.

## Stage 0: make the existing foundation honest

Before autonomous execution:

- Preserve the current handoff API as a compatibility surface.
- Fix teammate-originated artifact fields that bypass provenance wrapping.
- Preserve `send_message` payloads and completion artifacts end to end.
- Make local block state and relay block enforcement converge.
- Stop claiming current A2A v1 conformance until a current compatibility suite passes.
- Stop describing the returned trust overlay as runtime enforcement.
- Add regression tests for each corrected contract.

**Exit gate:** current docs, code, and tests agree about the mailbox's actual security
and delivery guarantees.

## Stage 1: executable Mission contract

**Status:** deterministic exit gate passed on 2026-08-02. See
[`experiment 001`](experiments/001-backend-android-deterministic-proof.md). Durable
relay delivery and real Nodes remain unproved.

- Add a small shared protocol package or module with Mission, participant, message,
  artifact, delivery, run, and policy schemas.
- Implement deterministic Mission and delivery state machines with invalid-transition
  tests.
- Add fake backend and Android repositories with frozen commits and executable
  acceptance fixtures.
- Build a fake runtime adapter so coordination can be tested without model variance.

**Exit gate:** a deterministic two-participant fixture completes through typed events,
including one contract revision, without a real coding-agent runtime.

## Stage 2: durable delivery ledger

**Status:** Relay control plane implemented. It includes independent acceptance
receipts, source-bound result settlement, verification generations, joined cursor and
recovery scans, separately revocable Node credentials, public Mission routes, and
fenced claim/start/renew/complete/release operations with exact durable receipts.
Postgres tests cover concurrent claims, stale fences, expiry after lock waits, lost
response replay, retry discovery, dead-lettering, blocks, and revocation races. The
Stage 2 exit gate remains open until a journaled client proves reconnect and Relay
process restart without a duplicated host effect.

- Add node identity, workspace-binding, Mission, event, delivery, claim, run, and
  acknowledgement persistence.
- Commit domain events and delivery rows in the same Postgres transaction.
- Implement ordered cursor replay, bounded claims, lease expiry, retry, cancellation,
  and duplicate suppression.
- Start with cursor polling over the durable ledger.
- Defer authenticated SSE until replay, claims, and recovery are already correct.

**Exit gate:** forced disconnects, relay restarts, expired leases, and duplicate
notifications cause no lost event and no duplicated effect.

Before declaring the control plane complete, also add stable Mission-assignment
pagination and reconcile Mission state when delivery expiry or dead-lettering makes
further progress impossible. Current discovery excludes expired and terminal Mission
work so stale rows cannot starve runnable work, but filtering is not lifecycle
reconciliation.

## Stage 3: AgentRelay Node

- Add a `node/` pnpm workspace and daemon CLI.
- Register device-scoped credentials and capabilities.
- Map logical workspace aliases to locally approved repositories.
- Persist the event cursor, processing journal, and Mission-to-session mapping.
- Validate a pre-registered clean checkout or operator-created worktree, including
  repository identity, base commit, and dirty state before each run.
- Apply local path, command, network, approval, budget, expiry, and revocation policy
  outside the model.
- Record runtime, tool, artifact, test, and policy-decision evidence.

**Exit gate:** two Nodes on separate machines complete the fake-adapter Mission after
one Node is killed and restarted mid-run.

## Stage 4: Codex vertical slice

- Implement one pinned Codex app-server adapter over local stdio or a Unix socket.
- Start or resume a dedicated thread per Mission.
- Serialize turns, normalize lifecycle events, handle busy sessions, and cancel
  safely.
- Run the backend-and-Android scenario with each agent limited to its own repository.
- Deny push, merge, publish, deploy, arbitrary network access, and secrets.

The proof must include:

- Ten or more meaningful exchanges where the task requires them, without optimizing
  for message count.
- One accepted API-contract revision.
- One offline/reconnect recovery.
- One duplicate delivery.
- One adversarial message or artifact attempting to expand local authority.
- One mid-run cancellation or revocation.
- Passing backend, Android, contract, and end-user scenario checks.
- No human input after the initial Mission and policy grant.

**Exit gate:** both participant workspaces are review-ready with a complete replayable
trace and no forbidden effect.

## Stage 5: evaluate before broadening

Run several frozen cross-repository tasks under comparable budgets:

1. One capable agent with both repositories.
2. Two isolated agents using ordinary free-form coordination.
3. Two agents using typed AgentRelay Missions.
4. Typed Missions plus executable cross-repository verification.

Measure strict integrated success, human interventions, wall time, cost, turns,
clarification loops, contract drift, repeated work, premature completion, replay
correctness, and policy violations.

**Continue only if:** structured collaboration repeatedly improves integrated success
or preserves a valuable repository-ownership boundary at an acceptable cost.

**Stop or reshape if:** it needs human nudges to pick up messages, regularly finishes
with incompatible contracts, loses correctness after reconnect, or costs materially
more than the strongest simple baseline without a compensating benefit. Any secret
disclosure, unauthorized write, or capability escalation fails the run.

## Stage 6: harden and interoperate

Only after the Codex slice clears the evaluation gate:

- Add a Claude Agent SDK or headless adapter.
- Pass a current A2A compatibility suite and publish correct Agent Cards.
- Add multi-node selection only if one logical agent genuinely needs it.
- Add stronger artifact storage, retention, observability, and operator tooling.
- Decide whether the relay may read payloads or needs relay-blind encryption.
- Package a reliable two-machine setup and demo.

## Later, demand-driven work

- Multi-party or parallel Missions.
- Cross-organization federation.
- Hosted multi-tenant service, SSO, billing, and administration.
- Desktop or mobile notification UI.
- Non-engineering Mission applications and artifact types.
- Auto-push, PR, merge, deploy, or production actions under explicit policy.

These are product questions, not implied commitments.

## Explicit non-goals for the first proof

- Real-time collaborative editing.
- A central manager LLM.
- LLM-based recipient routing.
- Waking a sleeping or powered-off laptop.
- Repository synchronization.
- A new transport that competes with A2A or MCP.
- Claiming that agent count alone improves software quality.
