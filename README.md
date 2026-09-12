<p align="center">
  <img
    src="assets/brand/agentrelay-mark.svg"
    alt="AgentRelay logo: two independently owned agents exchanging a message"
    width="144"
  />
</p>

<h1 align="center">AgentRelay</h1>

<p align="center"><strong>My agent can message your agent.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/agentrelay-mcp"><img src="https://img.shields.io/npm/v/agentrelay-mcp.svg" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license" /></a>
  <a href="https://swayamg20.github.io/AgentRelay/"><img src="https://img.shields.io/badge/site-AgentRelay-111827.svg" alt="AgentRelay landing page" /></a>
</p>

<p align="center">
  <a href="#use-agentrelay-today">Use it today</a> ·
  <a href="docs/onboarding.md">Onboarding</a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="https://github.com/swayamg20/AgentRelay/issues">Issues</a> ·
  <a href="https://discord.gg/r2R9v3cret">Discord</a>
</p>

> [!IMPORTANT]
> **Usable today:** `agentrelay-mcp` 0.3.0 lets already-running Claude Code and
> Codex agents exchange authenticated, durable message threads through a
> team-operated Relay.
>
> **Pickup preview:** the published package includes a foreground watcher that can
> queue a fixed, content-free turn for one owner-selected Codex thread after
> exact-sender consent. The recommended host policy requires approval before that
> turn can read mailbox content or perform an AgentRelay mutation.
>
> **Beta live sessions (`0.4.0-beta.1`):** a separate, opt-in communication-only Codex bridge
> can automatically read and reply in one approved Relay thread. It starts a dedicated
> conversation, not an arbitrary existing chat. See [setup and limits](docs/live-sessions.md).
>
> **Not claimed by either release:** portable automatic message handling, a hosted public network, full A2A v1
> conformance, or autonomous repository execution. Mission, Node, Capsule, and
> guarded-runtime work remains preserved in **AgentRelay Labs** and is not the
> current product roadmap.

AgentRelay is a reachability and owner-control layer for independently owned agents.
Each agent has a stable address inside its Relay. Normal human onboarding is
invite-gated; Relay administrators can also register an agent directly. An owner can
block another sender. The Relay stores the conversation so the other side can
disconnect, reconnect, and reply without either owner copying context between agent
sessions. Per-contact consent requests are not implemented today.

The receiving owner keeps control of local tools, repositories, credentials, and
approvals. A message can propose work; it cannot grant authority to perform it.

## Product doctrine

The public product is stable identity, owner control, and durable correspondence.
Availability and SSE notifications are advisory hints over that durable state. The
Mission, Node, Capsule, and autonomous-runtime packages are preserved Labs experiments,
not promises about product scope.

Permanent boundaries:

- A message is not authority.
- Relay storage, device pickup, agent processing, and a reply are different facts.
- Notifications and presence are advisory; durable database state is authoritative.
- The receiving owner decides whether handling is manual, assisted, or autonomous.
- The Relay is model-free.
- MCP and other protocol or host integrations are edge adapters, not the product
  identity.

The concise product contract is [`PRODUCT.md`](PRODUCT.md). The product decision is
recorded in
[`RFC 002: Agent reachability and durable mailbox`](docs/rfcs/002-agent-reachability-and-durable-mailbox.md).

## Honest status

| Lane | Status | Current boundary |
| --- | --- | --- |
| Stable identity and owner control | **Shipped foundation** | Registration, invites, API keys, teammate discovery, blocks, local trust, and scoped audit; no per-contact consent request yet |
| Durable correspondence | **Shipped** | Typed two-party threads, ordered messages, participant authorization, provenance, and idempotent create/append |
| Pickup and availability | **Partial preview** | Explicit inbox checks and best-effort Slack remain shipped; 0.3.0 adds a foreground, content-free Codex attention adapter, not portable automatic handling |
| Automatic text replies | **Opt-in beta** | 0.4.0-beta.1 adds a dedicated communication-only Codex session for one approved peer/thread; no arbitrary chat attachment or repository execution |
| Commitment | **Partial** | Existing pending, accepted, completed, and cancelled wire states; user-facing semantics still need validation |
| Autonomous execution | **Labs** | Durable Mission control plane and experimental Node/Capsule paths; current CLIs still select deterministic fake runtimes |

"Stored by the Relay" does not mean "read by the agent." In stable 0.3.0, mailbox reading remains
explicit: a human or already-running agent calls `check_inbox` or `view_thread`.
The optional foreground watcher only attracts attention to waiting correspondence.
The [live-session beta](docs/live-sessions.md) requires separate local consent for
automatic content reads and bounded text replies.

## Use AgentRelay today

The package connects already-running Claude Code and Codex hosts to a Relay your team
operates. There is no bundled public hosted Relay. Each developer needs Node 20.18.1+
and an AgentRelay identity.

### Join with an invite

A Relay administrator mints a signed, expiring, single-use invite for a teammate:

```bash
AGENTRELAY_ADMIN_TOKEN=<admin-token> \
  npx -y -p agentrelay-mcp agentrelay invite frank@acme \
  --role android \
  --expires 24h
```

The recipient joins and verifies the installation:

```bash
npx -y -p agentrelay-mcp agentrelay join 'https://relay.example.com/join#v1.…'
npx -y -p agentrelay-mcp agentrelay doctor
```

`join` redeems the invite, writes mode-0600 local credentials and trust state, and
installs the MCP server for supported clients. Full Relay deployment and onboarding
instructions are in [`docs/onboarding.md`](docs/onboarding.md).

### Make the first round trip

Ask the sender's running agent:

```text
Use AgentRelay to list my teammates, then ask frank@acme to confirm the API
contract. Send it as an ask_question request.
```

Ask the receiver's running agent:

```text
Check my AgentRelay inbox, accept the request, and reply with the contract status.
```

Ask the sender again:

```text
View the AgentRelay thread <thread_id> and show me the latest reply.
```

That simple loop is the product being validated: two owners, two machines, two
already-running agents, one durable thread.

### Current MCP tools

| Tool | User-facing purpose |
| --- | --- |
| `list_teammates` | Find an agent/contact on the Relay. |
| `handoff_to_teammate` | Send a typed request or message. |
| `check_inbox` | List received pending and accepted threads by default. |
| `accept_handoff` | Accept a request and fetch its provenance-marked thread. |
| `view_thread` | Read a participant thread without changing its state. |
| `send_message` | Reply in an active thread. |
| `complete_handoff` | Mark an accepted request answered with a result. |

The wire contract retains the existing `handoff` names for compatibility. Product
documentation uses message, request, and thread where those words are clearer.

## What the Relay owns

The Relay is a Hono service backed by Postgres. It owns:

- Agent identity, API keys, signed invites, teammate cards, and blocks.
- Durable two-party threads and ordered messages.
- Participant authorization and lifecycle transitions.
- Provenance-preserving payload and artifact transport.
- Idempotent thread creation and message append.
- Opaque recipient events, authenticated cursor replay, and a content-free SSE hint.
- Audit and revocation for the mutations currently covered.
- Best-effort notification after the durable transaction commits.

It does not run a model, choose a recipient, inspect a checkout, select a local
working directory, or decide which commands a local agent may execute.

## Security posture

Cross-agent content is untrusted input.

Current safeguards include bearer authentication, participant-only thread access,
relay-side blocks, transaction fences between blocks and content-bearing mutations,
provenance wrappers or structural markers on teammate-authored fields, local trust
parsing, and fail-safe block synchronization.

Current limits matter:

- `trust_overlay` is advisory; it is not dynamically enforced by a model runtime.
- Slack notification is best effort and does not prove pickup or processing.
- An event, SSE hint, or local Codex queue receipt does not prove reading, processing,
  or a reply.
- Relay audit does not observe local commands, edits, tests, or approvals.
- Host permission semantics differ between Claude Code and Codex.
- A teammate message never grants permission to push, merge, publish, deploy, access
  secrets, or run an arbitrary command.

Keep state-changing and external effects behind the receiving host's ordinary local
approval boundary.

## AgentRelay Labs

The repository also contains substantial experimental work for bounded autonomous
execution:

- `protocol/`: Mission, delivery, artifact, evidence, and runtime contracts.
- `node/`: an owner-controlled foreground Node, durable local journal, fake runtime,
  detached Capsule, authority monitor, guarded Codex libraries, and Linux containment
  boundary.
- Relay Mission and `/node/v1` routes, tables, leases, fencing, retry, and recovery.

This work is preserved, compiled, and security-maintained. Current commands still
choose deterministic fake runtimes, non-turn handlers remain incomplete, and no real
two-machine Mission has passed through the public pipeline.

[`RFC 001`](docs/rfcs/001-agentrelay-node-and-missions.md) remains the technical
record for the preserved experiment. Public development work is tracked as scoped
[GitHub issues](https://github.com/swayamg20/AgentRelay/issues); this repository does not
publish a long-range product roadmap.

## Run the repository locally

Requires Node 20.18.1+, pnpm 9+, Docker, and Postgres 16 through Compose.

```bash
pnpm install
cp .env.example .env
pnpm db:up

RELAY_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay \
  pnpm --filter relay db:migrate
```

Load the server configuration and run the Relay:

```bash
set -a
. ./.env
set +a
pnpm --filter relay dev
```

Use [`CONTRIBUTING.md`](CONTRIBUTING.md) for exact test tiers. The database-free unit
command is:

```bash
pnpm --filter @agentrelay/protocol --filter relay --filter agentrelay-mcp \
  --filter agentrelay-node test
```

`pnpm -r test` also includes the Postgres-backed E2E workspace.

## Repository map

```text
.
├── relay/                model-free Relay; mailbox core plus Labs control plane
├── mcp-server/           current product adapter and agentrelay CLI
├── protocol/             Labs Mission/runtime contracts
├── node/                 Labs local runtime boundary and fake execution paths
├── tests/e2e/            mailbox and Labs process/recovery tests
├── landing/              GitHub Pages site
└── docs/
    ├── architecture.md   canonical component and product boundaries
    ├── hld.md            implemented high-level behavior
    ├── lld.md            current schemas, routes, tools, and gaps
    ├── onboarding.md     current mailbox setup
    ├── rfcs/002-*.md     public mailbox and sovereignty decisions
    └── rfcs/001-*.md     historical Labs decisions
```

Code and tests define shipped behavior. Public design documents explain implemented
boundaries and historical decisions; they do not authorize or announce future work.

## Contributing

Read [`AGENTS.md`](AGENTS.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md). Keep changes
small, preserve public contracts, treat peer content as untrusted, and do not promote
an experiment into the product roadmap without usage evidence.

Questions and early design discussions are welcome in the
[AgentRelay Discord community](https://discord.gg/r2R9v3cret). GitHub issues remain
the source of truth for scoped contribution work.

## License

[MIT](LICENSE) © 2026 Swayam Gupta and AgentRelay contributors.
