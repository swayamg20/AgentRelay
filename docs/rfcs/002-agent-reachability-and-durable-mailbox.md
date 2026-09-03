# RFC 002: Agent reachability and durable mailbox

- **Status:** Accepted product-direction reset
- **Date:** 2026-09-01
- **Scope:** Product priority, capability layering, repository governance, and validation
- **Supersedes:** [RFC 001](001-agentrelay-node-and-missions.md) as product priority only

## Decision

AgentRelay's primary product is a neutral, durable, consent-based communication network
for independently owned agents.

The simplest complete statement of the product is:

> My agent can message your agent.

AgentRelay first makes an agent addressable, then lets another agent send it a durable
message or request and continue a two-party thread across machines and runtimes. The
Relay owns identity, routing, persistence, authorization, audit, and revocation. It does
not run a model or gain authority over either participant's machine.

Product development follows this order:

1. Communication.
2. Coordination.
3. Explicit commitment.
4. Delegation.
5. Autonomous execution.

Each step is an optional capability layer. A later layer must not become a prerequisite
for an earlier one.

## Relationship to RFC 001

[RFC 001: AgentRelay Node and Missions](001-agentrelay-node-and-missions.md) remains a
valid technical record for the Mission control plane, local Node, runtime adapter,
durability, containment, and authority boundaries. This RFC does not invalidate its
schemas, state machines, tests, security invariants, or implemented recovery work.

This RFC supersedes RFC 001 only in product priority:

- The durable mailbox is the product, not a compatibility surface.
- Missions are an optional Labs application built on the communication network, not the
  default product experience or near-term roadmap.
- A real autonomous coding Mission is no longer the next product gate. Real mailbox use
  and repeat behavior are the next product gates.
- MCP remains the local tool and context boundary. It is not a portable wake-up
  mechanism.
- A2A remains a possible public interoperability boundary. Conformance is not a
  substitute for product demand.

Active code and tests remain the source of truth for current behavior. This product
decision does not silently change any existing HTTP, JSON-RPC, MCP, CLI, database, or
configuration contract.

## Why

The shipped mailbox already expresses the original and clearest user need: one person
can ask their running agent to contact another person's agent, and the Relay preserves
that exchange while the two owners retain their own credentials, context, and local
authority.

The later Mission work solves a materially different problem. It introduces local
process supervision, workspace selection, runtime activation, command and network
policy, crash recovery, execution evidence, verification, and consequence control.
Those are legitimate requirements for autonomous execution, but they should not define
the communication network before users demonstrate that they need that execution mode.

The current implementation supports this separation:

- `agentrelay-mcp` exposes the usable mailbox to already-running model hosts.
- The Relay persists identity, handoffs, ordered messages, and audit independently of a
  production runtime.
- The private Node and Mission protocol packages are separate workspaces.
- Mission and Node routes are distinct from the mailbox route surface, although some
  owner routes and database state share the Relay.
- The current Node selects deterministic fake runtimes on main. Unactivated Codex
  libraries and security checkpoints are not a real autonomous product path.

Deleting the Mission work would discard useful safety and distributed-systems research.
Continuing to place it at the center would allow an unvalidated application to obscure
the implemented mailbox primitive. The lowest-regret choice is to preserve it in a
clearly bounded Labs lane while validating mailbox demand and real-pair reliability.

## Capability layers

### L0: identity and consent

**Promise:** an agent can have a stable address, and its owner controls participation.

L0 includes authenticated identity, invitations, contact discovery, local trust,
blocking, and credential rotation. Existing identity, invite, block, trust, and
participant checks form the current foundation; they do not yet implement a
per-contact consent request. Handoff acceptance belongs to L3 and records task
commitment, not contact consent.

Rules:

- Identity is distinct from a running model session or device process.
- A registered address does not imply availability.
- Blocking and revocation must fence later communication or work according to the
  relevant current contract.
- The Relay must not expose secrets or raw credentials as identity metadata.

### L1: durable correspondence

**Promise:** one agent can send another agent a durable message or request and continue a
thread after either side disconnects.

L1 is the core product. It includes two-party threads, ordered messages, questions,
proposals, results, typed attachments where supported, participant authorization,
idempotent mutations where defined, provenance marking, and audit.

The Relay's successful storage response means it accepted responsibility for the
durable thread mutation. It does not mean that a notification arrived, a device picked
up the thread, a model loaded it, or the recipient answered.

### L2: advisory availability and pickup

**Promise:** a user can receive a faster indication that another side may be reachable,
and an owner-approved local connector can be told that queued mail exists.

L2 may include an availability card, bounded last-seen information, quiet hours,
notifications, a watch command, or low-latency replay hints. It is optional.

Rules:

- Availability is advisory, owner-controlled, and expires unless refreshed.
- A notification or SSE/WebSocket event means "check durable state now." It is never
  the sole copy of work or execution authority.
- Losing, duplicating, or reordering every hint must not lose or duplicate a message.
- "Wake" means notifying or prompting an already-running, locally approved connector.
  AgentRelay does not wake a powered-off or sleeping machine.
- "What is Pranjal's agent doing?" may return an explicitly shared status such as
  `available`, `busy`, `offline`, or a short owner-approved focus string. It must not
  expose local processes, repositories, prompts, or activity by inference.

### L3: explicit commitment

**Promise:** the receiving side can explicitly accept, decline, answer, or allow a
request to expire, and both participants can distinguish those states.

L3 is coordination over a thread, not autonomous execution. Current handoffs already
support recipient acceptance, participant messages, and recipient completion. Decline,
expiry, ETA, and richer commitment semantics are future product decisions and must not be
claimed as implemented until their state and ownership rules exist.

Rules:

- Commitment is opt-in and attributable to the receiving side.
- Stored, notified, picked up, loaded, accepted, answered, declined, and expired are
  separate facts. AgentRelay reports only facts it can observe.
- Accepting a request grants no filesystem, command, network, credential, or external
  side-effect authority.
- The mailbox lifecycle must not be stretched into a general workflow scheduler.

### L4: bounded autonomous execution

**Promise:** after an explicit local grant, an owner-controlled runtime may perform a
bounded autonomous run and return evidence.

L4 contains Missions, the AgentRelay Node, runtime adapters, Capsules, workspace
containment, capability grants, leases, fencing, recovery, verification, and execution
evidence. It is a Labs application.

Rules:

- L4 requires a separate, explicit local authority grant. L0 contact consent or L3
  request acceptance cannot create that grant.
- Remote text may propose work but never choose a local path, command, sandbox, secret,
  permission, budget, or network destination.
- Important limits and consequence gates are enforced outside the model.
- Autonomous execution is described as experimental until a guarded real-runtime proof,
  adversarial evaluation, and product-value evaluation pass.
- A user can use L0-L3 without installing or running the Node.

## Cross-layer invariants

1. **The Relay is model-free.** It applies deterministic identity, authorization,
   routing, state, audit, and revocation rules.
2. **Cross-agent content is untrusted.** Teammate-originated text-bearing fields retain
   provenance before reaching a local model.
3. **Messages do not confer authority.** Transporting a proposal is different from
   authorizing its effect.
4. **The receiver remains sovereign.** The receiving owner controls pickup, disclosure,
   local context, response mode, and any later execution grant.
5. **Durable state is authoritative.** Push, presence, SSE, WebSocket, and local process
   status are hints or observations, not replacements for persisted state and replay.
6. **Claims match evidence.** AgentRelay does not call a message read, a request accepted,
   or work completed without an observed event supporting that claim.
7. **State-changing operations preserve their correctness boundaries.** Edge validation,
   participant authorization, idempotency strategy, and transactionally consistent audit
   remain required where the contract depends on them.
8. **Local authority stays local.** Remote peers never select local paths, credentials,
   permissions, secrets, commands, or sandbox policy.
9. **No manager model is required.** Use deterministic state machines where the state and
   ownership rules are known.
10. **Higher layers cannot weaken lower layers.** Enabling presence, commitment, or
    autonomy must not reduce mailbox durability, consent, trust, or revocation.

## Vocabulary

The primary product uses language that describes what users observe:

| Preferred term | Meaning | Compatibility note |
| --- | --- | --- |
| Agent address | Stable identity used to reach an independently owned agent | Existing handles remain valid |
| Contact | An agent identity a user may communicate with | Does not imply online presence |
| Message | One unit of correspondence | May remain represented by current message schemas |
| Request | A message that asks the receiving side for a response | Existing `handoff` APIs remain compatible |
| Thread | Durable two-party correspondence | Existing handoff thread is the current implementation |
| Availability | Owner-controlled advisory status | Not the current account `status` field |
| Notification | A hint that durable state may have changed | Not a delivery or read receipt |
| Accepted | The receiving side explicitly committed to the request | Current recipient acceptance is narrower than execution authority |
| Answered | The receiving side supplied a result or response | Current completion is the nearest implemented state |
| Declined / expired | Explicit future terminal outcomes | Not implemented by the current handoff lifecycle |
| Local connector | Optional receiver-side process for pickup or later runtime work | `AgentRelay Node` remains the Labs implementation term |
| Autonomous run | Experimental bounded execution | `Mission` remains the internal and Labs term |

`Capsule`, `lease`, `fence`, `verification generation`, and similar terms remain internal
or Labs vocabulary. They should not appear in the basic product explanation unless a
user is configuring or debugging autonomous execution.

## Same-repository Labs quarantine

Missions remain in this repository for now. Moving them immediately would duplicate or
split shared identity, authorization, schema, routing, and security contracts and would
create migration work unrelated to validating the mailbox. Archiving them only on a
branch would allow important recovery and security work to decay.

The quarantine rules are:

- `mcp-server/` and the Relay mailbox path define the primary usable product.
- Mission-specific `protocol/` contracts, `node/`, Mission/Node Relay surfaces, and
  their research documents are a Labs lane.
- Main product documentation, onboarding, demonstrations, and success metrics lead with
  L0 and L1. L4 appears only in a clearly labelled experimental section.
- The Labs lane remains buildable, testable, and security-maintained.
- During the validation period, Labs receives no feature expansion except a critical
  security, data-loss, or compatibility fix.
- Large unmerged runtime-activation work remains preserved but does not land merely to
  protect sunk effort.
- Existing public contracts are not silently disabled. Any future default-off route or
  configuration gate requires a consumer audit, compatibility decision, and documented
  migration.
- Core package release and onboarding must not require a Node, Capsule, workspace policy,
  or coding-agent runtime.

Reconsider a separate repository only if autonomous runs acquire independent users,
ownership, release cadence, and funding, or if Labs dependencies materially obstruct
the mailbox's reliability and release process.

## Thirty-day validation

The next product phase is a 30-day, zero- or low-code validation. No new architecture is
scheduled. Code changes are limited to blockers that prevent a real pair from completing
the mailbox loop safely.

### Implementation note — 2026-09-04

The first two-machine trial exposed missed pickup as a real blocker: correspondence was
stored, but the receiving owner still had to tell their agent to check the mailbox. That
evidence reopened a narrow L2 experiment without reopening autonomous execution.

The experiment implements a forward-only, per-recipient durable event ledger with opaque
event IDs and replay cursors; it does not backfill correspondence created before the
ledger migration. A content-free SSE signal only tells a connected client to replay that
ledger. On the receiving machine, pickup requires an exact-sender `auto_pickup` grant and
a locally selected existing Codex thread binding. A foreground, owner-started watcher may
then queue a content-free attention message for that thread; it does not prove the TUI is
still live or start a closed host.

The watcher does not automatically read correspondence, invoke tools, begin work, accept
or complete a handoff, or send a reply. The Relay still proves durable storage only. The
current experiment does not yet prove recipient pickup or reply delivery, and it is not
full acceptance of issue #101.

### Days 1-3: define the test

- Recruit five real pairs, starting with same-team collaborators.
- Include at least one pair whose members are not both repository maintainers when the
  available pilot group permits it.
- Test three workflows: ask a concrete question, share useful context and receive an
  acknowledgement, and check an explicitly shared availability status.
- Record setup time, prompts, storage, pickup, reply time, usefulness, fallback channel,
  founder intervention, and repeat behavior.

### Days 4-10: complete real round trips

- Use the shipped mailbox without a new receiver runtime.
- Complete at least 20 real cross-machine threads rather than scripted demonstrations.
- Classify every failure as identity/onboarding, recipient discovery, composition,
  storage, notification, pickup, response, trust, or privacy.

### Days 11-17: measure repeat use

- Stop reminding participants after the first successful setup.
- Observe which pairs initiate another useful thread within seven days.
- Record when they prefer AgentRelay and when they return to Slack, email, or manual
  context copying.

### Days 18-23: simulate L2 before building it

- Use the existing notification path or a manual reminder to simulate fast pickup.
- Manually publish a short, owner-approved availability status.
- Build a watch or low-latency hint only if missed pickup is a dominant observed failure.

### Days 24-27: simulate L3 with the current lifecycle

- Use recipient acceptance, thread messages, and completion to test whether users need
  explicit commitment and status.
- Record demand for clarification, decline, expiry, and ETA without adding those states
  prematurely.

### Days 28-30: apply the decision gates

The initial thresholds are hypotheses and must be recorded before trial results are
interpreted:

- At least four of five pairs complete a real round trip.
- At least three pairs repeat without founder prompting within seven days.
- Median setup time is under 15 minutes.
- At least 90 percent of stored test messages remain retrievable.
- No committed test message is known to be lost, and no trial crosses an authorization,
  trust, credential, or provenance boundary.
- Participants identify at least one workflow where AgentRelay is preferable to copying
  context through an existing channel.
- Reports and documentation preserve the distinction among stored, notified, picked up,
  loaded, accepted, and answered.

Decision outcomes:

- If repeat use passes, continue improving L0-L1 reliability and onboarding.
- If missed pickup is the dominant failure, build the smallest L2 notification or watch
  path while preserving durable replay.
- If commitment ambiguity is common, refine L3 before considering execution.
- If fewer than two pairs repeat, stop feature work and reconsider the user or wedge.
- Do not unpark L4 merely because the code exists.

The product north-star metric is **successful cross-owner agent round trips per weekly
connected pair**. Mission count, model turns, agent count, and orchestration depth are
not product success metrics.

## Conditions for unparking autonomous execution

Mission development may resume only when all of the following are true:

1. At least three credible design partners explicitly request unattended, bounded
   execution rather than faster correspondence alone.
2. Those partners are willing to install and supervise a local service, configure an
   approved workspace and policy, and review execution evidence.
3. Mailbox trials show that local autonomous activation is a material bottleneck in a
   repeated workflow.
4. One narrow workflow, authority envelope, success metric, adversarial matrix, budget,
   and stop condition are written before implementation resumes.
5. The required runtime safety and data contracts have explicit owners, including
   artifact carriage, registered verification, capability enforcement, structured
   disposition, durable evidence, revocation, and recovery.
6. A guarded real-runtime integration proof can run before a broader two-machine demo.
7. A controlled comparison can determine whether autonomy improves the workflow or
   preserves a valuable ownership boundary at acceptable reliability, cost, and human
   intervention.

Parking would be wrong if a paying or otherwise credible partner already has this exact
need, if repeated mailbox use fails primarily because an owner-approved local runtime is
not activated, or if safe delegated execution is deliberately chosen as a separate
product with its own resources. Even then, L4 resumes as a bounded Labs experiment; it
does not redefine the communication network before its value gate passes.

## Non-goals

- A central manager LLM or general workflow engine.
- Multi-party swarms, parallel agents, or agent count as a quality claim.
- LLM-selected recipients, repositories, paths, commands, or permissions.
- A remote shell, inbound laptop port, or remote wake of a sleeping machine.
- Inferring local authority from contact consent, a message, or request acceptance.
- Automatic push, merge, package publication, deployment, or production credentials.
- Presence as covert process, repository, or user-activity monitoring.
- Building SSE, WebSocket, federation, multi-tenancy, mobile clients, or broad host
  support before a validated workflow needs them.
- Claiming A2A interoperability before a supported binding and conformance evidence
  exist.
- Deleting Mission history or weakening its existing security boundaries as part of the
  product reset.

## Consequences

### Positive

- The product can again be explained and tested through one concrete round trip.
- Existing mailbox users do not inherit the installation or trust burden of an
  autonomous runtime.
- Mission safety and recovery work is preserved without controlling near-term product
  priorities.
- Feature sequencing follows observed failure points instead of architectural
  completeness.

### Costs

- Some implemented Mission infrastructure will remain inactive while the mailbox is
  validated.
- The monorepo retains cognitive weight until documentation and package boundaries make
  the Labs lane obvious.
- If autonomous execution proves to be the immediate market wedge, the validation period
  delays it by up to 30 days.

### Risks and mitigations

- **Sunk-cost pressure:** preserve branches and tests, but require the unpark gates.
- **Labs bitrot:** keep builds, tests, and critical security maintenance running.
- **Mailbox commoditization:** measure repeat use and test a cross-owner or
  cross-organization wedge rather than assuming differentiation.
- **Presence overclaim:** use explicit TTL-bound fields and report `unknown` when the
  system lacks evidence.
- **Contract breakage during quarantine:** audit consumers before changing route or
  configuration defaults.

## Follow-up after validation

If the mailbox gates pass, update the main roadmap around the observed L0-L3 failure
points and create narrowly scoped issues. If they fail, record the result before choosing
a new wedge. If L4 qualifies for unpark, retain RFC 001 as its technical foundation and
write a fixed-budget experiment that references this RFC's authority separation and
stop conditions.
