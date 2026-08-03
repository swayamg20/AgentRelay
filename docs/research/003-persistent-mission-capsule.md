# Persistent Mission Capsule

- **Date:** 2026-08-03
- **Status:** Implemented for a detached deterministic fake runtime on Unix; a real
  coding-agent adapter and two-machine Mission remain open.
- **Decision:** Keep Relay authority and local policy in the foreground Node, while a
  Mission-scoped Capsule owns durable host-session and turn state across Node-process
  death.
- **Scope:** One fake Capsule per Mission, one active turn per Capsule, and
  operator-assisted Node restart after `SIGKILL`.

## Question

What is the smallest process boundary that lets a Node die after host acceptance,
then recover the same turn and event history without granting a child process the
Node credential or starting the fake host twice?

## Implemented boundary

```text
Relay
  ^ HTTPS with Node credential
  |
foreground agentrelay-node
  |-- atomic delivery journal and local policy
  |-- Mission -> Capsule and execution registry
  |
  `-- private Unix socket + per-Capsule capability
          |
          `-- detached agentrelay-capsule
                launch.json + state.json
                one deterministic fake host session
```

The Node still owns Relay authentication, delivery leases and fences, repository
preflight, policy selection, host-event reduction, and result publication. The
Capsule cannot poll or mutate the Relay. It receives only a small allowlisted process
environment and does not inherit `HOME`, Node/Relay credentials, or unrelated coding-
runtime secrets.

The Capsule owns only host-side state for one Mission:

- the exact Mission, participant, and workspace session scope;
- one durable host session reference;
- the complete accepted `StartTurnInput` and its canonical SHA-256 digest;
- the host turn reference, stable normalized events, and completion deadline; and
- at most one non-terminal turn at a time.

The current runtime inside that boundary is deterministic and fake. Process
persistence here does not imply model execution, repository edits, command
mediation, or production readiness.

## Local protocol

`agentrelay-node run-capsule` launches `agentrelay-capsule serve --directory ...` as a
detached process and reconnects to it over a Unix domain socket. The protocol is
strict, versioned, newline-delimited JSON with one request per connection. Request
frames are capped at 128 MiB so every bounded `StartTurnInput` still fits after
worst-case JSON escaping; response frames are capped separately at 4 MiB. Its
operations are:

- `probe`
- `ensure_session`
- `lookup_turn`
- `start_turn`
- `recover_turn`
- `cancel_turn`
- `shutdown`

Every request carries the wire version, Capsule ID, random 256-bit local capability,
and request ID. Every response repeats the Capsule and request IDs. Schema,
authentication, scope, correlation, and transport failures remain distinct and fail
closed.

Capsule directories are mode 0700. The launch descriptor, runtime state, Node-side
execution registry, and socket are mode 0600. File reads reject symlinks. New sockets
use a short owner-private temporary directory to stay below Unix socket path limits;
the persisted `socket_path` in `launch.json` is then authoritative across Node
environment changes.

## Exact-input recovery

Recovery is intentionally stronger than looking up a turn ID.

1. Before the first host lookup/start, the Node derives the complete validated
   `StartTurnInput` from authenticated Mission state and checkpoints that exact object
   in journal schema 2. Recovery reuses the checkpoint rather than newer Relay state.
2. It records
   `(deliveryId, executionAttempt) -> Mission, Capsule, input hash` in its local
   registry.
3. Before exposing an `accepted` event, the Capsule durably writes the full input,
   matching hash, host turn reference, first event, and completion deadline.
4. An exact repeated `start_turn` replays the existing turn. The same execution key
   with changed input is rejected.
5. `recoverTurn(ref, expectedInput)` checks the Node registry, the Capsule's full
   stored input, the host turn reference, and Mission/session scope before replaying
   events.

This prevents a restarted Node from attaching previously accepted output to changed
objective text, assignments, peer messages, artifacts, contract version, or session
scope. Live delivery and recovered replay pass through the same Node event reducer.

## Process lifecycle and operator boundary

A normal Node exit releases `run.lock` but does not terminate detached Capsules. If
`SIGINT` or `SIGTERM` arrives during a turn, the Node asks the adapter to cancel that
turn before its bounded shutdown completes; the Capsule process itself remains
available with the terminal event history.

`SIGKILL` cannot run Node cleanup. The Capsule continues independently, but the Node's
mode-0600 `run.lock` remains. The current recovery procedure is deliberately
operator-assisted:

1. Open the exact lock without following symlinks.
2. Verify it is a private regular file and records the killed Node PID.
3. Confirm that PID is no longer alive.
4. Recheck that the file identity has not changed.
5. Remove only that lock, sync its directory, and restart the Node.

The Node does not guess that a lock is stale or reclaim it automatically. Automatic
service supervision or a crash-releasable ownership mechanism is separate work.

Capsule socket ownership is also fail-closed. After repeated failed authenticated probes,
the Node compares the private socket's device/inode identity, quarantines the path,
and removes it only if that identity is unchanged; races return to probing. A server
publishes a hard link to a private bind alias, so closing an old server cannot unlink
a replacement pathname. This permits automatic Capsule crash recovery without
guessing ownership.

## Evidence

Focused Node tests cover:

- durable session, turn, and event replay after reopening both adapter and Capsule;
- coalesced concurrent creation of one Capsule/session;
- exact duplicate start and rejection of changed start or recovery input;
- one active turn per Mission;
- capability mismatch and scope/correlation failure;
- private file/socket modes and child-environment stripping;
- duplicate Capsule startup without a stale process later overwriting cancellation;
- concurrent stale-socket recovery converging on one Capsule; and
- old-server shutdown preserving a replacement socket pathname.

The Relay/Postgres E2E test uses the built Node and Capsule binaries. It:

1. Creates real agents, Node credentials, workspace bindings, repositories, and a
   Mission.
2. Waits until the Node journals the Capsule's accepted event.
3. Kills the Node with `SIGKILL`.
4. Uses the persisted local capability to recover the same turn through the same
   Capsule and observes its terminal event while the Node is absent.
5. Performs the validated stale-`run.lock` cleanup above.
6. Starts a one-cycle Node recovery process.
7. Verifies the original accepted event and turn ID, one result message, one Mission
   turn, and exactly one `delivery.complete` audit row.

This proves Node-process survival for the deterministic fake host. It does not prove
that a killed real coding-agent process can continue, that the Relay survives a
restart, or that two physical machines complete a Mission.

Journal schema 2 is required because schema 1 did not retain the exact host start
input. An empty schema-1 journal migrates automatically. A schema-1 journal containing
deliveries fails closed: preserve it and reconcile whether any accepted host work is
still recoverable rather than deleting state or inventing an input.

## Deliberate non-claims

This checkpoint does not provide:

- a Codex, Claude, or other real agent-host adapter;
- automatic Node or Capsule installation and supervision;
- Windows support;
- unattended Node stale-lock recovery;
- isolated worktree creation or complete command, network, path, deadline, token,
  expiry, and revocation enforcement;
- contract-acknowledgement or registered verification-command delivery handlers;
- Mission-wide expiry/dead-letter reconciliation; or
- a real two-machine, two-repository autonomous completion proof.

The fake-runtime CLI continues to reject live Node credentials. The Capsule is a
correctness scaffold for the runtime boundary, not a production agent worker.

## Next gate

Replace the fake runtime behind the same Capsule-owned recovery boundary with one
pinned Codex app-server adapter. The adapter must preserve exact-input correlation,
one active turn, deterministic cancellation, strict version probing, and honest usage
reporting. Then run the first two-machine Mission with each runtime limited to its own
repository and with no human intervention after kickoff.

This checkpoint builds on
[`001-delivery-lease-control-plane.md`](001-delivery-lease-control-plane.md) and
[`002-foreground-node-runtime.md`](002-foreground-node-runtime.md). It remains an
AgentRelay local runtime contract, not an A2A interoperability claim.
