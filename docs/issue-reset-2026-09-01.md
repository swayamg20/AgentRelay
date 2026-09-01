# GitHub issue reset — executed 2026-09-02

> **Status:** Executed with explicit owner approval. The issue, label, and milestone
> changes below are live in `swayamg20/AgentRelay`; the canonical validation epic is
> [#128](https://github.com/swayamg20/AgentRelay/issues/128). No branch, pull request,
> commit, release, deployment, or preserved stash was changed by the reset.

## Snapshot and intent

The live repository snapshot captured before execution was:

- repository: `swayamg20/AgentRelay`;
- default branch: `main` at
  `eb5c1a511b2f6690ddceff85918f021aef3a5fb3`;
- 52 open issues;
- five open milestones, all organized around Mission, Node, A2A, scale, or
  post-evaluation expansion; and
- remote branch `codex/issue-98-codex-activation` at
  `747b0b1ab36728f99f7c59d313827dc84606f73c`, 35 commits ahead of `main`, with no
  GitHub pull request.

The reset implements the priority decision in
[`RFC 002`](rfcs/002-agent-reachability-and-durable-mailbox.md): the shipped handoff
mailbox is the product-validation center. It does
not erase merged Mission/Node work, rewrite issue history, or authorize deletion of
branches. Labels describe scheduling intent; domain labels such as `security`,
`reliability`, `protocol`, and `runtime` remain useful.

## Created scheduling labels

The reset created these labels:

| Label | Applied color | Meaning |
|---|---:|---|
| `core-mailbox` | `0E8A16` | Stable identity, owner control, durable threads, explicit pickup, reply, and mailbox reliability. |
| `demand-gated` | `FBCA04` | Unscheduled until named pilot or operator evidence triggers the work. |
| `labs` | `6F42C1` | Preserved Mission, Node, and runtime research outside the active product roadmap. |
| `interop` | `1D76DB` | Optional public protocol or agent-host interoperability work. |
| `not-now` | `CFD3D7` | Closed product expansion without current validation evidence. |

Do not delete the existing `runtime`, `protocol`, `evaluation`, `security`, or
`reliability` labels. Do not globally delete `ideas` or `backlog` in this reset; the
new lane labels take scheduling precedence, and label cleanup can happen later.

## One active milestone

The reset created exactly one active roadmap milestone:

- **Title:** `Mailbox 1.0 — 30-day validation`
- **Due date:** 2026-09-30
- **Description:** `Prove repeated two-owner, two-machine use of AgentRelay's stable-address, owner-controlled durable mailbox. A demo is necessary but not sufficient. End with go, narrow, or stop.`

It contains the new mailbox meta-issue and issues #8, #10, #11, #34, #39, #40,
#44, #101, #102, #103, and #111. No demand-gated, Labs, interoperability, or
not-now issue belongs to it.

## Replaced the previous roadmap epic

### Created #128

- **Title:** `Epic: validate agent reachability and the durable mailbox`
- **Labels:** `core-mailbox`, `evaluation`, `epic`
- **Milestone:** `Mailbox 1.0 — 30-day validation`

The body states the 30-day decision question, lists #101 then #103 then #102 as the
proof sequence, makes #8 depend on the passing proof, lists the active core issues,
and copies the go/narrow/stop thresholds without expanding them.

### Closed #121 as superseded

The reset closed
[#121 — Epic: real Missions, A2A v1 interoperability, and evidence-gated scale](https://github.com/swayamg20/AgentRelay/issues/121)
without editing away its existing body or labels. It added this closing comment:

> Closing as superseded by #128, the mailbox-first 30-day validation roadmap. The
> Mission, Node, and A2A work referenced here is preserved under Labs or
> interoperability labels; it is not being reverted or represented as shipped
> mailbox behavior.

This keeps the old dependency graph auditable while removing it as the canonical
product roadmap.

## Applied special issue mutations

### #8 — reopen the honest product demo

For
[#8 — Record demo video for README hero](https://github.com/swayamg20/AgentRelay/issues/8):

- reopen;
- retitle to `Record the two-agent, two-machine mailbox proof`;
- remove `ideas`;
- add `core-mailbox` and `evaluation` while retaining `documentation` and `release`;
- assign `Mailbox 1.0 — 30-day validation`; and
- make the issue depend on the passing #101 proof.

Replace the body with this contract:

- record a 60-90 second exchange between two distinct agent identities on two
  machines using the current MCP mailbox;
- show discovery, send, explicit receiver inbox check, provenance-marked content,
  reply, and sender thread read;
- redact every credential, invite secret, webhook, sensitive handle, local path, and
  unrelated message;
- distinguish Relay storage from receiver pickup and reply; and
- make no Mission, autonomous wake-up, unattended answering, or A2A conformance
  claim.

The previous closure reason was Mission-centered; reopening is intentional because
the manual mailbox is again the product being validated.

### #101 — rewritten proof

For
[#101 — Proof: complete the real two-machine backend and Android Mission](https://github.com/swayamg20/AgentRelay/issues/101):

- retitle to `Proof: complete the two-agent, two-machine mailbox loop`;
- remove `runtime`;
- add `core-mailbox` while retaining `reliability`, `security`, `evaluation`, and
  `epic`;
- move from `Two-node evidence pilot` to `Mailbox 1.0 — 30-day validation`; and
- replace Mission/Node acceptance with the exact normal and offline scenarios in
  [`next-steps.md`](next-steps.md).

Acceptance requires two owners, two machines, two distinct identities, current
supported MCP hosts, one substantive ask/reply thread, one offline-then-pickup case,
redacted evidence from both sides, and an honest list of all human prompts. A Node,
fake adapter, Mission, or autonomous repository edit does not satisfy it.

### #102 — rewritten product evaluation

For
[#102 — Evaluation: compare typed Missions against controlled collaboration baselines](https://github.com/swayamg20/AgentRelay/issues/102):

- retitle to `Evaluation: validate repeated agent-to-agent mailbox use`;
- add `core-mailbox` while retaining `evaluation` and `epic`;
- move from `Two-node evidence pilot` to `Mailbox 1.0 — 30-day validation`; and
- replace the autonomous coding comparison with the 30-day repeated-use pilot.

The issue owns recruitment of five independent pairs, at least twenty substantive
threads, at least four completed pair round trips, at least three unprompted repeats
within seven days, median setup below 15 minutes, at least 90% stored-message
retrievability, comparison with each pair's real alternative, failures, and the final
go/narrow/stop decision against the thresholds in [`roadmap.md`](roadmap.md).

### #103 — rewritten reliability proof

For
[#103 — Reliability evaluation: inject replay, duplication, crash, and lease faults](https://github.com/swayamg20/AgentRelay/issues/103):

- retitle to `Reliability: prove mailbox storage, retrieval, and reply under retry and restart`;
- remove `runtime`;
- add `core-mailbox` while retaining `reliability` and `evaluation`;
- move from `Two-node evidence pilot` to `Mailbox 1.0 — 30-day validation`; and
- replace Node leases and Mission runtime faults with handoff creation/append
  idempotency, lost response, Relay restart, offline retrieval, participant
  authorization, block fencing, terminal transitions, notification loss, and
  provenance tests.

Existing Mission fault tests remain valid Labs evidence, but they do not close this
rewritten mailbox issue.

### #97 — preserve the partial capability checkpoint in Labs

For
[#97 — Security: enforce local capability grants and side-effect policy outside the model](https://github.com/swayamg20/AgentRelay/issues/97):

- add `labs`;
- remove it from `Guarded Real Mission 0`; and
- keep it open and parked.

[PR #127](https://github.com/swayamg20/AgentRelay/pull/127), merged at
`eb5c1a511b2f6690ddceff85918f021aef3a5fb3`, added the private capability
reference-monitor checkpoint. The active docs explicitly describe that as partial:
it is not composed with Codex, exposes no registered verification-command executor,
does not mediate every concrete side effect, and lacks the issue's live adversarial
proof. Do not close the issue as completed or move the checkpoint into the product
path.

## Applied issue lane manifest

Every issue that was open in the pre-reset snapshot is accounted for below. Existing
domain labels were preserved unless a special mutation explicitly removed one.

### Active mailbox

The reset added `core-mailbox`, kept these issues open, and assigned the new
milestone:

- #10, #11, #34, #39, #40, #44, and #111;
- rewritten #101, #102, and #103; and
- reopened #8.

The new meta-issue is also in this lane. An active label makes work eligible; it does
not override the evidence-first order in `docs/next-steps.md`.

### Demand-gated

The reset added `demand-gated`, kept these issues open, removed any old milestone,
and left them unscheduled:

- #19 — bounded mailbox attachments only after repeated attachment friction;
- #21 — Relay visibility/encryption decision after a concrete trust requirement;
- #22 — cross-domain addressing/federation after repeated cross-organization use;
- #25 and #26 — additional agent-host installers after a pilot user is blocked;
- #30 — operational metrics after an operator or validation measurement requires it;
- #31 — abuse limits after observed exposure or public-service demand;
- #38 — receiver-owned notification policy after pickup behavior is understood;
- #45 — scale envelope after measured traffic justifies it; and
- #119 — tenant isolation only after an explicit hosted multi-organization decision.

Issue bodies may be narrowed when their trigger occurs. Do not pre-build the existing
broad scope merely because the issue remains open.

### Labs

The reset added `labs`, kept these issues open, removed any old milestone, and added
one parking comment linking to #128:

- #49, #93, #94, #97, #98, #99, #100, #104, #112, #114, #115, #116, #118, and
  #120.

Applied parking comment:

> Parked under AgentRelay Labs during the mailbox-first 30-day validation. Existing
> code, tests, branches, and research remain preserved. Do not expand or present this
> issue as shipped product behavior unless a later explicit decision reactivates the
> Labs roadmap. Active validation is tracked in #128.

Do not close or delete the remote issue-98 branch. Do not create or merge a PR from
it during the validation window.

### Interoperability

The reset added `interop`, kept these issues open, removed the
`A2A v1 interoperability` milestone, and added one parking comment to:

- #105, #106, #107, #108, #109, #110, and #113.

Applied comment:

> Parked as optional edge interoperability. The durable mailbox is the product under
> validation; A2A mapping, Agent Cards, bindings, clients, conformance, streaming,
> and public schemas resume only for a named external consumer. This is not a claim
> of current A2A v1 conformance. Active validation is tracked in #128.

### Not now

The reset added `not-now`, removed any old milestone, and closed as not planned:

- #27 — VS Code extension;
- #28 — mobile companion;
- #29 — admin web UI;
- #32 — privileged bulk audit/block export;
- #33 — SSO/OIDC;
- #35 — HA and multi-region design;
- #36 — Discord/Teams/generic webhook adapters;
- #37 — email digest;
- #41 — multiple local profiles; and
- #117 — content-addressed object storage. Rewritten #19 owns the smallest future
  mailbox-attachment decision.

Each closure explains that the idea may still have value, gives an issue-specific
evidence trigger for reopening, and links to #128. The common wording is:

> Closing as not planned during the mailbox-first validation window. This does not
> assert that the idea has no value; it removes unvalidated expansion from the active
> board. Reopen or replace it only when observed user or operator evidence names the
> requirement. Active validation is tracked in #128.

## Old milestone disposition — completed

The reset did not delete old milestones. It moved their open issues as specified
above, then closed the milestones so their closed-issue history and links remain
inspectable.

| Milestone | Applied disposition |
|---|---|
| `Guarded Real Mission 0` (#3) | Move #93, #94, and #97-#100 to Labs with no milestone. Keep already closed #90, #91, #92, #95, and #96 attached as history. Close the milestone. |
| `Two-node evidence pilot` (#4) | Move rewritten #101-#103 to the new mailbox milestone. Move #104 to Labs with no milestone. Close the old milestone. |
| `A2A v1 interoperability` (#5) | Move #105-#110 and #113 to interoperability with no milestone. Close the milestone. |
| `Measured scale and operations` (#6) | Move #44 to the new mailbox milestone; #30, #31, and #45 to demand-gated; and #49 plus #114-#116 to Labs. Close the milestone. |
| `Post-evaluation expansion` (#7) | Close #32, #35, and #117 as not now; move #119 to demand-gated; move #118 and #120 to Labs. Close the milestone. |

## Execution result and audit

The post-reset read-only audit found:

- 43 open issues, each with exactly one scheduling lane;
- 12 `core-mailbox`, 10 `demand-gated`, 14 `labs`, and 7 `interop` issues;
- no open `not-now` issue and no issue with multiple scheduling lanes;
- exactly 12 issues in `Mailbox 1.0 — 30-day validation`, all in the core lane;
- no non-core issue attached to an open milestone;
- old milestones #3 through #7 closed with their history retained;
- #8 reopened and #101-#103 rewritten around the mailbox proof;
- #97 still open and parked in Labs;
- #121 and the ten not-now issues closed as not planned; and
- 11 open pull requests plus the preserved issue-98 branch still at
  `747b0b1ab36728f99f7c59d313827dc84606f73c`.

The tracker reset itself did not commit or push the local documentation changes.
Source delivery was approved separately on 2026-09-02.
