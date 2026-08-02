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
- [ ] Add independently revocable Node credentials and authenticated enrollment,
  Mission, and polling routes.
- [ ] Add claim leases, renewal, expiry, retry, cancellation, and dead-letter policy.
- [ ] Persist claim/attempt history, runs, acknowledgements, and exact operation
  receipts for the Mission retention period.
- [ ] Prove reconnect and recovery through cursor polling; leave SSE out of this slice.

The completed kernel is deliberately internal: no agent credential can impersonate a
Node, and no runtime can consume an unfenced delivery. Event append replays immutable
event and derived-delivery IDs; logical settlement is distinct from transport
acknowledgement. The next state-changing Node operations need fenced, durable
operation receipts.

Required tests: disconnect before claim, after claim, and after host acceptance;
duplicate signal; relay restart; late output after terminal Mission.

## 4. Build the local Node

- [ ] Add a `node/` workspace with a foreground daemon command first.
- [ ] Register a device-scoped credential and capabilities.
- [ ] Configure logical workspace aliases locally.
- [ ] Persist delivery cursor and processing journal.
- [ ] Validate repository URL, base commit, and dirty-worktree policy.
- [ ] Validate a pre-registered clean checkout or operator-created worktree.
- [ ] Enforce local path, command, network, budget, expiry, and revocation policy.
- [ ] Record normalized runtime and policy events.

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
- Exact owner/agent/node/workspace credential and revocation UX.
- Claude adapter choice.
- Hosted service and federation.

Open GitHub issues should link back to the RFC section they implement. Closed mailbox
issues remain in GitHub history; this file no longer mirrors old release milestones.
