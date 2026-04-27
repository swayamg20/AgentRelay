# agentrelay-mcp

The MCP server for [AgentRelay](https://github.com/swayamg20/AgentRelay). Runs as
a local stdio process; exposes seven tools to Claude Code and Codex CLI for
sending and receiving structured handoffs between teammates' agents.

> **Status:** v0.1.0 — async mailbox flow verified end-to-end with real two-laptop demo.

## Install

```bash
# Per-developer, scoped to one project — recommended for trying it out.
npx agentrelay-mcp register \
  --relay <your-team-relay-url> \
  --admin-token <admin-token> \
  --handle bob@acme \
  --email bob@acme.com \
  --name "Bob" \
  --role backend

npx agentrelay-mcp install --client claude-code
# or --client codex, or --client all
```

The `register` step writes `~/.agentrelay/config.json` (mode 0600) with your
relay URL + API key. The `install` step adds the MCP entry + a recommended
permission overlay to your client's settings.

## Tools surfaced to the agent

| Tool | What it does |
|---|---|
| `handoff_to_teammate` | Package and send a structured handoff (summary, artifacts, intent) |
| `check_inbox` | List handoffs awaiting your response |
| `accept_handoff` | Pull a teammate's handoff into your session with L1 provenance wrapping |
| `view_thread` | Read-only fetch of any thread you're a participant in |
| `send_message` | Append a message to an existing thread |
| `complete_handoff` | Mark a handoff complete with a result summary |
| `list_teammates` | Discover the team roster |

## Trust model

The MCP server enforces three of the four trust layers (the relay handles the
fourth):

1. **L1 — Provenance wrapping.** Every text field originating from a teammate
   is wrapped with `[INBOUND HANDOFF FROM <handle> via AgentRelay]` before
   the agent sees it. Treats inbound content as untrusted data, not commands.
2. **L2 — Permission overlay.** `agentrelay install` writes a recommended
   `permissions` block to your client's settings: read/test allowed, writes
   ask, external effects (push, publish, deploy) deny.
3. **L3 — Per-teammate trust.** `~/.agentrelay/trust.yaml` opts in specific
   teammates and granular policies (auto_write_paths, require_approval).
4. **L4 — Audit + revocation.** `agentrelay audit` shows every action; 
   `agentrelay block <handle>` revokes a teammate atomically.

Full design: [architecture.md §5 in the repo](https://github.com/swayamg20/AgentRelay/blob/main/docs/architecture.md).

## CLI commands

- `agentrelay register` — onboard with a relay
- `agentrelay install --client <claude-code|codex|all>` — wire into your CLI
- `agentrelay doctor` — diagnose config / connectivity
- `agentrelay rotate-key` — self-rotate your API key
- `agentrelay audit` — query your audit log
- `agentrelay block <handle>` / `unblock` — revoke a teammate
- `agentrelay trust list/set/reset` — manage `~/.agentrelay/trust.yaml`

## Self-hosting the relay

The relay is a separate Hono + Postgres service published in the
[main repo](https://github.com/swayamg20/AgentRelay). Run it via Docker
Compose:

```bash
git clone https://github.com/swayamg20/AgentRelay
cd AgentRelay
docker compose up -d
pnpm --filter relay db:migrate
pnpm --filter relay dev
```

Then point each developer's MCP server at it via `agentrelay register --relay <your-host>`.

## License

MIT
