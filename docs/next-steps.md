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
- [ ] Prove Relay-process restart plus Node reconnect through cursor/recovery polling;
  leave SSE out of this slice.
- [ ] Reconcile delivery expiry/dead-letter outcomes into an explicit terminal or
  blocked Mission transition instead of only hiding expired/terminal Mission work.
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
turn deliveries; Relay restart and full-Mission recovery evidence remain open.

The client journal and after-host-acceptance runner reconstruction now exist. Remaining
Stage 2 evidence includes disconnect before and after claim, an actual Relay-process
restart, independently persistent host recovery, and rejection of late output after a
terminal Mission.

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
- [ ] Enforce local path, command, network, budget, expiry, and revocation policy.
- [x] Reduce and persist normalized fake-runtime events with acceptance-first ordering,
  replay equality, usage, output, artifact, and token limits.
- [ ] Add deterministic contract acknowledgement and registered verification-command
  delivery handlers.
- [ ] Move the fake host outside the Node process before claiming an OS-process crash
  proof; the current E2E reconstructs the Node runner while preserving the fake host.

Start with one eligible Node per logical agent and one active turn per Mission.

## 5. Add the first real adapter

- [ ] Pin a supported Codex app-server version.
- [ ] Generate and test the matching protocol schema.
- [ ] Implement probe, session start/resume, turn start, event stream, cancellation,
  and recovery.
- [ ] Require the RFC's structured turn dispositions: `reply`, `propose_contract`,
  `ready`, `blocked` (with optional requested input), or `failed`.
- [ ] Run the two-machine backend-and-Android Mission.

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
