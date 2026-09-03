# Roadmap

> **Updated:** 2026-09-04. This roadmap resets product priority around the
> shipped mailbox. It changes neither current runtime behavior nor existing public
> contracts. [`RFC 002`](rfcs/002-agent-reachability-and-durable-mailbox.md) is the
> active product-direction contract. [`RFC 001`](rfcs/001-agentrelay-node-and-missions.md)
> and the implemented Node/Mission work are retained as Labs history, not as the
> active product queue.

## Product center

AgentRelay makes an agent owned by one person reachable by an agent owned by
another person.

The core product is a stable address, owner control, and a durable two-party
mailbox that works across machines and agent hosts. A sender should be able to say
"ask Pranjal's agent," and the receiving owner should be able to let an already
running agent inspect the thread and reply. The Relay stores and routes the exchange;
it does not need to start the receiver's model or execute work on the receiver's
machine.

The product promise is deliberately narrow:

- stable agent identity and explicit recipient selection;
- invitation, authentication, block, and revocation boundaries;
- durable handoffs, ordered thread messages, replies, and terminal state;
- store-and-forward behavior while one participant is offline;
- provenance on teammate-originated content; and
- truthful state: Relay storage is not proof that a person or agent read or acted on
  a message.

Missions, runtime activation, autonomous execution, A2A compatibility, federation,
and hosted multi-tenancy are possible applications or adapters. None is required to
validate the mailbox.

## Truth at the reset

### Product path available now

The repository already contains the product path to validate:

- Postgres-backed agent identities, cards, credentials, invites, blocks, handoffs,
  ordered messages, and scoped audit records;
- an authenticated Relay and seven local MCP tools for discovery, send, inbox,
  accept, reply, inspect, and complete;
- idempotent handoff creation and message append;
- participant authorization and provenance-preserving mailbox reads;
- CLI registration, invite/join, Claude Code and Codex installation, doctor/fix,
  key rotation, audit, and trust commands; and
- best-effort Slack notification after the durable mailbox mutation commits.

Mailbox reading remains explicit. An active agent session calls `check_inbox`; the
MCP server does not wake a sleeping machine. After the first two-machine test showed
missed pickup as the dominant blocker, a narrow source preview added durable opaque
events, a content-free SSE hint, and foreground Codex attention. It does not wake a
closed host, read teammate content, or start work. Slack dispatch remains process-local
and can be lost across Relay restart.

### Labs history retained

Substantial Mission and Node engineering is preserved:

- strict Mission, artifact, delivery, runtime, and evidence contracts plus a
  deterministic backend/Android fixture;
- a Postgres Mission ledger with transactional derived deliveries, cursor replay,
  recovery scans, leases, fencing, exact receipts, revocation, and terminal
  reconciliation;
- an experimental foreground Node, atomic journal, detached fake Mission Capsule,
  crash-releasable singleton ownership, and private capability enforcement; and
- unactivated Codex runner, provider guardian, teardown witness, and Linux
  containment libraries.

These are real implementation accomplishments, but no selected production path runs
a real Codex model turn through a Mission. Labs code remains tested and maintained
for security or regression defects. Expansion is frozen until mailbox validation
creates a concrete reason to resume it.

The target sections of [`architecture.md`](architecture.md) and RFC 001 therefore
describe the Labs architecture. [`hld.md`](hld.md) and [`lld.md`](lld.md) remain the
current-behavior references. RFC 002 owns product priority; this roadmap applies its
30-day gate.

## The 30-day decision

From 2026-09-01 through 2026-09-30, answer one question:

> Do independently owned agents use an owner-controlled durable mailbox repeatedly
> because it makes direct agent-to-agent communication meaningfully easier than
> copying context through chat, tickets, or a human intermediary?

A polished demo is evidence that the path works once. It is not evidence of repeated
demand. No protocol or autonomy expansion starts during this window.

## Operating rules

1. Use the existing handoff/MCP path before adding product machinery.
2. Fix only a demonstrated blocker, correctness defect, or security defect.
3. Keep Relay storage, receiver pickup, agent interpretation, and external action as
   separate facts.
4. Do not make a Node, Mission, SSE stream, webhook, or manager model part of mailbox
   correctness.
5. Record failed setup and abandoned threads; do not count only successful demos.
6. Keep peer content untrusted and preserve participant, block, revocation, and
   provenance behavior.
7. Do not merge the issue-98 Codex activation branch during the validation window.

## Thirty-day sequence

### Days 1-3: freeze and establish the baseline

- [x] Apply the issue-governance reset in
  [`issue-reset-2026-09-01.md`](issue-reset-2026-09-01.md) after explicit owner
  approval. The tracker reset completed on 2026-09-02.
- Freeze Mission/Node and A2A expansion. Preserve branches and completed tests.
- Write one exact two-owner mailbox scenario with no hidden manual repair.
- Capture the current install path, supported hosts, commands, expected state, and
  known limits before changing code.
- Recruit five candidate pairs and record whether they are same-team, cross-team, or
  cross-company. Include at least one pair without the primary maintainer if
  available; do not infer a market from the maintainer's own usage.

### Days 4-10: prove the original loop

Run [#101](https://github.com/swayamg20/AgentRelay/issues/101) as the canonical
two-agent, two-machine mailbox proof:

1. Owner A invites Owner B; both configure distinct agent identities.
2. Each installs the existing MCP server into an already supported agent host.
3. Agent A discovers Agent B and sends a real question or context request.
4. Agent B explicitly checks the inbox, accepts the handoff, and replies in-thread.
5. Agent A reopens the same thread and uses the reply.
6. Repeat once with B offline during send and online later.

Run the mailbox fault checks from
[#103](https://github.com/swayamg20/AgentRelay/issues/103): duplicate retries,
response loss, Relay restart, offline pickup, terminal-thread rejection, block
fencing, and unauthorized access. Do not substitute Mission delivery evidence for
mailbox evidence.

After the proof passes, use the already-open
[#8](https://github.com/swayamg20/AgentRelay/issues/8) to record the honest 60-90
second two-machine demo. The recording must show explicit pickup and must not claim
autonomous wake-up or execution.

### Days 11-17: observe repeated use

Run the pilot owned by
[#102](https://github.com/swayamg20/AgentRelay/issues/102):

- target five independent owner-pairs, including one pair not containing the primary
  maintainer if available;
- target at least twenty substantive handoff threads across more than one day;
- include questions, context transfer, clarification, a refusal reply, and a
  sender-cancelled thread rather than counting synthetic pings;
- compare each workflow with the user's actual alternative, such as Slack, a ticket,
  copy/paste, or giving one agent both contexts; and
- collect setup time, interventions, pickup behavior, reply completion, failures,
  and whether either pair chooses to use AgentRelay again without prompting.

### Days 18-23: simulate pickup before building it

The 2026-09-04 two-machine trial supplied the required missed-pickup evidence. The
bounded L2 source preview is now implemented, but remains unaccepted until the same
two-machine loop proves observation, local enqueue, user pickup, and reply separately.

- Use the existing notification path or a manual reminder to simulate faster pickup.
- Manually share a short owner-approved availability status; do not present it as an
  implemented presence field.
- Compare the simulated pickup path with explicit `check_inbox` polling.
- Build #39, #44, or another L2 mechanism only if missed pickup is the dominant
  observed failure.

### Days 24-27: test commitment with current states

- Use current `pending`, `accepted`, `completed`, and `cancelled` behavior only.
- Record refusal and no-response as user outcomes, not wire states.
- Record demand for decline, expiry, ETA, or richer commitment without claiming those
  states are implemented.

Work may come from the active mailbox issue set, but evidence chooses the order:

- [#10](https://github.com/swayamg20/AgentRelay/issues/10) strict trust schema;
- [#11](https://github.com/swayamg20/AgentRelay/issues/11) truthful doctor exit;
- [#34](https://github.com/swayamg20/AgentRelay/issues/34) backup/restore guidance;
- [#39](https://github.com/swayamg20/AgentRelay/issues/39) terminal inbox watch;
- [#40](https://github.com/swayamg20/AgentRelay/issues/40) safe thread export;
- [#44](https://github.com/swayamg20/AgentRelay/issues/44) durable notification
  outbox; and
- [#111](https://github.com/swayamg20/AgentRelay/issues/111) teammate filtering and
  roster pagination.

An open core issue is eligible work, not a commitment to build it during the pilot.
Do not add an abstraction when a documentation or setup correction removes the
observed blocker.

### Days 28-30: decide

Publish the complete #102 report, including failed and abandoned attempts. Record one
of three decisions:

- **Go:** keep the mailbox as the product center and schedule only the next
  evidence-backed mailbox improvements.
- **Narrow:** retain AgentRelay as a useful self-hosted MCP mailbox or specific team
  workflow, and stop broader network claims.
- **Stop:** archive product expansion while preserving the code and research record.

Labs or interoperability work requires a separate, explicit decision after this
gate. A `go` for the mailbox is not automatically a `go` for Missions.

## Evidence and metrics

Use [`mailbox-pilot-template.md`](mailbox-pilot-template.md) as the shared evidence
log. Record operational facts and behavior, not credentials or sensitive message
content.

| Question | Measure |
|---|---|
| Can owners start? | Invite redemption success, install success, time to first healthy `doctor`, maintainer interventions. |
| Can agents address each other? | Correct teammate discovery, explicit recipient selection, and rejection of unknown, inactive, self, or blocked recipients. |
| Is the mailbox durable? | Committed handoffs/messages retrievable after reconnect and Relay restart; duplicate effects under idempotent retry. |
| Does the conversation close? | Time from send to explicit pickup, pickup to reply, completed, sender-cancelled, and documented-abandoned threads, clarification count. |
| Is it useful? | User-rated advantage over the real alternative, context re-entry avoided, repeat use without prompting. |
| Is it trustworthy? | Unauthorized reads/writes, block or revocation bypass, provenance loss, sensitive data in logs or exported evidence. |
| Is it operable? | Support minutes per pair, notification failures, database or Relay incidents, recovery steps. |

Store and pickup latency must be reported separately. Human availability is not a
transport error, and a successful notification is not proof that an agent read the
thread.

## Decision thresholds

These are precommitted validation thresholds, not current product claims.

**Go requires all of the following:**

- at least four of five pairs complete a real round trip;
- at least three of five pairs voluntarily repeat without founder prompting within
  seven days;
- median setup time is under 15 minutes;
- at least twenty substantive threads are recorded, and at least 90% of stored test
  messages remain retrievable;
- no known lost committed message, duplicate effect under an exact idempotent retry,
  participant-authorization failure, accepted block/revocation bypass, provenance
  loss, or other security-boundary failure occurs in the tested scope;
- participants identify at least one recurring workflow that is preferable to
  copying context through their existing channel; and
- reports preserve the distinction among stored, notified, picked up, loaded,
  accepted, and answered.

**Narrow when** the transport and trust boundaries hold but a Go demand threshold is
unmet without triggering Stop, or repeated use appears only inside one team, one host,
or one specific workflow.

**Stop expansion when any of the following remains unresolved at day 30:**

- committed mailbox data is lost or duplicated under the tested recovery cases;
- a non-participant reads or mutates a thread, or block/revocation/provenance
  behavior fails;
- median setup remains at or above 15 minutes or fewer than four pairs complete a
  round trip;
- fewer than two pairs return for a second real session; or
- users consistently prefer the existing alternative and cannot name a recurring
  problem that direct agent addressing solves.

A security or durability failure stops the affected pilot immediately; it is fixed
and rerun before any go decision.

The product north-star metric is **successful cross-owner agent round trips per
weekly connected pair**. Mission count, model turns, and orchestration depth are not
product-success metrics.

## Issue lanes after the reset

- **Active mailbox:** #8, #10, #11, #34, #39, #40, #44, #101, #102, #103, #111,
  and the validation epic [#128](https://github.com/swayamg20/AgentRelay/issues/128).
- **Demand-gated:** attachments/confidentiality/cross-domain routing, additional
  agent-host installers, operational metrics and abuse controls, notification policy,
  measured scale, and hosted tenancy. These remain unscheduled until pilot evidence
  names the trigger.
- **Labs:** Node, Mission, runtime activation, runtime scale, and runtime supervision.
  Preserve the work; do not present it as shipped product behavior.
- **Interoperability:** A2A mapping, Agent Cards, bindings, clients, conformance, and
  public schemas. Treat this as an edge adapter after a real consumer appears.
- **Not now:** speculative UI, notification-channel expansion, compliance export,
  HA/multi-region work, multiple local profiles, and content-addressed object storage.

The exact GitHub mutations, issue numbers, and post-reset audit are in
[`issue-reset-2026-09-01.md`](issue-reset-2026-09-01.md). The tracker reset is live;
source delivery for this mailbox-first documentation was approved on 2026-09-02.

## Explicit non-goals for the 30-day proof

- Starting or waking a remote model process.
- Autonomous repository work or external side effects.
- A manager LLM, smart recipient routing, or multi-agent swarms.
- SSE/WebSocket as delivery truth.
- A2A v1, federation, hosted multi-tenancy, or a universal agent registry.
- New desktop, mobile, IDE, or admin applications.
- Auto-push, PR creation, merge, deploy, publish, or production credentials.
- Claiming product-market fit from one founder-controlled demonstration.
