# Roadmap

> **Updated:** 2026-08-20. This roadmap replaces the old mailbox -> Auto Mode ->
> Ambient Agent release sequence. The architectural contract is
> [`RFC 001: AgentRelay Node and Missions`](rfcs/001-agentrelay-node-and-missions.md).

## Direction

AgentRelay is a cross-device communication and collaboration network for independently
owned agents. Coding across separate repositories is the first proving vertical, not
the product's final boundary.

The current repository combines an authenticated asynchronous mailbox, a mounted
Mission and delivery control plane, and an experimental foreground Node. The Node
journals Relay authority and starts or resumes either an in-process fake-host turn or
an independently persistent fake Mission Capsule. The detached Capsule and Node-
process restart proof are implemented. The first pinned Codex client, durable journal,
provider-neutral Capsule server, injected runner, strict v2 descriptor, provisioner,
persistent adapter, and provider guardian now form a guarded internal read-only
activation path plus a fail-closed write-authority/containment checkpoint. The guardian
owns provider-generation spawn, liveness, and local authority
inputs; its prearmed persistent out-of-group witness owns process-group removal and
post-absence quiescence proof. A Linux-only Codex `0.146.0` containment boundary adds
owner-controlled standalone-workspace admission, an explicit Bubblewrap policy,
mandatory runtime canary, and exact retained-manifest recovery. Internal provisioning
durably binds that recovery handle before Capsule launch. A Codex-only launcher can
transfer one fresh opaque owner credential per Capsule generation over fixed inherited
fd 3, and the client forces API-key login to use an ephemeral credential store. The
exact app-server command has fixed Codex-managed CONNECT access only to
`api.openai.com`; version checks, probes, and nested workspace sandboxes remain offline.
No polling command selects this composition, and there is no owner-facing credential
source, guarded workspace-write model activation, or real model-turn proof. The
persistent fake-Capsule path also installs a private, fenced capability grant into
independent Node and Capsule reference monitors. This is the partial issue #97
reference-monitor checkpoint, not completion of the still-open issue or real-runtime
activation. The next runtime milestone is guarded Codex activation through the public
polling path (#98), not another protocol abstraction.

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
Relay delivery and an experimental fake-runtime Node now exist; real coding-agent
Nodes remain unproved.

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
response replay, retry discovery, dead-lettering, terminal reconciliation, blocks,
and revocation races. A journaled client now proves runner reconstruction and duplicate
polling without a second fake-host turn. A Postgres E2E restarts the real Relay process
before claim, after claim, and after a committed completion response is lost; it
reopens the Node journal, converges cursor polling with cursorless recovery, and
rejects stale or terminal output without a second effect. This proof uses no
notification transport.

- Add Node identity, workspace-binding, Mission, event, delivery, claim, and
  acknowledgement persistence. Relay-visible run persistence remains part of the
  later runtime-evidence work.
- Commit domain events and delivery rows in the same Postgres transaction.
- Implement ordered cursor replay, bounded claims, lease expiry, retry, cancellation,
  and duplicate suppression.
- Start with cursor polling over the durable ledger.
- Defer authenticated SSE until replay, claims, and recovery are already correct.

**Exit gate:** passed. Forced disconnects, relay restarts, expired leases, and
duplicate discovery/polling cause no lost event and no duplicated effect in the
durable fake-runtime proof.

Stable assignment pagination, restart/replay evidence, and deterministic terminal
reconciliation are implemented. Reconciliation is lazy at delivery discovery and
delivery-operation boundaries; it does not require a scheduler.

## Stage 3: AgentRelay Node

**Status:** persistent fake-Capsule checkpoint implemented. The foreground Node has a
mode-0600 device config, local workspace/policy mapping, atomic journal,
recovery-before-poll loop, fenced Relay operations, repository preflight, and fake
adapter replay. It can launch a detached, Mission-scoped fake Capsule through a
private capability-authenticated Unix socket. Unit fault injection and real
Relay/Postgres E2E coverage prove one host turn per processed delivery across
duplicate polling, runner reconstruction, and `SIGKILL` after host acceptance. The
Node now holds a stable private `run.lock` with a kernel advisory lock: process death
or reboot releases ownership, direct restart needs no file deletion, and a stopped or
stalled live owner cannot be displaced by a timeout. The lock inode remains
permanently in place, and PID metadata in `run.owner.json` is diagnostic rather than
authority. Every legacy schema-1 PID lock requires a one-time explicit offline
migration because PID-only evidence cannot rule out another namespace. The Capsule
server is now provider-neutral while the existing descriptor, CLI, and wire remain
fake-compatible. An injected Codex runner is tested through that real Unix wire.
Runtime shutdown concurrently fences admitted work, and background runtime failures
can retire their server generation, but no production path selects Codex. OS
service/cgroup containment, automatic process respawn, witness/all-owner loss,
escaped-descendant cleanup, and restart/upgrade/rollback behavior remain #120.
Contract acknowledgement, verification execution, guarded real-runtime polling
activation, and the two-machine exit gate also remain open. On the persistent fake
path, journal schema 4 stores an exact authority grant before activation or a
predecessor awaiting proven Capsule retirement. The Node and Capsule enforce its lease,
fence, expiry, scope, capabilities, and aggregate output/usage/artifact limits
independently; the Node also aborts final Relay completion when authority is lost.
Evidence records go to
injected sinks and are not durably stored by default.

- Add a `node/` pnpm workspace and daemon CLI.
- Register device-scoped credentials and capabilities.
- Map logical workspace aliases to locally approved repositories.
- Persist the event cursor, processing journal, and Mission-to-session mapping.
- Validate a pre-registered clean checkout or operator-created worktree, including
  repository identity, base commit, and dirty state before each run.
- Require an owner-controlled standalone checkout for the Linux Codex boundary and
  retain it for review; linked worktrees and automatic disposal remain unsupported.
- Apply local path, command, network, approval, budget, expiry, and revocation policy
  outside the model.
- Record runtime, tool, artifact, test, and policy-decision evidence.

**Exit gate:** two Nodes on separate machines complete the fake-adapter Mission after
one Node is killed and restarted mid-run.

## Stage 4: Codex vertical slice

**Status:** guarded internal Codex composition and fake-runtime authority checkpoints
implemented. The pinned read-only client, schema-v2 journal, injected runner, strict
descriptor, provisioner, persistent adapter, and provider guardian sit behind the
provider-neutral Capsule server. The provisioner durably binds the exact Linux
containment recovery handle before Capsule launch, and internal composition installs
the private authority grant before activation. The runner publishes a stable logical
turn before provider binding, consumes one provider event stream, and reconciles an
uncertain start only in a guardian-owned fresh generation. The guardian owns the
kernel-locked start barrier, Capsule and provider liveness, absolute deadline, and
local revocation. Before the barrier it prearms an out-of-group witness that retains
the same lock, removes the guardian/provider group, and records durable quiescence only
after proving absence.

A Codex-only launcher can transfer one fresh opaque owner credential per Capsule
generation over fixed inherited fd 3. The validated schema-v2 controller owns one
non-resettable 30-second activation deadline. The client consumes the credential once
for API-key login, then verifies the resulting API-key account state with Codex's
credential store forced ephemeral. Tests exercise the real Capsule Unix wire with fake
app-server clients and real OS process trees, including joint Capsule/guardian loss on
Linux. The dedicated Linux process job starts pinned Codex through the guardian and
containment boundary, but no polling command selects this composition, no owner-facing
credential source exists, and no test executes a model turn.

Owner-local policy now has an optional `workspace_access` gate. Omitted or explicit
`read` preserves the legacy read-only grant and hash; explicit accepted `write` adds
workspace-write authority and provisions or strictly recovers the exact write-mode
containment. Activation deliberately fails closed before the credential is claimed or
the guardian, provider, or runner is opened. Its local sentinel is
`workspace_write_activation_not_enabled`; the private wire redacts it to `internal` and
retires the Capsule. Retained same-Mission start intent or host-attempt history forces
recovery-only provisioning, including for an expected dirty checkout. This is a
containment and authority checkpoint, not a model-write or live-runtime proof.

- [ ] Add registered verification delivery and execution handling (#93), with a
  canonical absolute executable identity bound into local authority instead of a
  restart-sensitive bare `PATH` lookup.
- [ ] Carry bounded provenance-marked Mission artifacts end to end (#94).
- [x] Add guardian-owned provider generations, liveness, deadline/revocation inputs,
  a prearmed teardown witness, durable post-absence quiescence, and process-group
  teardown (#96).
- [x] Add the partial issue #97 private, bound capability reference-monitor checkpoint
  to the persistent fake Capsule; deny push, merge, publish, deploy, arbitrary network
  access, secrets, and privilege expansion, and stop output/final completion on
  authority loss. This does not close issue #97, expose polling Codex activation, or
  provide a verification-command executor.
- [x] Bind the internal exact app-server command to fixed provider-only managed CONNECT
  egress while keeping version checks, probes, and nested workspace sandboxes offline.
- [x] Pin the exact app-server command with agents and web search off and shell, hooks,
  plugins, apps, multi-agent, and code-mode features disabled. Native `apply_patch`
  remains independently eligible when the selected model exposes it, but resulting
  file-change approvals are declined and fatal; exact patch mediation remains open.
- [x] Add owner-local opt-in workspace-write authority and exact write containment
  provision/recovery, with write activation intentionally fenced before credentials or
  provider startup.
- [ ] Expose the guarded Codex composition through an explicit polling command with an
  approved owner-facing credential source, guarded workspace-write model activation,
  and Guarded Real Mission 0 (#98).
- [ ] Persist durable local authority and execution evidence (#99).
- [ ] Run the adversarial capability and recovery matrix against the activated runtime
  (#104).
- [ ] Require one structured turn disposition with bounded local execution evidence.
- Pass Guarded Real Mission 0 through the public pipeline before attempting the
  backend-and-Android two-machine scenario.

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
