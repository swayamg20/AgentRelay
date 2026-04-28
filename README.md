# AgentRelay

**Cross-developer agent-to-agent communication for engineering teams.**

[![npm version](https://img.shields.io/npm/v/agentrelay-mcp.svg)](https://www.npmjs.com/package/agentrelay-mcp)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
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

Adjacent tools all solve some part of agent coordination, but none solve
**peer-to-peer agent communication between humans on different laptops**:

| Tool | Coordination scope | Cross-machine | Cross-developer | Trust model |
|---|---|:---:|:---:|---|
| [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams) | Subagents in one developer's session | ❌ | ❌ | Implicit (single human) |
| [OpenAI Agents SDK handoffs](https://openai.github.io/openai-agents-python/handoffs/) | Agent → agent in one runtime | ❌ | ❌ | Implicit |
| [GitHub Copilot Coding Agent](https://github.blog/news-insights/product-news/github-copilot-coding-agent/) | Developer ↔ Copilot bot in cloud | ✅ | ❌ | Code review gate |
| [Cursor Background Agents](https://docs.cursor.com/background-agent) | One developer's async tasks | ✅ | ❌ | Implicit |
| [AgentMesh](https://arxiv.org/html/2507.19902v1) | Research framework, not deployable | — | — | — |
| **AgentRelay** | **Peer-to-peer between humans on different laptops** | **✅** | **✅** | **Four explicit layers** |

That last column is the load-bearing one — the rest of this README is about
why those four layers are the only thing that makes cross-machine agent
communication safe.

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

## The trust model

Cross-machine agent communication only works if you can stop a malicious (or
prompt-injected) sender from running anything they want on the receiver.
AgentRelay does that with four mandatory layers:

| Layer | Mechanism | Where it runs |
|---|---|---|
| **L1** | Provenance wrapping. Every teammate text is wrapped with `[INBOUND HANDOFF FROM <handle> via AgentRelay]` before the agent sees it. Treats inbound as data, not commands. | MCP server |
| **L2** | Permission overlay. `agentrelay install` writes `allow`/`ask`/`deny` rules to your Claude Code or Codex settings. Reads = auto, tests = auto, writes = ask, `git push`/`npm publish`/`aws`/`kubectl` = deny. | Claude Code / Codex harness |
| **L3** | Per-teammate trust. `~/.agentrelay/trust.yaml` — explicitly opt in teammates with granular `auto_write_paths`, `require_approval`. Unknown senders rejected by default. | MCP server |
| **L4** | Audit + atomic revocation. Every state mutation logged. `agentrelay block <handle>` revokes a teammate instantly. | Relay + MCP CLI |

Skip a layer, the security guarantee evaporates. v0.1.0 wires all four; the
demo video shows the L1 preamble surfacing live in both terminal sessions.

## Quick start

### Self-host the relay (once per team) — Docker only

Just Docker. No Node, no pnpm, no build step. Postgres + relay come up
together; migrations run on boot.

```bash
git clone https://github.com/swayamg20/AgentRelay
cd AgentRelay
cp .env.example .env

# Edit .env — at minimum, regenerate the secrets before exposing publicly:
#   sed -i '' "s|^RELAY_PEPPER=.*|RELAY_PEPPER=$(openssl rand -hex 32)|" .env
#   sed -i '' "s|^RELAY_ADMIN_TOKEN=.*|RELAY_ADMIN_TOKEN=$(openssl rand -hex 16)|" .env

docker compose --profile selfhost up -d                           # postgres + relay
curl http://localhost:8080/healthz                                # → {"status":"ok"}
```

That's the whole self-host setup. Behind the curtain:

- Postgres on `:5433` (container `agentrelay-postgres`)
- Relay on `:8080` (container `agentrelay-relay`, built from `relay/Dockerfile`)
- Migrations applied on relay boot (idempotent)
- Both restart `unless-stopped`

To put it on a real server, point your reverse proxy (nginx / caddy /
cloudflared) at `:8080`, set `RELAY_PUBLIC_URL` to the public URL, and
you're done.

### Per-developer setup

Full step-by-step (with troubleshooting) lives in
[`docs/onboarding.md`](docs/onboarding.md). The short version:

```bash
# Register your identity (admin token comes from your team lead).
# Note: use the `agentrelay` CLI bin, not `agentrelay-mcp` (the MCP server).
npx -y -p agentrelay-mcp agentrelay register \
  --relay https://your-team-relay.example.com \
  --admin-token <admin-token-from-team-lead> \
  --handle bob@acme \
  --email bob@acme.com \
  --name "Bob" \
  --role backend

# Wire AgentRelay into Claude Code (user scope = works in every directory)
claude mcp add agentrelay --scope user -- npx -y agentrelay-mcp

# Add the recommended permission overlay (allow reads/tests, ask before writes,
# deny git push / npm publish / curl / aws / kubectl)
npx -y -p agentrelay-mcp agentrelay install --client all

# Verify
npx -y -p agentrelay-mcp agentrelay doctor
```

Then in Claude Code or Codex CLI: *"Send a handoff to frank@acme telling him I refactored the /users API…"*

> v0.1.x onboarding has known sharp edges (tracked in [v0.1.2](https://github.com/swayamg20/AgentRelay/milestone/1)).
> v0.2.0 collapses the whole flow to one command: `agentrelay join <invite-url>`
> ([#6](https://github.com/swayamg20/AgentRelay/issues/6)).

## What ships in v0.1.0

| Surface | Status |
|---|:---:|
| 7 MCP tools — `handoff_to_teammate`, `check_inbox`, `accept_handoff`, `view_thread`, `send_message`, `complete_handoff`, `list_teammates` | ✅ |
| `agentrelay` CLI — `register`, `install`, `rotate-key`, `doctor`, `audit`, `block`, `trust` | ✅ |
| Both clients (Claude Code JSON + Codex TOML) wired by one `install` command | ✅ |
| A2A JSON-RPC surface — `message/send`, `tasks/get`, `tasks/list`, `tasks/update`, `tasks/cancel`, `agents/list` | ✅ |
| Idempotency replay, intent invariant (`inform` / `ask_question`), block enforcement, audit log | ✅ |
| Slack notification on inbox arrival (encrypted webhook URL at rest) | ✅ |
| Four-layer trust model, all layers wired and demonstrated end-to-end | ✅ |

## Repository

```
.
├── docs/
│   ├── architecture.md   ← canonical reference + four-layer trust model
│   ├── hld.md            ← state machine, sequence diagrams
│   ├── lld.md            ← schemas, endpoints, error codes
│   ├── onboarding.md     ← team setup walkthrough + troubleshooting
│   ├── next-steps.md     ← living planning index, linked to GH issues
│   ├── roadmap.md        ← phase-by-phase release plan
│   ├── auto-mode.md      ← v0.2 design: live pairing channel
│   └── ambient-agent.md  ← v0.3 design: headless drafting
├── relay/                ← Hono + Drizzle + Postgres relay (TypeScript)
├── mcp-server/           ← agentrelay-mcp on npm (TypeScript)
├── CLAUDE.md             ← contributor + agent-teammate rules
├── CONTRIBUTING.md       ← how to set up, conventions, PR process
└── docker-compose.yml    ← local Postgres for development
```

## Stack

Node 22+ · TypeScript strict · pnpm workspaces · ESM-only · Hono · Drizzle ·
Postgres 16 · `@modelcontextprotocol/sdk` · zod · pino · vitest · Biome.

## Contributing

We welcome issues, PRs, and feedback. See [`CONTRIBUTING.md`](CONTRIBUTING.md)
for development setup, code conventions, the testing workflow, and the trust
model invariants you must not break. [`CLAUDE.md`](CLAUDE.md) documents the
project rules in agent-teammate-readable form (handy if you bring Claude Code
or Codex along to help).

## Acknowledgments

Built on [A2A protocol](https://a2a-protocol.org) (Linux Foundation),
[Model Context Protocol](https://modelcontextprotocol.io),
[Claude Code](https://claude.com/code),
[OpenAI Codex CLI](https://github.com/openai/codex), and a lot of typing by
[Claude Opus 4.7](https://www.anthropic.com/claude).

## License

[MIT](LICENSE) © 2026 Swayam Gupta and AgentRelay contributors.
