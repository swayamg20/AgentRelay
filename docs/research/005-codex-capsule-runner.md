# Provider-neutral Capsule server and injected Codex runner

- **Date:** 2026-08-03
- **Status:** Implemented and tested as an unactivated Node library checkpoint.
- **Runtime under test:** Codex app-server `0.146.0`, read-only policy.
- **Scope:** Capsule runtime injection, schema-v2 logical turns, exact start recovery,
  child-process input isolation, and real Unix-wire tests with fake provider clients.

## Outcome

The persistent Capsule wire is no longer coupled to `FakeCapsuleStore`. A
provider-neutral server accepts a locally constructed runtime, and the existing fake
Capsule command reaches its old behavior through a compatibility wrapper. The wire,
descriptor, and CLI contract did not change.

An injected `CodexCapsuleRunner` now implements the runtime boundary and is exercised
through the real capability-authenticated Unix socket. Its tests use fake app-server
clients. The production descriptor and CLI still select only the deterministic fake,
so this checkpoint does not execute a real model turn.

## Boundary map

```text
current command
agentrelay-capsule -> fake descriptor -> PersistentFakeCapsuleServer
                                      -> PersistentCapsuleServer
                                      -> FakeCapsuleRuntime

test-only composition
Unix wire -> PersistentCapsuleServer -> CodexCapsuleRunner
                                     -> injected fake Codex client
                                     -> CodexCapsuleStore v2
```

The generic server owns capability authentication, wire parsing, request routing,
host-event validation, public error shaping, socket ownership, and runtime shutdown.
The injected runtime owns provider-specific session, turn, event, cancellation, and
recovery behavior.

## Provider-neutral server rules

- The process must win publication of the private socket before it opens durable
  runtime state or starts a provider process. Losing duplicate servers never open a
  runtime.
- Capability and Capsule identity are checked before any runtime method is invoked.
- The existing `probe`, `ensure_session`, `lookup_turn`, `start_turn`, `recover_turn`,
  `cancel_turn`, and `shutdown` frames remain unchanged.
- Every streamed event is revalidated against the expected turn correlation and
  bounded host-event policy. A stream that ends without a terminal event fails closed.
- Client disconnect detaches the stream consumer; it does not invent runtime
  cancellation.
- Expected operation errors retain their stable public code. Validation and
  unexpected failures do not expose internal provider messages, paths, or secrets.
- An unexpected internal runtime failure returns `Capsule runtime failed`, removes the
  server's owned socket, closes the runtime, and retires that running generation.
- Server shutdown starts `runtime.close()` while admitted socket handlers drain. The
  runtime close contract must release and fence those operations before resolving, so
  handler drain and provider cancellation cannot deadlock each other.
- The server injects `lifecycle.retire()`. A detached driver or other background task
  can retire its generation even when no request handler remains to surface the error.

The last rule prevents a potentially corrupted runtime generation from continuing to
serve later requests. It is not a supervisor or automatic proof that a replacement
provider process is safe to start.

## Schema-v2 logical turn

`CodexCapsuleStore` now persists a stable AgentRelay turn reference and sequence-1
`accepted` event during `prepareTurn`. This happens before `turn/start` and before a
Codex turn ID exists.

The durable record still contains the exact validated `StartTurnInput`, its digest,
the derived prompt and output schema with hashes, and the deterministic
`clientUserMessageId`. The local execution key remains
`(deliveryId, executionAttempt)`. Exact duplicates return the same logical turn;
changed duplicates conflict, and only one nonterminal turn may exist.

This change makes lookup, replay, and cancellation possible during the pre-provider-
binding window. Schema v2 does not migrate the earlier schema-v1 development format.
Neither format is activated by a production descriptor today.

## Fresh-generation recovery invariant

`CodexCapsuleRunner.open` requires an injected `CodexRecoveryAuthority` to assert that
the previous provider generation is quiescent before the client factory runs. An
unresolved thread or turn is therefore inspected only from a fresh provider
generation.

For a `turn/start` whose response may have been lost, the runner:

1. keeps the persisted `start_maybe_sent` barrier and never changes it back to a send;
2. reads the bound thread with full turns;
3. accepts only one turn whose client ID and text exactly match the durable intent;
4. binds that provider ID and resumes terminal observation when a match exists;
5. durably records `failed`, or an already-requested `cancelled`, after a bounded zero
   match; and
6. never resends the uncertain start.

Cancellation requested before provider binding remains durable. If reconciliation
finds the provider turn, the runner sends one interrupt. If cancellation happens
before any provider start barrier, the logical turn terminates locally without an
interrupt.

An `interrupt_maybe_sent` barrier inherited by a fresh generation is also resolved
without replay. The new executor sends no interrupt and performs one exact-intent
thread read. It normalizes and persists an exact terminal provider turn when present;
an absent or still-`inProgress` turn becomes a redacted transient `failed` result
because the previous provider is already asserted quiescent. Public events contain no
provider IDs.

If the first interrupt RPC rejects after its durable barrier, the turn driver requests
`lifecycle.retire()`. The replacement generation then follows the one-read rule above;
the failed generation does not continue serving or retry the interrupt.

The recovery authority is an interface supplied by the test harness. There is no
production guardian that atomically owns quiescence proof and process spawn, no
durable provider-generation owner, and no owner-death proof.

## Child environment and private home

The detached Capsule and Codex provider receive only an explicit base allowlist:
`PATH`, temporary-directory variables, locale variables, timezone, and the Windows
`SystemRoot` when present. Node and Relay credentials, provider API keys, inherited
home paths, proxy settings, SSH agent sockets, and process-loader injection variables
are not copied.

The Codex client derives `codex-home` locally beneath the Capsule directory. The
Capsule directory and derived home must be absolute, normalized, real rather than
symlink aliases, canonical, current-user-owned, and exactly mode 0700. The provider
receives that derived path as both `HOME` and `CODEX_HOME`.

This limits ambient process input. It does not enforce a filesystem read root, hide
secrets already reachable by the operating-system user, or mediate every command and
network effect. The later
[`006-mission-workspace-containment.md`](006-mission-workspace-containment.md)
implements a separate, unactivated Linux filesystem boundary; it does not change this
runner checkpoint's active wiring.

## Evidence

Focused tests cover:

- unchanged wire routing through an injected runtime and the fake compatibility path;
- authentication before runtime invocation and one winning socket owner;
- redacted internal failures, incomplete streams, disconnects, and teardown;
- concurrent shutdown fencing plus retirement requested by detached background work;
- a fresh Codex turn and duplicate wire starts with one provider start and one event
  consumer;
- a lost `turn/start` response recovered in a replacement provider generation without
  a second start;
- bounded zero-match terminalization after the quiescence assertion;
- cancellation before provider binding, session resume, and one later interrupt;
- one-read resolution of an inherited uncertain interrupt, with authoritative terminal
  normalization or transient failure and no second interrupt;
- generation retirement after the first interrupt RPC rejects;
- refusal to create a provider client when quiescence is not asserted;
- schema-v2 stable turn lookup and acceptance before provider binding; and
- environment-secret canaries plus canonical ownership and exact-mode checks for the
  derived Codex home.

The full Node suite remains the regression gate. The isolated live app-server test is
still handshake-only and opt-in; it does not run a Mission or a model turn.

## Nonclaims and next gate

This checkpoint does not provide:

- production descriptor, runtime-factory, Node, or Capsule CLI wiring;
- a real Codex model turn or two-machine Mission;
- a production provider guardian, atomic quiescence-proof-plus-spawn ownership,
  heartbeat, or owner-death recovery;
- OS-enforced workspace/read-root or secret containment in this runner checkpoint;
- deadline and revocation race evidence for a real provider process;
- structured contract proposal, acknowledgement, readiness, or registered
  verification-command handling; or
- the complete Node policy, evidence, and supervision boundary required by RFC 001.

The Linux containment process proof now passes. Contract and artifact carriage,
guardian and capability enforcement, descriptor composition with durable handle
storage, structured execution evidence, and Guarded Real Mission 0 remain in the
[roadmap's dependency order](../roadmap.md). Only after that public pipeline gate
should the two-machine proof begin.
