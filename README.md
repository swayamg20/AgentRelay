# AgentRelay

Cross-developer agent-to-agent communication for engineering teams. Built on
the [A2A protocol](https://a2a-protocol.org). Works with Claude Code and
Codex CLI.

> **Status:** pre-v0.1, in active development. Not yet runnable end-to-end.
> See [`docs/roadmap.md`](docs/roadmap.md) for the phase plan.

## What it does

When Bob's coding agent finishes a task, it can hand off context — file diffs,
API contracts, test commands, an open question — to Frank's coding agent on
another laptop. Frank's agent picks up the handoff next time he opens his CLI,
drafts a plan, and may message back with clarifying questions. Humans
approve writes via Claude Code's existing permission system. The four-layer
trust model keeps prompt injection contained.

## Repository

```
.
├── docs/                 ← canonical design docs (start here)
│   ├── architecture.md
│   ├── hld.md
│   ├── lld.md
│   ├── roadmap.md
│   ├── auto-mode.md      (v0.2 design)
│   └── ambient-agent.md  (v0.3 design)
├── relay/                ← Hono + Drizzle + Postgres relay (TS)
├── mcp-server/           ← MCP server installed on each developer laptop (TS)
└── docker-compose.yml    ← local Postgres for development
```

## Quick start (dev)

Requires Node 20+, pnpm 9+, Docker.

```bash
pnpm install
cp .env.example .env
docker compose up -d                  # local Postgres on :5433
pnpm --filter relay db:migrate        # apply schema
pnpm --filter relay dev               # relay on :8080
pnpm --filter mcp-server build        # build MCP server
```

## Design at a glance

- **Protocol:** Linux Foundation A2A (Agent2Agent), JSON-RPC over HTTPS
- **Trust:** four layers — provenance wrapping, Claude Code permission overlay, per-teammate `trust.yaml`, audit + revocation. See [`docs/architecture.md` §5](docs/architecture.md).
- **Releases:** v0.1 async mailbox → v0.1.5 propose-action → v0.2 auto mode → v0.3 ambient agent → v1.0 case study. See [`docs/roadmap.md`](docs/roadmap.md).

## License

[MIT](LICENSE) © 2026 Swayam Gupta and AgentRelay contributors.
