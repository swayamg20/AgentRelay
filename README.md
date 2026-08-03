# AgentRelay

**A durable collaboration network for independently owned AI agents on different
machines, repositories, and runtimes.**

[![npm version](https://img.shields.io/npm/v/agentrelay-mcp.svg)](https://www.npmjs.com/package/agentrelay-mcp)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![landing page](https://img.shields.io/badge/site-AgentRelay-111827.svg)](https://swayamg20.github.io/AgentRelay/)

A backend developer's agent understands the backend repository. An Android
developer's agent understands the client repository. AgentRelay is intended to let
those agents negotiate a shared contract, ask each other questions, implement their
local work, and exchange test evidence without either owner copying context through
Slack or giving one central agent access to both private repositories.

The long-term product is the network and local runtime bridge. Coding across two
repositories is the first proof, not the final product boundary.

## Honest status

The repository currently ships an **authenticated asynchronous mailbox**, not the
full autonomous runtime described above.

### Implemented today

- Postgres-backed identities, API keys, signed invite URLs, blocks, handoffs, and
  messages, with audit records for invite, handoff/message, and block mutations.
- A Hono relay with REST onboarding and an A2A-shaped JSON-RPC mailbox surface.
- Seven stdio MCP tools for Claude Code and Codex.
- Typed engineering artifacts, preserved message/completion payloads, and provenance
  markers on teammate-authored inbox, thread, payload, proposal, and artifact data.
- An executable `@agentrelay/protocol` workspace with bounded Mission contracts,
  strict lifecycle and coordinator reducers, a deterministic fake runtime adapter,
  and a reproducible backend-Android transcript fixture.
- CLI setup, invite/join, install, doctor/fix, key rotation, audit, relay-synchronized
  block/unblock, and local trust management.
- An in-process Slack dispatcher with encrypted-at-rest webhook configuration.

### Next architecture, not shipped yet

- A persistent AgentRelay Node on every participating machine.
- Durable delivery events, replay cursors, claims, acknowledgements, and duplicate
  suppression.
- Device and workspace identities, isolated worktrees, and runtime sessions.
- Local policy enforcement outside the model.
- Bounded, versioned Missions with acceptance criteria and executable verification.
- Codex and Claude runtime adapters that start or resume real agent turns.

The design is in
[`RFC 001: AgentRelay Node and Missions`](docs/rfcs/001-agentrelay-node-and-missions.md).
The implementation sequence and stop/go gates are in
[`docs/roadmap.md`](docs/roadmap.md).

## The product shape

```text
Machine A                                              Machine B

Backend repository                                     Android repository
       |                                                       |
coding-agent runtime                                   coding-agent runtime
       |                                                       |
AgentRelay Node A  <---------- AgentRelay relay --------> AgentRelay Node B
                     durable, model-free coordination
```

- The **relay** owns identity, Mission truth, ordered messages, store-and-forward
  delivery, claims, acknowledgements, audit, and revocation.
- The **Node** owns local repository mappings, worktrees, runtime lifecycle, policy,
  budgets, and execution evidence.
- **MCP** exposes local AgentRelay tools to an already-running model host.
- **A2A** supplies public agent/task/message/artifact semantics at the network edge.
- **SSE** can signal new work, but durable database replay is the source of truth.

The relay does not run a manager model. Agents remain specialists in repositories
their owners control; a deterministic coordinator handles delivery, budgets,
termination, and verification.

## First proof

One human creates a bounded Mission for a backend feature and its Android client:

1. Both owners approve a repository binding, base commit, allowed paths and commands,
   denied external effects, and turn/time/token budget.
2. Both agents acknowledge the same objective and acceptance-contract revision.
3. Each Node validates an owner-prepared clean checkout or isolated worktree and
   starts a dedicated runtime session.
4. Agents exchange typed questions, answers, proposals, decisions, contracts,
   artifacts, progress, and verification evidence.
5. The coordinator completes only after both agents report ready and deterministic
   backend, Android, contract, and user-scenario checks pass.
6. Humans return for final review.

For the first slice, "done autonomously" means review-ready participant workspaces with a
replayable trace. Push, merge, publish, deploy, secrets, arbitrary network access,
and production credentials remain denied.

## Use the current mailbox

The published `agentrelay-mcp` package provides the current manual handoff flow. A
team needs a configured relay and each developer needs Node 20+ plus Claude Code or
Codex. Package-specific details live in
[`mcp-server/README.md`](mcp-server/README.md).

### Join with an invite

A registered team member with the relay admin token mints a single-use URL:

```bash
AGENTRELAY_ADMIN_TOKEN=<admin-token> \
  npx -y -p agentrelay-mcp agentrelay invite frank@acme \
  --role android \
  --expires 24h
```

The recipient runs:

```bash
npx -y -p agentrelay-mcp agentrelay join 'https://relay.example.com/join#v1.…'
npx -y -p agentrelay-mcp agentrelay doctor
```

`join` redeems the invite, writes mode-0600 local credentials and trust files, and
installs AgentRelay for supported clients.

### Manual registration

For CI or administrator-controlled onboarding:

```bash
npx -y -p agentrelay-mcp agentrelay register \
  --relay https://relay.example.com \
  --admin-token <admin-token> \
  --handle bob@acme \
  --email bob@acme.com \
  --name "Bob" \
  --role backend

npx -y -p agentrelay-mcp agentrelay install --client all
npx -y -p agentrelay-mcp agentrelay doctor --fix
```

Then ask the host agent to list teammates, send a handoff, or check the inbox. The
seven current tools are:

- `handoff_to_teammate`
- `check_inbox`
- `accept_handoff`
- `view_thread`
- `send_message`
- `complete_handoff`
- `list_teammates`

Full setup and current limitations are in [`docs/onboarding.md`](docs/onboarding.md).

## Run the repository locally

Requires Node 20+, pnpm 9+, Docker, and Postgres 16 through Compose.

```bash
pnpm install
cp .env.example .env
pnpm db:up

RELAY_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay \
  pnpm --filter relay db:migrate
```

Load the server values from `.env` into your shell, then run:

```bash
set -a
. ./.env
set +a
pnpm --filter relay dev
```

Use [`CONTRIBUTING.md`](CONTRIBUTING.md) for exact test tiers. The database-free CI
unit command is:

```bash
pnpm --filter @agentrelay/protocol --filter relay --filter agentrelay-mcp test
```

`pnpm -r test` also includes the Postgres-backed E2E workspace.

## Security posture

Cross-agent messages and artifacts are untrusted input. Current safeguards include
bearer authentication, participant authorization, block checks on new and existing
handoff messages and content-bearing transitions, a shared transaction lock that makes
a successful block response a commit fence for those mutations, audit for
invite/handoff/message/block mutations, provenance
wrappers or markers on every teammate-originated mailbox field returned by MCP,
recommended host settings, and local trust parsing.

They are not yet a complete autonomous security boundary:

- The returned `trust_overlay` is advisory; no runtime consumer applies it
  dynamically.
- Relay audit omits several relay mutations and all local commands, edits, tests, and
  permission decisions.
- Notification pickup is best effort and does not acknowledge model processing.
- Successful CLI block/unblock updates both relay and local state, but those two writes
  are not one atomic transaction across the network and filesystem.
- Block is local-first and unblock is relay-first; a reported partial failure keeps
  local denial active and can be repaired by retrying the command.

The future Node must enforce the effective repository, command, network, budget, and
revocation policy outside the model. See [`docs/architecture.md`](docs/architecture.md)
for the boundary and the RFC for the acceptance tests.

## Protocol position

AgentRelay does not need to invent a replacement for A2A or MCP:

- [A2A](https://a2a-protocol.org/) is the public agent collaboration plane.
- [MCP](https://modelcontextprotocol.io/) is the local host/tool boundary.
- AgentRelay adds durable cross-device delivery and host-specific local activation.

The current relay uses custom A2A-shaped JSON-RPC methods. It does not yet expose a
current well-known Agent Card route or carry a current compatibility-suite result, so
this README does not claim full A2A conformance.

## Repository map

```text
.
├── AGENTS.md             coding-agent instructions: understand first, keep code clear
├── CLAUDE.md             Claude-specific entry point; delegates to AGENTS.md
├── protocol/             Mission schemas, coordinator, fixtures, and adapter contract
├── relay/                current Hono + Drizzle + Postgres relay
├── mcp-server/           current MCP server and agentrelay CLI
├── tests/e2e/            relay + two-MCP-process test harness
├── landing/              GitHub Pages landing page
└── docs/
    ├── architecture.md   current truth and target boundaries
    ├── hld.md            current mailbox high-level design
    ├── lld.md            current routes, tables, tools, and gaps
    ├── roadmap.md        evidence-gated implementation order
    ├── next-steps.md     near-term engineering queue
    ├── onboarding.md     current mailbox setup
    ├── hosting.md        relay hosting survey
    ├── deploy-fly.md     relay-only Fly.io example
    ├── auto-mode.md      superseded design decision record
    ├── ambient-agent.md  superseded design decision record
    └── rfcs/
        └── 001-agentrelay-node-and-missions.md
```

## Documentation rules

- Code and tests define what is shipped.
- [`docs/architecture.md`](docs/architecture.md) defines the current/target boundary.
- Accepted RFCs define intended behavior until code lands.
- Docs must label target behavior instead of presenting it as implemented.

## Contributing

Read [`AGENTS.md`](AGENTS.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md). The core rule is
simple: understand the complete contract before editing, write the smallest clear
solution, preserve security and public boundaries, and do not add speculative bloat.

## License

[MIT](LICENSE) © 2026 Swayam Gupta and AgentRelay contributors.
