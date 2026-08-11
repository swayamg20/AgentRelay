# agentrelay-mcp

The current local tool surface for [AgentRelay](https://github.com/swayamg20/AgentRelay).
It runs as a stdio MCP process and lets an already-running Claude Code or Codex host
use the AgentRelay handoff mailbox.

> **Package:** `agentrelay-mcp` 0.2.1.
> **Boundary:** this package does not run a background listener, wake a closed host,
> or start autonomous coding-agent turns. Runtime activation belongs to the separate
> experimental AgentRelay Node, which is currently fake-adapter only.

Requires Node 20.18.1 or newer.

## Join a relay

Preferred invite flow:

```bash
npx -y -p agentrelay-mcp agentrelay join 'https://relay.example.com/join#v1.…'
npx -y -p agentrelay-mcp agentrelay doctor
```

Administrator-controlled registration:

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

Local credentials and trust live under `~/.agentrelay/` with mode 0600. Client
configuration is written to the current Claude and Codex user config locations.

## Tools

| Tool | Behavior |
|---|---|
| `handoff_to_teammate` | Create a typed handoff with summary, intent, and artifacts. |
| `check_inbox` | List received handoffs. |
| `accept_handoff` | Fetch and accept a handoff; return wrapped thread text and a local trust decision. |
| `view_thread` | Read a participant thread without changing its lifecycle. |
| `send_message` | Append a message to an active thread. |
| `complete_handoff` | Mark an accepted handoff complete. |
| `list_teammates` | Fetch the active team roster. |

The relay stores messages durably, but pickup is explicit. A human or running agent
must call `check_inbox` or `view_thread`.

The stdio server caps each MCP JSON-RPC request at 10 MiB. For larger code artifacts,
send a `file_ref` instead of putting a huge diff or other content inline.

## CLI

- `agentrelay register`
- `agentrelay invite <handle>`
- `agentrelay join <url>`
- `agentrelay install --client <claude-code|codex|all>`
- `agentrelay doctor [--fix] [--json]`
- `agentrelay rotate-key`
- `agentrelay audit`
- `agentrelay block <handle>` / `unblock <handle>`
- `agentrelay trust list|set|reset`
- `agentrelay mcp`

## Security posture

Peer content is untrusted data.

Current protections include bearer authentication, participant authorization,
relay-side blocks for new handoffs and later content-bearing thread mutations, audit
records for invite, handoff/message, and block mutations, provenance wrappers or
structural markers on teammate-authored mailbox data, recommended host settings, and
local trust parsing.

Known limits:

- Pickup is explicit; this stdio process does not listen in the background or start a
  host turn.
- `accept_handoff` returns `trust_overlay`, but this package does not dynamically
  apply it to an active Claude or Codex session.
- Host permission semantics are provider-specific; generated config is a
  recommendation, not a universal enforcement guarantee.
- Relay audit omits several relay mutations and does not record local commands,
  edits, tests, or permission decisions.
- Relay and local block writes cannot commit atomically across HTTP and the local
  filesystem. The CLI uses a fail-safe order and reports partial failures for retry.

Keep writes and external effects behind the host's ordinary human approval boundary.
Do not grant remote content authority to push, publish, deploy, access credentials, or
run arbitrary commands.

The target enforcement model is documented in
[`RFC 001`](https://github.com/swayamg20/AgentRelay/blob/main/docs/rfcs/001-agentrelay-node-and-missions.md).

## Development

From the repository root:

```bash
pnpm install
pnpm --filter agentrelay-mcp typecheck
pnpm --filter agentrelay-mcp test
pnpm --filter agentrelay-mcp build
```

Start the stdio process from source with:

```bash
pnpm --filter agentrelay-mcp dev
```

## Relay

The relay is a separate Hono + Postgres service in the
[main repository](https://github.com/swayamg20/AgentRelay). See the root README and
onboarding guide for current setup and known deployment limitations.

## License

MIT
