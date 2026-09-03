# Next steps

> **Window:** 2026-09-01 through 2026-09-30. This is the mailbox-first
> validation queue for
> [`RFC 002`](rfcs/002-agent-reachability-and-durable-mailbox.md) and
> [`roadmap.md`](roadmap.md). The GitHub changes described in
> [`issue-reset-2026-09-01.md`](issue-reset-2026-09-01.md) were executed with owner
> approval on 2026-09-02. No branch, pull request, commit, release, or deployment was
> changed by that tracker reset.

## Work rule

Do not begin with a new implementation. First run the existing product with two real
owners and record what prevents repeated use. A change enters the queue only when it:

1. removes an observed onboarding or communication blocker;
2. fixes a mailbox correctness or security defect; or
3. is necessary to collect trustworthy validation evidence.

Mission/Node, Codex activation, A2A, federation, hosted tenancy, new clients, and new
notification channels remain frozen. Preserve their code and tests; do not expand
them during this window.

### Owner decision: reopen a narrow pickup experiment

On 2026-09-04, the first two-owner machine test exposed missed pickup as the
dominant communication failure: the Relay stored the message, but the receiving
owner did not know it existed until they manually asked their agent to check the
mailbox. The owner therefore reopened only the smallest L2 pickup experiment.

The approved experiment is limited to:

- an opaque durable recipient-event cursor written atomically with mailbox state;
- an authenticated, replayable event feed whose live connection is only a latency
  hint;
- explicit consent for one exact sender and one locally selected existing Codex thread
  identifier, without claiming the connector can verify its current liveness; and
- a reference adapter that may attract the attention of that session without
  granting the remote peer any local authority.

This decision supersedes the notification-channel and issue #49 freeze only for
that bounded experiment. It does not reopen Mission/Node execution, presence,
automatic answering, remote runtime startup, automatic accept/reply/complete,
workspace mutation, command execution, or any other external side effect. Relay
storage, event observation, local enqueue, model pickup, and reply remain separate
facts.

## 1. Establish the exact current loop

- [ ] Use two different agent identities and two different machines.
- [ ] Use the current Relay, CLI, and MCP packages without a Node or Mission.
- [ ] Record the exact versions, Relay URL class, agent hosts, installation commands,
  and whether either owner needed maintainer intervention.
- [ ] Confirm both local configuration files are private and no credential appears in
  the evidence.
- [ ] Run `agentrelay doctor` and retain its report and exit status as separate facts;
  [#11](https://github.com/swayamg20/AgentRelay/issues/11) already tracks the known
  non-zero-exit gap.
- [ ] Confirm `list_teammates` can identify the intended recipient. Record any ignored
  filter or pagination behavior against
  [#111](https://github.com/swayamg20/AgentRelay/issues/111).

Do not repair the setup silently. Record the failure, elapsed time, attempted
remediation, and final outcome first.

## 2. Run the canonical two-machine proof

[#101](https://github.com/swayamg20/AgentRelay/issues/101) owns this proof. Run its
mailbox contract as written.

### Normal path

1. Owner A invites Owner B, and B joins with a distinct handle.
2. Agent A lists teammates and sends a substantive `ask_question` handoff to Agent B.
3. The Relay returns the stored handoff ID.
4. Agent B, in an already-running host, explicitly calls `check_inbox`.
5. Agent B accepts, inspects the provenance-marked thread, and sends a reply.
6. Agent A opens the same thread and uses the reply in its original work.
7. The receiving owner completes, replies with a refusal, or leaves the thread active
   intentionally; only the sender can cancel a pending handoff, and the evidence must
   not invent a terminal state.

### Offline path

1. Stop B's agent host or MCP process before A sends.
2. Send and confirm only that the Relay stored the handoff.
3. Start B's host later, call `check_inbox`, and complete the same reply loop.
4. Report store time, explicit pickup time, and reply time separately.

### Required evidence

- redacted CLI and MCP transcripts from both sides;
- one handoff/thread ID and ordered message sequence from the real Relay;
- the participant identities and authorization results without raw credentials;
- whether Slack notification occurred, clearly labeled best effort;
- every human instruction needed between send and reply; and
- the exact commit and package versions used.

The proof fails if a maintainer edits database state, manually moves a message,
substitutes a Mission delivery, or claims an open agent session was remotely woken.

## 3. Prove mailbox failure behavior

[#103](https://github.com/swayamg20/AgentRelay/issues/103) owns this handoff
control-plane proof. Run focused existing tests first and add a test only for an
uncovered contract.

- [ ] Retry handoff creation with one idempotency key and identical input; observe
  one handoff.
- [ ] Retry a message append after losing the response; observe one ordered message.
- [ ] Restart the Relay after a committed send; retrieve the same thread afterward.
- [ ] Keep the receiver offline, reconnect later, and retrieve all committed messages
  in order.
- [ ] Attempt a read and mutation as a non-participant; both must fail without thread
  disclosure.
- [ ] Commit a block, then attempt new content from the blocked peer; no later content
  mutation may commit.
- [ ] Attempt append, accept, complete, and cancel operations in invalid or terminal
  states; preserve the documented ownership rules.
- [ ] Inspect returned teammate text, metadata, proposed actions, and typed artifacts
  for provenance preservation.
- [ ] Restart during best-effort notification dispatch; a lost notification must not
  lose the committed handoff.

Any durability, authorization, block, revocation, or provenance failure pauses user
validation until the defect is fixed and the case is rerun.

## 4. Record the product proof

After #101 passes, execute the recording contract in
[#8](https://github.com/swayamg20/AgentRelay/issues/8), which is already reopened.

- [ ] Record a 60-90 second two-machine handoff and reply.
- [ ] Show the recipient explicitly checking the inbox.
- [ ] Keep the inbound provenance marker visible.
- [ ] Redact handles when required and remove every token, invite secret, webhook,
  local path, and unrelated message.
- [ ] Say "stored by the Relay" before pickup and "replied" only after the actual
  reply.
- [ ] Do not mention Mission execution, autonomous wake-up, A2A conformance, or an
  unattended answering agent.

The recording supports pilot recruitment and README truth. It does not satisfy the
30-day demand gate by itself.

## 5. Run repeated-use validation

Use [#102](https://github.com/swayamg20/AgentRelay/issues/102) as the pilot and
decision issue. Record the run in
[`mailbox-pilot-template.md`](mailbox-pilot-template.md).

For every participant pair, record:

| Field | Required evidence |
|---|---|
| Pair context | Same team, cross-team, or cross-company; prior collaboration method. |
| Setup | Elapsed time, successful steps, failed steps, maintainer interventions. |
| Thread purpose | Question, context transfer, clarification, decision, or refusal. |
| Storage/retrieval | Relay store time and whether committed content was later retrievable. |
| Pickup | Explicit inbox-check time and what prompted it. |
| Outcome | Reply, refusal reply, sender cancellation, completion, or documented abandonment. |
| Comparative value | What the pair would otherwise have done and which was easier. |
| Repeat behavior | Whether the pair initiated another real session without prompting. |

- [ ] Recruit five independent pairs, including one without the primary maintainer if
  available.
- [ ] At least four of five pairs complete one real round trip.
- [ ] Collect at least twenty substantive threads across multiple days.
- [ ] At least three of five pairs repeat without founder prompting within seven
  days.
- [ ] Median setup time is under 15 minutes, and at least 90% of stored test messages
  remain retrievable.
- [ ] Include failures and abandoned setup attempts in the report.
- [ ] Interview both owners separately before showing them a preferred conclusion.
- [ ] Publish a `go`, `narrow`, or `stop` result against the precommitted thresholds
  in the roadmap.

## 6. Simulate L2 pickup before building it

- [ ] Use the current notification path or a manual reminder to simulate fast pickup.
- [ ] Manually share a short owner-approved availability status and label it as a
  simulation, not an implemented presence field.
- [ ] Record whether missed pickup is the dominant failure.
- [ ] Build a watch or notification improvement only if the evidence supports it.

## 7. Simulate L3 commitment with current states

- [ ] Use only `pending`, `accepted`, `completed`, and `cancelled` as wire states.
- [ ] Record refusal, no-response, desired ETA, decline, and expiry as user requests
  or outcomes; `declined` and `expired` are not implemented handoff states.
- [ ] Determine whether commitment ambiguity is common enough to justify an L3
  contract proposal.

## 8. Triage measured blockers

Use this order only after evidence identifies a blocker:

1. Correctness and security failures in existing mailbox contracts.
2. Setup truth: [#10](https://github.com/swayamg20/AgentRelay/issues/10),
   [#11](https://github.com/swayamg20/AgentRelay/issues/11), or documentation.
3. Discovery correctness:
   [#111](https://github.com/swayamg20/AgentRelay/issues/111).
4. Pickup ergonomics: [#39](https://github.com/swayamg20/AgentRelay/issues/39),
   while durable polling remains authoritative.
5. Notification durability:
   [#44](https://github.com/swayamg20/AgentRelay/issues/44), only if notifications
   materially affect repeated use.
6. Operational recovery:
   [#34](https://github.com/swayamg20/AgentRelay/issues/34).
7. User-owned archive:
   [#40](https://github.com/swayamg20/AgentRelay/issues/40).

Prefer a small correction to the current path. Do not turn a pickup problem into
remote runtime activation, or a notification problem into delivery truth.

## 9. End-of-window decision

- [ ] Reconcile every pilot thread and failure with the evidence log.
- [ ] Report metrics without combining Relay storage and user pickup latency.
- [ ] Apply the roadmap's go/narrow/stop thresholds.
- [ ] Name the smallest next product bet, if any.
- [ ] Decide separately whether any Labs or interoperability issue has earned
  reactivation.
- [ ] Update the README and landing page only after the product decision is supported
  by evidence.

## Frozen Labs and interoperability state

The following accomplishments remain valid history: executable Mission schemas,
the durable Mission/delivery ledger, Relay restart and Node replay proofs, the
foreground Node, persistent fake Capsule, local capability monitor, unactivated
Codex runner/guardian, and Linux containment boundary.

During the 30-day window:

- do not merge or open a PR for `codex/issue-98-codex-activation`;
- do not implement #93, #94, #97-#100, #104, #112, #114-#116, #118, or #120;
- do not implement #49 or use SSE/WebSocket as correctness;
- do not implement A2A issues #105-#110 or #113; and
- continue to fix security defects or regressions in already merged Labs code when
  they threaten the repository, but do not treat maintenance as product validation.

## Explicitly deferred

- File/object storage, relay-blind encryption, cross-Relay federation, and hosted
  tenancy until a validated workflow requires them.
- Cursor, aider, Continue, Zed, IDE, mobile, or admin clients until a pilot user is
  blocked on that host or surface.
- Metrics, rate limits, scale work, HA, and multi-region design until measured
  operating evidence requires them.
- Extra notification channels, digesting, and quiet-hour policy until pickup behavior
  is understood.
- Automatic agent answering, autonomous execution, and every external side effect.
