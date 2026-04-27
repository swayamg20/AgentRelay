# AgentRelay

**Cross-developer agent-to-agent communication for engineering teams.**

[![npm version](https://img.shields.io/npm/v/agentrelay-mcp.svg)](https://www.npmjs.com/package/agentrelay-mcp)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![tests](https://img.shields.io/badge/tests-207%20passing-success.svg)](#testing)
[![protocol](https://img.shields.io/badge/protocol-A2A-blueviolet.svg)](https://a2a-protocol.org)

When Bob's coding agent finishes work, it can hand off context — file diffs,
API contracts, test commands, an open question — directly to Frank's coding
agent on another laptop. No copy-paste, no Slack threads, no lost context.
Built on the [Linux Foundation A2A protocol](https://a2a-protocol.org).
Works with [Claude Code](https://claude.com/code) and [OpenAI Codex CLI](https://github.com/openai/codex).

> 🎬 **Demo video coming soon** — recording the bidirectional clarification
> dance we used to verify v0.1.0 end-to-end.

---

## Why this exists

Today, when Bob refactors an API, he context-dumps it into Slack. Frank reads
the dump, copy-pastes it into his agent's prompt, and now Bob's untrusted text
is driving Frank's tool calls — the **worst possible trust model**. The handoff
loses fidelity, the receiver re-discovers context the sender already had, and
the round-trip is human-bounded.

Adjacent tools — [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams),
[OpenAI Agents SDK handoffs](https://openai.github.io/openai-agents-python/handoffs/),
[GitHub Copilot Coding Agent](https://github.blog/news-insights/product-news/github-copilot-coding-agent/),
[Cursor Background Agents](https://docs.cursor.com/background-agent),
[AgentMesh](https://arxiv.org/html/2507.19902v1) — solve *intra-process* or
*intra-org* coordination. **None of them solve peer-to-peer agent communication
between humans on different laptops.**

That gap is the entire reason AgentRelay exists.

## How it works

```
┌──────────────────┐                                    ┌──────────────────┐
│  Bob's laptop    │                                    │  Frank's laptop  │
│  Claude Code     │     handoff (file diff, q…)        │  Claude Code     │
│   ↓ MCP stdio    │  ─────────────────────────────►    │   ↑ MCP stdio    │
│  agentrelay-mcp  │                                    │  agentrelay-mcp  │
└────────┬─────────┘                                    └────────┬─────────┘
         │  HTTPS / A2A JSON-RPC                                 │
         └─────────────────────┬───────────────┬─────────────────┘
                               ▼               ▼
                       ┌──────────────────────────────┐
                       │   Relay (one per team)       │
                       │   Hono + Drizzle + Postgres  │
                       │   Audit log, block list,     │
                       │   notification dispatcher    │
                       └──────────────┬───────────────┘
                                      ▼
                                  Slack DM
```

Two halves: a tiny **MCP server** ([`agentrelay-mcp` on npm](https://www.npmjs.com/package/agentrelay-mcp))
that each developer runs locally, and a **relay service** that the team
self-hosts via Docker. Agents send structured handoffs through the relay;
recipients pull them with full provenance wrapping. Humans approve writes
through Claude Code's existing permission system.

## The trust model is load-bearing

Cross-machine agent communication only works if you can stop a malicious
(or prompt-injected) sender from running anything they want on the receiver.
AgentRelay does that with four mandatory layers:

| Layer | Mechanism | Where it runs |
|---|---|---|
| **L1** | Provenance wrapping. Every teammate text is wrapped with `[INBOUND HANDOFF FROM <handle> via AgentRelay]` before the agent sees it. Treats inbound as data, not commands. | MCP server |
| **L2** | Permission overlay. `agentrelay install` writes `allow`/`ask`/`deny` rules to your Claude Code or Codex settings. Reads = auto, tests = auto, writes = ask, `git push`/`npm publish`/`aws`/`kubectl` = deny. | Claude Code / Codex harness |
| **L3** | Per-teammate trust. `~/.agentrelay/trust.yaml` — explicitly opt in teammates with granular `auto_write_paths`, `require_approval`. Unknown senders rejected by default. | MCP server |
| **L4** | Audit + atomic revocation. Every state mutation logged. `agentrelay block <handle>` revokes a teammate instantly. | Relay + MCP CLI |

Skip a layer, the security guarantee evaporates. v0.1.0 wires all four; demo
video shows the L1 preamble surfacing live in both terminal sessions.

## Quick start

Requires Node 20+, pnpm 9+, Docker.

### Self-host the relay (once per team)

```bash
git clone https://github.com/swayamg20/AgentRelay
cd AgentRelay
pnpm install
docker compose up -d                                              # Postgres on :5433

# stable secrets — same values on every restart so API keys stay valid
export RELAY_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay
export RELAY_PEPPER=stable-dev-pepper-do-not-randomise-between-restarts
export RELAY_ENCRYPTION_KEY=stable-dev-encryption-key
export RELAY_ADMIN_TOKEN=stable-dev-admin-token
export RELAY_METRICS_TOKEN=stable-dev-metrics-token
export RELAY_PUBLIC_URL=http://localhost:8080
export RELAY_ENV=dev RELAY_PORT=8080

pnpm --filter relay db:migrate
pnpm --filter relay dev                                           # http://localhost:8080
```

### Per-developer setup

```bash
# register your identity (admin token from team lead)
npx agentrelay-mcp register \
  --relay http://localhost:8080 \
  --admin-token <admin-token-from-team-lead> \
  --handle bob@acme \
  --email bob@acme.com \
  --name "Bob" \
  --role backend

# wire into Claude Code AND/OR Codex (writes settings + permission overlay)
npx agentrelay-mcp install --client all

# verify
npx agentrelay-mcp doctor
```

Then in Claude Code or Codex CLI: *"Send a handoff to frank@acme telling him I refactored the /users API…"*

## What ships in v0.1.0

| Feature | Status |
|---|---|
| **7 MCP tools** — `handoff_to_teammate`, `check_inbox`, `accept_handoff`, `view_thread`, `send_message`, `complete_handoff`, `list_teammates` | ✅ |
| **`agentrelay` CLI** — `register`, `install`, `rotate-key`, `doctor`, `audit`, `block`, `trust` | ✅ |
| Both clients (Claude Code JSON + Codex TOML) wired by one `install` command | ✅ |
| A2A JSON-RPC surface — `message/send`, `tasks/get`, `tasks/list`, `tasks/update`, `tasks/cancel`, `agents/list` | ✅ |
| Idempotency replay, intent invariant (`inform` / `ask_question`), block enforcement, audit log | ✅ |
| Slack notification on inbox arrival (encrypted webhook URL at rest) | ✅ |
| Four-layer trust model, all layers wired and tested | ✅ |
| Live two-laptop demo, end-to-end clarification dance verified | ✅ |
| `intent: propose_action` (cross-codebase delegation) | ⏳ v0.1.5 |
| Live pair / synchronous channel | ⏳ v0.2 |
| Ambient agent / headless answer drafting | ⏳ v0.3 |

## Repository

```
.
├── docs/
│   ├── architecture.md   ← canonical reference + four-layer trust model
│   ├── hld.md            ← state machine, sequence diagrams
│   ├── lld.md            ← schemas, endpoints, error codes
│   ├── roadmap.md        ← phase-by-phase release plan
│   ├── auto-mode.md      ← v0.2 design: live pairing channel
│   └── ambient-agent.md  ← v0.3 design: headless drafting
├── relay/                ← Hono + Drizzle + Postgres relay (TypeScript)
├── mcp-server/           ← agentrelay-mcp on npm (TypeScript)
├── CLAUDE.md             ← contributor + agent-teammate rules
└── docker-compose.yml    ← local Postgres for development
```

## Stack

Node 22+ · TypeScript strict · pnpm workspaces · ESM-only · Hono · Drizzle ·
Postgres 16 · `@modelcontextprotocol/sdk` · zod · pino · vitest · Biome.

## Testing

207 tests across the workspace, all passing:

- **mcp-server:** 116 unit tests (mocked relay)
- **relay:** 30 unit + 61 integration (real Postgres via `docker-compose`)

```bash
pnpm -r test                                              # unit, no DB needed
RELAY_TEST_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay \
  pnpm --filter relay test:integration                    # full integration
```

## Roadmap

- **v0.1.0** — async mailbox + four-layer trust model. *Released, current.*
- **v0.1.5** — `intent: propose_action` (one agent asks another to draft a specific change)
- **v0.2.0** — live pair / synchronous channel
- **v0.3.0** — ambient agent (headless drafting on the receiver's box)
- **v1.0.0** — case study: real cross-stack feature shipped through the full chain

Full breakdown in [`docs/roadmap.md`](docs/roadmap.md).

## Contributing

Read [`CLAUDE.md`](CLAUDE.md) first — it documents the project conventions,
directory ownership, and the trust model invariants you must not break.

Issues, PRs, and feedback all welcome at
[github.com/swayamg20/AgentRelay/issues](https://github.com/swayamg20/AgentRelay/issues).

## Acknowledgments

Built on [A2A protocol](https://a2a-protocol.org) (Linux Foundation),
[Model Context Protocol](https://modelcontextprotocol.io),
[Claude Code](https://claude.com/code),
[OpenAI Codex CLI](https://github.com/openai/codex), and a lot of typing by
[Claude Opus 4.7](https://www.anthropic.com/claude).

## License

[MIT](LICENSE) © 2026 Swayam Gupta and AgentRelay contributors.
