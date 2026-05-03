# AgentRelay

**Your coding agent's handoff to a teammate's coding agent — with full context, on another laptop.**

[![npm version](https://img.shields.io/npm/v/agentrelay-mcp.svg)](https://www.npmjs.com/package/agentrelay-mcp)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![protocol](https://img.shields.io/badge/protocol-A2A-blueviolet.svg)](https://a2a-protocol.org)

Engineers don't ship alone — they hand off. The frontend agent waits on the
backend agent's API contract. The on-call agent inherits a debugging trail
from the agent that worked the issue at 3am EST. Today those handoffs go
through Slack: prose, screenshots, copy-paste, lost fidelity. The receiving
agent has to re-derive context the sending agent already had.

**AgentRelay is a direct, structured channel between coding agents on
different laptops.** Bob's agent calls a tool; Frank's agent receives a
thread with the file diff, the open question, the test command, the
provenance — _and the journey it took to get there_. Built on the open
[A2A protocol](https://a2a-protocol.org). Works with
[Claude Code](https://claude.com/code) and
[OpenAI Codex CLI](https://github.com/openai/codex).

> 🎬 **Demo video coming soon** — cross-repo handoff between two laptops
> with the L1 provenance preamble visible in both terminals.

---

## When does AgentRelay actually help?

Four concrete moments where the alternative is "Slack and pray."

### 1. Cross-repo handoff (frontend ↔ backend)

> Bob's agent just refactored `/users` in the **api** repo. He says:
> *"Hand this off to Frank — he owns the web client."* Frank's agent, in
> the **web** repo, gets a structured thread: the contract diff, the new
> error codes, the test command, a starter PR for the frontend wiring —
> all in a form his agent can act on without opening the api repo.

Today the API team writes a Notion doc; the FE team reads it Monday; the
FE agent has zero context for the API repo. AgentRelay carries the structured
contract straight across.

### 2. Async / timezone handoff

> You sign off at 6pm with a half-finished migration. You hand it off to
> your teammate in another timezone. When they wake up, their agent boots
> with full context: what you tried, what was blocked, what to try next.

No more Monday-morning "where did I leave off?" archaeology. The thread
already has the answer.

### 3. Share the journey, not just the destination

> Your agent spent two hours pinning down a flaky test — turned out to be
> a race in the dispatcher. Today you write *"fixed in PR #42, race in
> dispatcher.ts:120."* Your teammate reviews the patch but can't see how
> you got there. With AgentRelay, the handoff thread carries the full
> investigative trail — what was tried, what was ruled out, what the
> breakthrough was. Now their agent can apply the same pattern to the
> next flaky test.

Slack carries results; PRs carry diffs; AgentRelay carries the agent's
reasoning. That's the part nobody else captures.

### 4. Expert-on-tap inside a team

> One person on the team owns `$service`. Their agent has the deep
> CLAUDE.md, the gotchas, the historical context. Other developers' agents
> ask that agent through AgentRelay instead of paging the senior on Slack.

Junior unblocked, senior uninterrupted. The shared context lives in the
handoff thread — reusable next time someone hits the same question.

---

## Quick start

> 🚧 **v0.1.x onboarding is rougher than it should be (~15 min).**
> v1.0 (this week) ships [invite URLs](https://github.com/swayamg20/AgentRelay/issues/6)
> + a hosted relay. Self-hosted teams can use the invite flow below now.
> Full guide with troubleshooting: [`docs/onboarding.md`](docs/onboarding.md).

### Self-host the relay (once per team) — Docker only

```bash
git clone https://github.com/swayamg20/AgentRelay
cd AgentRelay
cp .env.example .env

# Rotate the secrets before exposing publicly:
sed -i '' "s|^RELAY_PEPPER=.*|RELAY_PEPPER=$(openssl rand -hex 32)|" .env
sed -i '' "s|^RELAY_INVITE_SECRET=.*|RELAY_INVITE_SECRET=$(openssl rand -hex 32)|" .env
sed -i '' "s|^RELAY_ADMIN_TOKEN=.*|RELAY_ADMIN_TOKEN=$(openssl rand -hex 16)|" .env

docker compose --profile selfhost up -d
curl http://localhost:8080/healthz                           # → {"status":"ok"}
```

Postgres + relay come up together; migrations run on boot. Point your
reverse proxy (Caddy / Cloudflare Tunnel / nginx) at `:8080`, set
`RELAY_PUBLIC_URL` in `.env`, and you're done.

The relay is a standard Dockerfile-based service — deploy it anywhere
that runs containers (your own VPS, Railway, Fly.io, Render, Hetzner,
Oracle Cloud, a Raspberry Pi). [`docs/hosting.md`](docs/hosting.md) is
a brief survey of the popular options with realistic cost notes; the
project doesn't recommend any one platform.

### One-command onboarding via invite URLs (recommended)

The team lead mints a single-use, expiring URL and shares it with the joiner
over Slack/email:

```bash
AGENTRELAY_ADMIN_TOKEN=<lead-admin-token> \
  npx -y -p agentrelay-mcp agentrelay invite pranjal@acme --role backend --expires 24h
# → https://relay.example.com/join#v1.eyJoYW5kbGUi...&sig=...
```

The joiner runs one command on a clean machine:

```bash
npx -y -p agentrelay-mcp agentrelay join 'https://relay.example.com/join#v1.…'
# ✓ joined as pranjal@acme
# try: ask Claude "check my agentrelay inbox"
```

The URL fragment carries an HMAC-signed token — the relay enforces
single-use semantics atomically with agent creation. The headless
`agentrelay register --admin-token …` flow stays available for CI/automation.

### Per-developer setup

```bash
# Register your identity (admin token from your team lead)
npx -y -p agentrelay-mcp agentrelay register \
  --relay https://your-team-relay.example.com \
  --admin-token <admin-token> \
  --handle bob@acme \
  --email bob@acme.com \
  --name "Bob" \
  --role backend

# Wire AgentRelay into Claude Code (user scope = works in every directory)
claude mcp add agentrelay --scope user -- npx -y agentrelay-mcp

# Apply the recommended permission overlay (allow reads/tests, ask before
# writes, deny git push / npm publish / curl / aws / kubectl)
npx -y -p agentrelay-mcp agentrelay install --client all

# Verify
npx -y -p agentrelay-mcp agentrelay doctor
```

Then in Claude Code or Codex CLI:
*"Send a handoff to frank@acme — I refactored the /users API, here's the
contract diff, the test command, and the open question on the web side."*

---

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

Two halves: a tiny **MCP server**
([`agentrelay-mcp` on npm](https://www.npmjs.com/package/agentrelay-mcp))
that each developer runs locally, and a **relay service** that the team
self-hosts via Docker (or, soon, a hosted instance run by the project).
Agents send structured handoffs through the relay; recipients
pull them with full provenance wrapping. Humans approve writes through
Claude Code's existing permission system.

---

## How handoffs stay safe

Cross-machine agent communication only works if you can stop a
prompt-injected (or malicious) sender from running anything they want on
the receiver. AgentRelay enforces that with four mandatory layers — every
handoff goes through all of them:

| Layer | Mechanism | Where it runs |
|---|---|---|
| **L1** | Provenance wrapping. Every teammate text is wrapped with `[INBOUND HANDOFF FROM <handle> via AgentRelay]` before the agent sees it. Treats inbound as data, not commands. | MCP server |
| **L2** | Permission overlay. `agentrelay install` writes `allow`/`ask`/`deny` rules to your Claude Code or Codex settings. Reads = auto, tests = auto, writes = ask, `git push`/`npm publish`/`aws`/`kubectl` = deny. | Claude Code / Codex harness |
| **L3** | Per-teammate trust. `~/.agentrelay/trust.yaml` — explicitly opt in teammates with granular `auto_write_paths`, `require_approval`. Unknown senders rejected by default. | MCP server |
| **L4** | Audit + atomic revocation. Every state mutation logged. `agentrelay block <handle>` revokes a teammate instantly. | Relay + MCP CLI |

Skip a layer, the safety guarantee evaporates. v0.1.0 wires all four.

---

## How AgentRelay compares

Adjacent tools each solve a slice of agent coordination, but none solve
peer-to-peer agent communication between humans on different laptops:

| Tool | Coordination scope | Cross-machine | Cross-developer |
|---|---|:---:|:---:|
| [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams) | Subagents in one developer's session | ❌ | ❌ |
| [OpenAI Agents SDK handoffs](https://openai.github.io/openai-agents-python/handoffs/) | Agent → agent in one runtime | ❌ | ❌ |
| [GitHub Copilot Coding Agent](https://github.blog/news-insights/product-news/github-copilot-coding-agent/) | Developer ↔ Copilot bot in cloud | ✅ | ❌ |
| [Cursor Background Agents](https://docs.cursor.com/background-agent) | One developer's async tasks | ✅ | ❌ |
| **AgentRelay** | **Agent-to-agent, between humans on different laptops** | **✅** | **✅** |

---

## What ships in v0.1

| Surface | Status |
|---|:---:|
| 7 MCP tools — `handoff_to_teammate`, `check_inbox`, `accept_handoff`, `view_thread`, `send_message`, `complete_handoff`, `list_teammates` | ✅ |
| `agentrelay` CLI — `register`, `install`, `rotate-key`, `doctor`, `audit`, `block`, `trust` | ✅ |
| Both clients (Claude Code JSON + Codex TOML) wired by one `install` command | ✅ |
| A2A JSON-RPC surface — `message/send`, `tasks/get`, `tasks/list`, `tasks/update`, `tasks/cancel`, `agents/list` | ✅ |
| Idempotency replay, intent invariant (`inform` / `ask_question`), block enforcement, audit log | ✅ |
| Slack notification on inbox arrival (encrypted webhook URL at rest) | ✅ |
| Four-layer trust model, all layers wired and demonstrated end-to-end | ✅ |

## What's coming in v1.0 (this week)

- One-command teammate onboarding via signed invite URLs
  ([#6](https://github.com/swayamg20/AgentRelay/issues/6))
- Hosted relay (run by the project) so you don't have to deploy anything
- Single `agentrelay` bin ([#5](https://github.com/swayamg20/AgentRelay/issues/5))
- `agentrelay doctor --fix` to auto-remediate setup issues
  ([#7](https://github.com/swayamg20/AgentRelay/issues/7))
- 90-second cross-repo demo video
- CI pipeline + end-to-end test suite

Track [v1.0 milestone](https://github.com/swayamg20/AgentRelay/milestone/2)
or browse the [project board](https://github.com/users/swayamg20/projects/2/views/1).

## Beyond v1.0

The MCP tools and trust model are domain-neutral — coding-agent assumptions
mostly live in the *prompts* the receiving agent gets, not the relay. Once
the coding-agent vertical is shipping smoothly, AgentRelay extends to any
MCP-using agent: research agents, support agents, ops agents. That's the
v2 thesis. The relay does not change.

For the next-feature roadmap (auto mode, ambient agent, federation) see
[`docs/next-steps.md`](docs/next-steps.md) and the
[ideas backlog](https://github.com/swayamg20/AgentRelay/issues?q=is%3Aopen+label%3Aideas).

---

## Repository

```
.
├── docs/
│   ├── architecture.md   ← canonical reference + four-layer trust model
│   ├── hld.md            ← state machine, sequence diagrams
│   ├── lld.md            ← schemas, endpoints, error codes
│   ├── onboarding.md     ← team setup walkthrough + troubleshooting
│   ├── hosting.md        ← survey of where to host the relay (cost, setup effort)
│   ├── deploy-fly.md     ← worked example: deploy to Fly.io
│   ├── next-steps.md     ← living planning index, linked to GH issues
│   ├── roadmap.md        ← phase-by-phase release plan
│   ├── auto-mode.md      ← v0.3 design: live pairing channel
│   └── ambient-agent.md  ← v0.4 design: headless drafting
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
for development setup, code conventions, the testing workflow, and the
trust-model invariants you must not break. [`CLAUDE.md`](CLAUDE.md) documents
the project rules in agent-teammate-readable form (handy if you bring Claude
Code or Codex along to help).

## Acknowledgments

Built on [A2A protocol](https://a2a-protocol.org) (Linux Foundation),
[Model Context Protocol](https://modelcontextprotocol.io),
[Claude Code](https://claude.com/code), and
[OpenAI Codex CLI](https://github.com/openai/codex).

## License

[MIT](LICENSE) © 2026 Swayam Gupta and AgentRelay contributors.
