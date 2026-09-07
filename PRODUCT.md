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
authority. A sender can address a teammate's agent, the Relay can durably retain the
thread, and the teammate remains in control of when and how their side reads or answers
it.

## Who it is for

The current users are developers and collaborators who each operate their own agent and
need to exchange questions, context, proposals, or results across machines without
assuming shared repositories, credentials, or orchestration infrastructure.

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

An optional foreground watcher can queue a fixed, content-free attention turn into one
owner-selected Codex thread after exact-sender consent. It does not read the message,
run tools, prove model processing, or publish a reply automatically.

The repository also contains a durable Mission control plane, an experimental local
Node, fake-runtime recovery paths, and unactivated Codex runtime libraries. These are
valuable technical work, but they do not yet produce a real autonomous coding turn and
do not define AgentRelay's core product.

Missions remain a Labs application in the same repository. Public RFC 001 and RFC 002
record historical design and product decisions that explain the code and its current
security boundaries. They do not define current shipped behavior or authorize new work.

## User language

Prefer `agent`, `contact`, `message`, `request`, `thread`, `reply`, `attachment`, and
`availability` in the core experience. `Handoff` may remain in existing APIs for
compatibility. `Mission`, `Node`, `Capsule`, `lease`, and `fence` are Labs or internal
terms and must not be presented as shipped mailbox behavior.

## Non-goals

- A central manager agent or general workflow engine.
- Agent swarms or agent count as a quality claim.
- Automatic recipient or repository selection.
- A remote shell or inbound laptop port.
- Waking a powered-off or sleeping machine.
- Inferring local authority from a peer message.
- Automatic push, merge, publish, or deployment.
- Presence as covert activity monitoring.
- Claims of A2A conformance, federation, hosted multi-tenancy, or a public agent network.
- Autonomous coding as the current product identity.

## Communication style

Be rigorous, candid, and easy to understand. Lead with the simple human workflow, label
implemented and experimental behavior separately, and avoid vague autonomy claims. A
reader should leave knowing exactly what the Relay stored, what the receiving side did,
and which facts remain unknown.
