# Next steps

This is the near-term implementation queue. The architecture is defined in
[`RFC 001`](rfcs/001-agentrelay-node-and-missions.md); the broader sequence and
evaluation gates live in [`roadmap.md`](roadmap.md).

## 1. Close current mailbox integrity gaps

- [x] Provenance-wrap every teammate-originated artifact and proposed-action field.
- [x] Preserve `send_message.payload` through the relay instead of storing only
  artifacts.
- [x] Preserve completion artifacts through `complete_handoff`.
- [x] Make `agentrelay block` update both local trust state and relay enforcement, or
  clearly separate the two operations.
- [x] Correct webhook storage/dispatch encryption behavior.
- [x] Add tests that demonstrate the effective security and payload boundary.

These fixes come first because autonomous execution must not amplify known contract
or trust gaps.

The mailbox now stores generic message payloads separately from typed message
artifacts, preserves explicit questions and custom handoff metadata, and returns
completion summary/artifacts without dropping their provenance,
re-checks the receiving participant's block state on append and content-bearing
transitions, and serializes those checks with block-list writes. It encrypts allowlisted
Slack webhook URLs before storage and marks structured teammate data without flattening
its type.
CLI block is local-first and unblock is relay-first so partial failures leave local
denial active; success converges both stores, but it is not a distributed transaction.

## 2. Write executable Mission schemas

- [x] Add Mission, participant, revision, typed message, artifact, policy, delivery,
  and run schemas.
- [x] Add Mission and delivery state-machine transition tests.
- [x] Define one fake backend repository and one fake Android repository at frozen
  commits.
- [x] Define a hidden cross-repository acceptance scenario.
- [x] Add a fake runtime adapter with duplicate, recovery, and cancellation tests.
- [x] Add a deterministic coordinator and transcript fixture with one accepted
  contract revision, duplicate suppression, partial-stream recovery, registered
  round-fenced verification, and zero scripted human interventions after kickoff.
- [ ] Publish JSON Schema and OpenAPI bindings before a non-TypeScript Node or public
  A2A gateway consumes this contract.

Keep this layer small. Do not implement multi-party Missions, parallel actors, smart
routing, or provider-specific fields.

Evidence for this checkpoint is in
[`experiment 001`](experiments/001-backend-android-deterministic-proof.md). It is an
in-memory scripted proof, not durable relay or real-runtime evidence.

## 3. Build durable delivery

- [x] Persist internal Nodes, workspace bindings, exact Mission participant routing,
  Mission config/projection, append-only events, and initially stored deliveries.
- [x] Append each coordinator event, reducer projection, derived delivery set, and
  audit row transactionally.
- [x] Add relay-owned per-Mission event sequence numbers and read-only per-Node cursor
  replay over joined immutable events.
- [x] Persist two independent exact acceptance receipts, bind results to source work,
  and prevent settled or stale verification-round work from advancing a Mission.
- [x] Add independently revocable Node credentials plus authenticated enrollment,
  credential rotation/revocation, and logical workspace registration routes.
- [x] Add authenticated Mission creation/acceptance/result and Node delivery-polling
  routes.
- [x] Add Relay-issued claim leases, renewal, expiry, retry, cancellation, and
  dead-letter policy.
- [x] Persist current attempt/fence state, transport acknowledgement, and exact
  operation receipts for the Mission retention period.
- [x] Prove service-level duplicate, expired-lease, retry-scan, stale-fence, lost
  response, revocation-race, and final-dead-letter behavior against Postgres.
- [x] Prove journal reopening, runner reconstruction, and duplicate cursor polling
  without a second fake-host turn.
- [x] Prove Relay-process restart plus Node reconnect through cursor/recovery polling;
  leave SSE out of this slice.
- [x] Reconcile active/verifying deadlines to `expired` and unsettled dead-lettered
  work to `failed`, cancelling remaining runnable deliveries transactionally.
- [x] Add stable Node-scoped keyset pagination to Mission assignment discovery. The
  foreground Node persists its continuation and advances one bounded page only after
  servicing delivery work; it rejects immediate cursor loops, and the Relay excludes
  expired `awaiting_acceptance` rows using database time.

Agent and Node credentials are type-separated, and Node revocation atomically revokes
its active credentials and workspace bindings without deleting Mission history. The
Mission and delivery control plane is now authenticated and mounted. Cursor polling
discovers work without claiming it; a Node must claim an exact delivery and present
the Relay-issued lease ID and fence before execution-related mutations. Completion
atomically appends Mission output, settles source work, acknowledges transport, and
stores the exact replay receipt. The foreground Node now consumes this boundary for
turn deliveries. The Postgres E2E harness now restarts the real Relay child on the
same database and port while a Node reopens its file journal.

The client journal, after-host-acceptance runner reconstruction, and independently
persistent fake-host recovery now exist. The restart proof does not use MCP, SSE,
WebSocket, or the process-local notification queue. Its exact failure matrix is:

| Failure point | Durable state at failure | Public recovery proof |
|---|---|---|
| Relay exits before claim | Postgres has the `stored` delivery; the Node journal has only Mission acceptance state. | The restarted Relay returns the delivery from ordered cursor polling. Cursorless recovery correctly excludes never-claimed work. |
| Node disconnects after claim | Postgres has the active lease and fence; the file journal has the claimed delivery and advanced cursor. | Polling after that cursor returns nothing, while `/node/v1/deliveries/recoverable` returns the leased delivery. Re-ingesting it starts no host turn until execution resumes. |
| Completion commits but its HTTP response is lost | Postgres atomically has the Mission event, acknowledged delivery, exact receipt, and audit row; the journal retains `complete_intent`. | After another Relay restart and journal reopen, replay returns the stored result with `replayed: true`. A second replay is structurally identical, the audit has one completion, and the fake host has one turn. |
| A transient release becomes due behind the cursor | Postgres returns the delivery to `stored` with database-time backoff; the journal cursor already exceeds its creation cursor. | Cursor polling cannot rediscover it. The cursorless recovery route returns it when due, and the next claim advances the fence. |
| Old or terminal work publishes late output | Postgres has either a newer active fence or a terminal Mission and acknowledged source delivery. | The old fence is rejected with `state_changed`; a fresh completion after the terminal max-turn transition is rejected with `invalid_transition`. Neither creates a second Mission turn. |

Deterministic terminal reconciliation now closes the remaining delivery-control-plane
gap. The next cross-device product proof is a real two-machine, two-repository run
through the public control plane.

## 4. Build the local Node

- [x] Add a `node/` workspace with a foreground daemon command first.
- [ ] Add Node-side enrollment and credential-rotation commands; the Relay already
  registers device-scoped credentials and capabilities.
- [x] Consume a pre-issued device credential from a separate mode-0600 Node config.
- [x] Configure logical workspace aliases locally.
- [x] Persist delivery cursor, operation intents, Mission sessions, host events, and
  delivery processing state through atomic local replacement.
- [x] Validate repository URL, exact base commit, allowed base ref, canonical root,
  and dirty-worktree policy before each turn.
- [x] Validate a pre-registered clean checkout.
- [x] Add stricter unactivated Mission-workspace admission for Linux containment:
  current-user ownership, a standalone checkout-local `.git`, no Git alternates,
  nested mounts, special files, or extra hard links, and stable root/Git identities.
- [ ] Enforce local path, command, network, budget, expiry, and revocation policy.
- [x] Reduce and persist normalized fake-runtime events with acceptance-first ordering,
  replay equality, usage, output, artifact, and token limits.
- [ ] Add deterministic contract acknowledgement and registered verification-command
  delivery handlers.
- [x] Move the fake host into a detached, Mission-scoped Capsule with a strict private
  Unix-socket capability protocol and exact-input durable recovery.
- [x] Kill the Node after Capsule acceptance, prove the same Capsule remains live,
  restart directly without deleting `run.lock`, and recover one turn/result.
- [x] Add crash-releasable Node ownership with a stable private kernel lock. Treat
  `run.owner.json` PID metadata as diagnostic, keep the `run.lock` inode permanently
  in place, never steal ownership on a heartbeat timeout, and fail closed on every
  legacy schema-1 PID lock until an explicit offline migration.
- [ ] Package the Node as an installed background service with OS/cgroup supervision
  (#120), automatic process respawn, bounded restart/upgrade/rollback, and cleanup for
  witness/all-owner loss or descendants that escape the supervised process group.
  Crash-releasable ownership makes restart safe; it does not start the replacement.

Start with one eligible Node per logical agent and one active turn per Mission. The
Capsule path is experimental and Unix-only; it is not yet an installed background
service.

## 5. Add the first real adapter

- [x] Pin Codex app-server `0.146.0` and fail closed on a different runtime identity.
- [x] Validate the bounded request/response/notification subset consumed from the
  matching generated protocol and reject malformed or oversized frames.
- [x] Add a guarded read-only client with one event consumer, correlated responses,
  denied server-initiated authority, and process-group cleanup.
- [x] Add an unactivated schema-v2 Capsule journal and deterministic normalizer with
  exact input/provider-intent persistence, at-most-once start barriers, a stable
  logical turn and acceptance event before provider binding, one active turn, private
  bounded storage, terminal replay, and provider-payload redaction.
- [x] Extract a provider-neutral persistent Capsule server while preserving the fake
  descriptor, CLI, and versioned Unix wire. Authenticate before runtime calls, keep
  one socket owner, close the runtime concurrently while admitted handlers drain, and
  let unexpected request or detached background failures retire the generation.
- [x] Implement an injected Codex runner for probe, session start/resume, turn start,
  one event consumer, cancellation, and recovery. Exercise it through the real
  Capsule Unix wire using fake app-server clients; this is not production activation.
- [x] Reconcile an ambiguous `turn/start` by exact `clientUserMessageId` and text only
  in a fresh guardian-owned provider generation. Carry
  cancellation across pre-binding recovery, durably terminalize a bounded zero match,
  and never resend an uncertain start.
- [x] Resolve an inherited `interrupt_maybe_sent` barrier only in the fresh provider
  generation: read the exact intent once, persist an authoritative terminal provider
  outcome when present, otherwise record a transient failure, and never reissue it.
- [x] Allowlist the Codex child environment and derive its home locally beneath the
  Capsule as a canonical, current-user-owned exact-mode-0700 directory.
- [x] Implement a Linux-only Codex `0.146.0` containment library with a writable
  workspace, read-only `.git`, explicit read/deny roots, private home/temp, rejected
  ambient system Codex configuration, disabled legacy Landlock and network,
  recursive read-tree alias checks, a mandatory runtime canary, exact pinned
  executable/helper identity, and a private `retain_for_review` manifest.
- [x] Pass the dedicated Linux containment process job, including the policy canaries
  and pinned Codex app-server handshake. Keep macOS and every unsupported platform
  fail-closed rather than claiming parity.
- [ ] Complete contract/verification delivery handling and bounded provenance-marked
  Mission artifact carriage.
- [x] Add a provider guardian that atomically owns one kernel-locked generation,
  heartbeat and provider liveness, absolute deadline, local revocation, a prearmed
  out-of-group teardown witness, and durable quiescence only after process-group
  absence (#96).
- [ ] Continuously derive guardian authority and enforce local capability grants
  outside the model (#97).
- [ ] Wire an explicit Codex descriptor/runtime factory into the Capsule and Node CLI
  (#98).
  Before provider start, durably store `{manifestPath, instanceId, bindingSha256}` and
  recover only that exact containment instance.
- [ ] Require the RFC's structured turn dispositions and bounded local execution
  evidence.
- [ ] Pass Guarded Real Mission 0 through the public pipeline.
- [ ] Run the two-machine backend-and-Android Mission only after that integration gate.

Schema v2 has no migration from the earlier unactivated schema-v1 development
checkpoint. No production path writes either format, so compatibility must be decided
before descriptor or CLI activation.

Do not use Codex remote control, generic MCP notifications, or preview host channels
as the activation foundation.

## 6. Evaluate

- [ ] Freeze several coupled cross-repository tasks and budgets.
- [ ] Run the baseline and structured AgentRelay conditions.
- [ ] Record strict integrated success, intervention count, cost, time, contract drift,
  repeated work, replay behavior, and security violations.
- [ ] Publish the trace and an honest result, including failed runs.
- [ ] Decide whether to continue, narrow, or stop before adding more runtimes.

## Deferred decisions

- Relay-readable versus relay-blind payloads.
- Inline patches versus signed artifact storage versus immutable git references.
- Separate owner/organization identity and operator-facing enrollment/recovery UX
  beyond the current agent-authorized compare-and-swap API.
- Claude adapter choice.
- Hosted service and federation.

Open GitHub issues should link back to the RFC section they implement. Closed mailbox
issues remain in GitHub history; this file no longer mirrors old release milestones.
