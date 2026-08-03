# Foreground Node runtime

- **Date:** 2026-08-02
- **Status:** Historical first turn-delivery checkpoint. Its external fake-host
  follow-up is now implemented in
  [`003-persistent-mission-capsule.md`](003-persistent-mission-capsule.md); real-runtime
  and two-machine recovery remain open.
- **Decision:** Prove the Node's durable execution boundary with an atomic local
  journal and deterministic fake adapter before integrating a coding-agent runtime.
- **Scope:** One foreground Node process, one configured checkout, and one active
  `turn` delivery at a time.

## Question

What is the smallest local runtime that can consume the Relay's fenced delivery API,
fail closed on an invalid checkout or policy, and recover an interrupted turn without
silently invoking the host twice?

## Decision

Add a private `agentrelay-node` workspace with four explicit boundaries:

- A mode-0600 device config keeps the Node credential, local checkout path, and
  owner-approved policy outside the Relay and Mission payload.
- Repository preflight resolves the canonical checkout and verifies its exact origin,
  expected commit, allowed base-ref ancestry, and clean state before host invocation.
  It rejects repository-configured content filters and Git submodules before status
  inspection can invoke external or nested-repository behavior.
- An atomically replaced JSON journal persists delivery and Mission-assignment
  cursors, immutable delivery identity, exact Relay operation intent, lease/fence,
  Mission session, host execution attempt and history, normalized events, and terminal
  result.
- An `AgentHostAdapter` is the only runtime seam. The foreground CLI currently wires
  the deterministic fake adapter; a real adapter is intentionally deferred.

The Node recovers old work before polling from its delivery cursor. It processes one
delivery before scanning Mission assignments, advances at most one ten-item assignment
page per completed cycle, and persists that continuation only after the whole page is
handled. It uses the Relay lease as execution authority, not as a mutex it can infer
locally.

Mission acceptance uses newest-first keyset pages. The cursor is the last Mission ID,
while Postgres resolves its full-precision
`(created_at, id)` anchor inside the database; no JavaScript timestamp participates in
the ordering comparison. The Relay excludes expired pending assignments using its
database clock, and the Node rejects an immediate repeated cursor instead of polling
it forever. A crash before the page cursor is stored safely replays that page because
acceptance intents and receipts are independently durable and idempotent.

## Ordering invariants

The implementation preserves these boundaries in order:

1. Persist a discovered delivery before advancing its cursor.
2. Persist an exact claim, start, renew, complete, or release intent before sending
   the corresponding Relay mutation.
3. Obtain and confirm the Relay's current lease, and keep renewing it throughout
   runtime setup, before invoking or recovering a host turn.
4. Ask the adapter for an existing turn by delivery ID and journaled execution
   attempt before starting a new one.
5. Persist the host's acceptance event before treating the turn as created.
6. Reduce live and recovered host events through the same strict event reducer;
   repeated sequence numbers must be byte-for-byte equivalent after parsing.
7. Bound each host turn to the 64 most recent teammate messages, preserving their
   original order and author identity.
8. Persist the terminal host result and exact completion intent before publishing it.
9. Stop publishing host output when lease renewal, routing, revocation, or Mission
   authority is definitively lost.

A transient release archives the terminal host attempt, advances the execution
attempt, returns the local entry to retryable `ingested` state, and honors
Relay-provided availability against the recovery page's database `as_of` time. A
lease-only reclaim keeps the same execution attempt and recovers the same host turn.
Permanent and policy releases become terminal only when the Relay reports
`dead_lettered`.

## Persistence choice

Atomic JSON is sufficient for this checkpoint because the Node is a single writer and
processes one delivery at a time. Each save durably creates any missing directory
chain, writes and syncs a same-directory temporary file, renames it over the journal,
and syncs the leaf directory. A singleton process lock prevents two local writers.
Stale locks are refused rather than removed automatically; recovery requires the owner
to confirm no Node process is alive before deleting the exact lock file.

SQLite would add a native dependency and migration surface without improving the
first proof. The storage interface remains separate so a later scheduler can move to
SQLite when it needs concurrent work, indexed evidence, or larger histories.

## Evidence

Focused unit tests cover:

- secure config loading, remote-HTTPS enforcement, fake-runtime credential
  separation, atomic replacement, and fail-safe live/stale process locks;
- canonical policy grants, fixed command lookup, and terminal acceptance quarantine
  plus bounded multi-cycle pagination and repeated-cursor handling that cannot hide
  older live assignments or run before delivery recovery in a cycle;
- checkout identity, base reachability, dirty-state, external-filter and submodule
  rejection, bounded Git inspection, and shell-free execution;
- immutable delivery replay, cursor ordering, and journal reconstruction;
- typed Relay responses and HTTP retry/error handling;
- happy-path execution, local denial before host invocation, exact ambiguous-response
  replay for claim/start/renew/complete, Relay-time transient backoff, fresh host
  execution after transient failure, same-host recovery after an expired fence,
  setup-time renewal, recovered-turn cancellation on early authority loss,
  stalled-stream cancellation on renewal failure, and shutdown during setup or a
  pending host turn.

The Relay/Postgres E2E test creates two real agents, Nodes, workspace bindings, local
Git repositories, and one Mission. Both foreground Nodes accept the Mission. The
backend daemon consumes one turn; its completed journal is reopened and duplicate
polling produces no second fake-host turn. The client delivery is then processed
directly: after an injected failure immediately after host acceptance, a reconstructed
processor reuses the same open journal and in-memory fake adapter, recovers that turn,
and finishes the Mission with exactly two turns and two result messages.

This proves the Node journal and adapter contract across runner reconstruction. It
does not prove recovery after killing the operating-system process, because the fake
adapter's host state remains in memory inside the test process.

## Deliberate non-claims

For this checkpoint, the following were deliberate non-claims. The later persistent
fake-Capsule checkpoint closes the host-process item only; the other items remain.

This checkpoint does not yet provide:

- a Codex, Claude, or other real agent-host adapter;
- at this checkpoint, a host capsule whose turn survives Node-process death (closed
  by [`003`](003-persistent-mission-capsule.md));
- contract-artifact payload carriage or contract-acknowledgement handling;
- registered verification-command execution and Relay-visible evidence;
- enforced turn-time/token budgets, arbitrary command mediation, worktree isolation,
  or general network sandboxing;
- Mission-wide expiry/dead-letter reconciliation; or
- a two-machine, two-repository autonomous completion proof.

The fake-adapter CLI also refuses live Node credentials. This checkpoint cannot be
mistaken for a production execution path merely by pointing it at a deployed Relay.

The Node therefore remains private and experimental. The public product claim is a
durable cross-device collaboration architecture with a tested fake-runtime
checkpoint, not autonomous coding completion.

## Follow-on gate

The follow-on gate moved the fake host behind a separately persistent Capsule, killed
and restarted the Node process after host acceptance, recovered the same turn and
event history, and published one Relay completion. Its implementation and remaining
operator boundary are recorded in
[`003-persistent-mission-capsule.md`](003-persistent-mission-capsule.md). The next
runtime gate is the first pinned coding-agent adapter.

This decision builds on the Relay lease contract in
[`001-delivery-lease-control-plane.md`](001-delivery-lease-control-plane.md). It is an
AgentRelay implementation boundary, not an A2A interoperability claim.
