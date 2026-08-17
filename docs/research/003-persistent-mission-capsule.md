# Persistent Mission Capsule

- **Date:** 2026-08-03
- **Updated:** 2026-08-17
- **Status:** Implemented for a detached deterministic fake runtime on Unix; a real
  coding-agent adapter and two-machine Mission remain open. A later partial issue #97
  checkpoint adds private runtime-authority enforcement on this fake path.
- **Decision:** Keep Relay authority and local policy in the foreground Node, while a
  Mission-scoped Capsule owns durable host-session and turn state across Node-process
  death.
- **Scope:** One fake Capsule per Mission, one active turn per Capsule, and direct
  Node restart after `SIGKILL` through crash-releasable singleton ownership.

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
- `install_authority`
- `assert_authority`
- `renew_authority`
- `revoke_authority`
- `ensure_session`
- `lookup_turn`
- `start_turn`
- `recover_turn`
- `cancel_turn`
- `shutdown`

The four authority operations were added by the later
[`Local runtime authority`](008-local-runtime-authority.md) checkpoint. They remain a
private Node-to-Capsule control plane and do not activate Codex or add a public A2A
surface.

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

## Process lifecycle and ownership boundary

A normal Node exit releases kernel ownership while leaving `run.lock` in place, and
does not terminate detached Capsules. If `SIGINT` or `SIGTERM` arrives during a turn,
the Node asks the adapter to cancel that turn before its bounded shutdown completes;
the Capsule process itself remains available with the terminal event history.

The Node now opens a stable mode-0600 `run.lock` and acquires a nonblocking kernel
advisory lock through exact-pinned `fs-native-extensions@1.5.0` before opening its
journal or Capsule registry. The inode is not unlinked, renamed, or atomically
replaced during normal operation; it remains permanently in place. PID, timestamps,
and owner metadata are written durably to the separate mode-0600 sibling
`run.owner.json`; none of them grants or denies ownership, and missing or malformed
diagnostics cannot change the kernel lock decision.

The kernel releases ownership on normal exit, `SIGKILL`, and host reboot, so a
replacement Node can restart directly against the same stable file. A stopped,
suspended, or event-loop-stalled live Node retains the lock. There is no heartbeat or
timeout at which another process may steal ownership. The lock handle closes last on
graceful shutdown and is not inherited by a detached Capsule.

Path and primitive uncertainty fail closed before journal access. Every schema-1 PID
lock requires a one-time explicit offline migration: `ESRCH` inside one PID namespace
cannot exclude a live old Node in another namespace that shares the state. Malformed
or partial state, symlinks, wrong type/owner/mode, extra hard links, path replacement,
or unsupported lock semantics produce an actionable operator error rather than
guessed reclamation. This is safe singleton ownership, not OS service supervision: no
current installer or service manager starts a replacement Node after failure.

Capsule socket ownership is also fail-closed. After repeated failed authenticated probes,
the Node compares the private socket's device/inode identity, quarantines the path,
and removes it only if that identity is unchanged; races return to probing. A server
publishes a hard link to a private bind alias, so closing an old server cannot unlink
a replacement pathname. This permits automatic Capsule crash recovery without
guessing ownership.

## Evidence

Focused Node tests cover:

- private stable-lock creation, diagnostic metadata, and fail-closed path validation;
- two live contenders, a stopped live owner, `SIGKILL` followed by immediate
  reacquisition, legacy ownership, and non-inheritance by detached Capsules;
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
5. Starts a one-cycle Node recovery process directly, without deleting or replacing
   `run.lock`.
6. Confirms the replacement acquires kernel ownership before opening local state.
7. Verifies the original accepted event and turn ID, one result message, one Mission
   turn, and exactly one `delivery.complete` audit row.

This proves Node-process survival for the deterministic fake host. It does not prove
that a killed real coding-agent process can continue, that the Relay survives a
restart, or that two physical machines complete a Mission.

At this checkpoint, journal schema 2 was required because schema 1 did not retain the
exact host start input. The current Node journal is schema 4: schema 2 and 3 migrate
without inventing authority, while an empty schema-1 journal still migrates. A
schema-1 journal containing deliveries fails closed; preserve it and reconcile whether
any accepted host work is still recoverable rather than deleting state or inventing an
input.

## Deliberate non-claims

This checkpoint does not provide:

- a Codex, Claude, or other real agent-host adapter;
- automatic Node or Capsule installation, OS supervision, or process respawn;
- Windows support;
- isolated worktree creation or complete command, network, path, deadline, token,
  expiry, and revocation enforcement;
- contract-acknowledgement or registered verification-command delivery handlers;
- Mission-wide expiry/dead-letter reconciliation; or
- a real two-machine, two-repository autonomous completion proof.

The later partial issue #97 checkpoint adds bound time/token/expiry/revocation, stream,
and final-publication enforcement to this persistent fake path. It still does not
provide complete command, path, network, verification, or real-runtime mediation, and
issue #97 remains open.

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
