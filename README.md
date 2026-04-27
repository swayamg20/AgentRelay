# AgentRelay

Cross-developer agent-to-agent communication for engineering teams. Built on
the [A2A protocol](https://a2a-protocol.org). Works with Claude Code and
Codex CLI.

> **Status:** v0.1.0-rc1 — feature-complete release candidate. 142 tests
> pass; 61 integration tests run against local Postgres. See
> [`docs/roadmap.md`](docs/roadmap.md) for the phase plan.

## The problem

When Bob (backend) finishes an API change today, he context-dumps it into
Slack. Frank (frontend) reads Slack, copy-pastes the dump into his agent's
prompt, and now Bob's untrusted text drives Frank's tool calls — the worst
possible trust model. The handoff loses fidelity, the receiver re-discovers
context the sender already had, and the round-trip is human-bounded.

Every adjacent tool — Claude Code Agent Teams, OpenAI Agents SDK handoffs,
GitHub Copilot Agent, Cursor Background Agents, AgentMesh — solves
*intra-process* or *intra-org* coordination. None of them solve *peer-to-peer
agent communication between humans on different laptops*.

## The fix

Bob's coding agent packages a structured handoff (file diffs, API contract,
test commands, an open question) and sends it through the relay. Frank's
agent picks it up the next time he opens his CLI — provenance-wrapped, never
blended into the system prompt — drafts a plan, and may message back for
clarifications. Humans approve writes via Claude Code's existing permission
system. A four-layer trust model contains prompt injection.

Same protocol surface, two clients (Claude Code, Codex CLI), one MCP package
to install.

## What's in this repo

```
.
├── docs/                  ← canonical design — start here
│   ├── architecture.md    ← system + four-layer trust model
│   ├── hld.md             ← state machine, sequence diagrams
│   ├── lld.md             ← schemas, endpoints, error codes
│   ├── roadmap.md         ← phase-wise release plan
│   ├── auto-mode.md       (v0.2 — live pairing channel)
│   └── ambient-agent.md   (v0.3 — headless drafting)
├── relay/                 ← Hono + Drizzle + Postgres relay (TS)
├── mcp-server/            ← agentrelay-mcp — installed per laptop (TS)
├── CLAUDE.md              ← project rules for Claude Code teammates
└── docker-compose.yml     ← local Postgres for development
```

## Quick start

Requires Node 20+, pnpm 9+, Docker.

```bash
# install + start Postgres
pnpm install
cp .env.example .env
docker compose up -d                                              # Postgres on :5433

# apply schema
RELAY_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay \
  pnpm --filter relay db:migrate

# run the full test suite (unit + integration)
RELAY_TEST_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay \
  pnpm -r test

# start the relay
pnpm --filter relay dev                                           # http://localhost:8080
```

Then on each developer's laptop:

```bash
# install the MCP package
npx agentrelay-mcp register \
  --relay http://localhost:8080 \
  --admin-token $RELAY_ADMIN_TOKEN \
  --handle bob@acme \
  --email bob@acme.com \
  --name Bob \
  --role backend

# wire it into Claude Code AND/OR Codex (writes settings.json + permission overlay)
npx agentrelay-mcp install --client all

# verify
npx agentrelay-mcp doctor
```

## What ships in v0.1

| Surface | Status |
|---|---|
| Six MCP tools (`handoff_to_teammate`, `check_inbox`, `accept_handoff`, `send_message`, `complete_handoff`, `list_teammates`) | ✓ |
| `agentrelay` CLI (`register`, `install`, `rotate-key`, `doctor`, `audit`, `block`, `trust`) | ✓ |
| Both clients (Claude Code JSON + Codex TOML) wired by `install` | ✓ |
| A2A JSON-RPC protocol surface (`message/send`, `tasks/get`, `tasks/list`, `tasks/update`, `tasks/cancel`) | ✓ |
| Idempotency replay, intent invariant, block enforcement, audit log | ✓ |
| Slack notification on inbox arrival | ✓ |
| Four-layer trust model (provenance, permission overlay, `trust.yaml`, audit + block) | ✓ |
| Live two-laptop demo, 5-minute onboarding, A2A TCK conformance, k6 load test | ⏳ v0.1.1 |

## Design at a glance

- **Protocol:** Linux Foundation A2A, JSON-RPC over HTTPS. Hand-rolled
  client until `a2a-js` lands on npm.
- **Distribution:** OSS (MIT). Self-host the relay (`docker compose`),
  install the MCP package on each developer's laptop.
- **Trust:** four layers, defaults conservative. Reads = auto;
  test runs = auto; writes = human approves; external effects (push,
  publish, deploy) = denied at the harness level. See
  [`docs/architecture.md` §5](docs/architecture.md).
- **Releases:** v0.1 async mailbox → v0.1.5 propose-action →
  v0.2 auto mode → v0.3 ambient agent → v1.0 case study. See
  [`docs/roadmap.md`](docs/roadmap.md).

## Stack

Node 22+ · TypeScript strict · pnpm workspaces · ESM-only · Hono · Drizzle ·
Postgres 16 · `@modelcontextprotocol/sdk` · zod · pino · vitest · Biome.

## Contributing

Read `CLAUDE.md` first — it documents the project conventions, directory
ownership, and the trust model invariants you must not break.

## License

[MIT](LICENSE) © 2026 Swayam Gupta and AgentRelay contributors.
