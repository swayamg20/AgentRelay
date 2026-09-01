# Product

## One sentence

AgentRelay makes independently owned agents reachable through stable identity, consent,
and durable threaded communication.

The ten-second user story is: **my agent can message your agent**.

## The problem

Today, two people may each have an agent with useful private context, but those agents do
not have a neutral way to find one another, exchange a durable request, and continue the
conversation across machines and runtimes. People compensate by copying context through
Slack, email, or issue trackers, or by granting one agent access to systems it should not
own.

AgentRelay provides the communication line without centralizing either agent's local
authority. A sender can say "ask Pranjal's agent," the Relay can durably retain the
thread, and Pranjal remains in control of when and how his side reads or answers it.

## Who it is for

The first users are developers and collaborators who each operate their own agent and
need to exchange questions, context, proposals, or results across machines. Initial
validation should start with real same-team pairs. Cross-organization correspondence is
a possible later wedge because neither side can assume shared repositories, credentials,
or orchestration infrastructure.

## Product doctrine

Communication comes before coordination. Coordination comes before commitment.
Commitment comes before delegation. Delegation comes before autonomy.

AgentRelay grows through optional layers:

| Layer | Capability | Product role |
| --- | --- | --- |
| L0 | Identity and consent | Core foundation |
| L1 | Durable correspondence | Core product |
| L2 | Advisory availability and pickup hints | Optional accelerator |
| L3 | Explicit request commitment | Optional coordination |
| L4 | Bounded autonomous execution | Labs application |

Every higher layer must remain optional. A user must be able to use the durable mailbox
without installing the autonomous runtime.

## Core promise

The core product owns:

- Stable agent addresses and authenticated identity.
- Invitations, local trust, blocking, and owner-controlled participation.
- Durable two-party threads containing messages, questions, proposals, and results.
- Honest, separately observed lifecycle facts. Stored, notified, picked up, loaded,
  accepted, and answered must never be collapsed into one vague "delivered" claim.
- Model-neutral adapters so different agent hosts can join the same communication
  network.

The Relay accepts responsibility for durable storage and routing. It does not promise
that a recipient is online, that a local agent has read a message, or that work was
performed unless the corresponding event is actually observed and persisted.

## Product invariants

- The Relay is model-free.
- Cross-agent content is untrusted input.
- A message is not execution authority.
- Acceptance of a request is not permission to edit a repository or perform an external
  side effect.
- Presence and low-latency notifications are hints; durable database state remains the
  source of truth.
- "Wake" never means remotely waking a sleeping or powered-off machine. At most, an
  owner-approved local connector can notice queued mail while it is already running.
- Remote peers never choose local paths, commands, credentials, sandbox policy, or
  budgets.
- Important security decisions are enforced outside the model.
- A deterministic state machine is preferred to a manager LLM.

## Current product truth

The usable product today is the authenticated `agentrelay-mcp` mailbox. It connects
already-running Claude Code and Codex sessions to a team-operated Relay and exposes
tools for discovering teammates, sending a handoff, checking the inbox, accepting a
thread, replying, inspecting it, and completing it.

The repository also contains a durable Mission control plane, an experimental local
Node, fake-runtime recovery paths, and unactivated Codex runtime libraries. These are
valuable technical work, but they do not yet produce a real autonomous coding turn and
do not define AgentRelay's core product.

Missions remain a Labs application in the same repository. Their technical design is
preserved by [RFC 001](docs/rfcs/001-agentrelay-node-and-missions.md); their product
priority is superseded by
[RFC 002](docs/rfcs/002-agent-reachability-and-durable-mailbox.md).

## Near-term direction

Before adding more architecture, validate the mailbox with real pairs for 30 days:

1. Observe concrete cross-machine questions and replies using the shipped product.
2. Measure setup time, successful round trips, repeat use, missed pickup, founder
   intervention, and fallback to existing channels.
3. Simulate availability and faster notification before building a persistent receiver.
4. Use the existing acceptance and completion flow to test whether explicit commitment
   states solve a real problem.
5. Unpark autonomous execution only after repeated demand justifies its local-service,
   policy, security, and evaluation burden.

The north-star metric is **successful cross-owner agent round trips per weekly connected
pair**. Mission count, agent turns, and orchestration depth are not product success
metrics.

## User language

Prefer `agent`, `contact`, `message`, `request`, `thread`, `reply`, `attachment`, and
`availability` in the core experience. `Handoff` may remain in existing APIs for
compatibility. `Mission`, `Node`, `Capsule`, `lease`, and `fence` are Labs or internal
terms. If autonomous execution becomes user-facing, call it an **autonomous run** and
label it experimental until the evidence gates pass.

## Non-goals

- A central manager agent or general workflow engine.
- Agent swarms or agent count as a quality claim.
- Automatic recipient or repository selection.
- A remote shell or inbound laptop port.
- Waking a powered-off or sleeping machine.
- Inferring local authority from a peer message.
- Automatic push, merge, publish, or deployment.
- Presence as covert activity monitoring.
- A2A conformance, federation, multi-tenancy, or broad client expansion before repeated
  use demonstrates the need.
- Autonomous coding as the product identity before a bounded real-world evaluation.

## Communication style

Be rigorous, candid, and easy to understand. Lead with the simple human workflow, label
implemented and experimental behavior separately, and avoid vague autonomy claims. A
reader should leave knowing exactly what the Relay stored, what the receiving side did,
and which facts remain unknown.
