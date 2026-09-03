# agentrelay-mcp

The current local tool surface for [AgentRelay](https://github.com/swayamg20/AgentRelay).
It provides a stdio MCP process for mailbox tools plus an optional foreground
connector that gives an owner-selected runtime low-latency mailbox attention.

> **Package:** `agentrelay-mcp` 0.2.1.
> **Boundary:** the connector does not wake a closed host, load peer content, perform
> work, or grant local authority. Its first Codex adapter queues only a content-free
> attention turn. Autonomous execution remains outside the mailbox product.
>
> **Unreleased preview:** `bind` and `watch` currently exist only in this repository
> checkout; the published npm package at 0.2.1 does not contain them yet.

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

## Auto-pickup preview

The preview removes silent mailbox waiting without making a remote teammate an
operator of your machine. It uses a persistent server-sent-event connection as a
content-free wake hint and an authenticated cursor API for authoritative replay.
Losing or duplicating the live hint cannot lose mailbox data.

For now, build the source checkout from the repository root. Then update the
generated host policy; existing installations should use `--overwrite` so the old
broad AgentRelay tool wildcard is removed:

```bash
pnpm --filter agentrelay-mcp build
node ./mcp-server/dist/bin/agentrelay.js install --client all --overwrite
```

Then grant one exact sender, bind the Codex chat that should receive attention, and
run the foreground connector:

```bash
node ./mcp-server/dist/bin/agentrelay.js trust set alice@team --auto-pickup true

# Run from a shell launched inside the target Codex chat so CODEX_THREAD_ID is local.
node ./mcp-server/dist/bin/agentrelay.js bind codex

# Keep this running in a terminal while you want live pickup.
node ./mcp-server/dist/bin/agentrelay.js watch
```

`agentrelay watch --once` replays currently pending recipient events and exits. The
Codex adapter calls `codex queue`; on a standalone Codex TUI, Codex's own local queue
refresh may add roughly ten seconds before the attention turn appears. The queued
prompt is constant: it includes no teammate text, event ID, or mailbox thread ID. The
connector itself calls no mailbox tool. The queued model turn still uses the bound
session's policy, so the generated Codex and Claude configurations ask the user before
content-bearing mailbox reads or AgentRelay mutations.

Consent is fail-closed and separable:

- `auto_pickup` applies only to the exact listed sender; join, defaults, and unknown
  sender policy cannot grant it.
- `agentrelay bind codex` selects one local UUID; Relay events cannot choose it.
- stopping `watch` closes the live connection; `agentrelay unbind codex` removes the
  saved target.
- `agentrelay trust set alice@team --auto-pickup false` revokes attention, while
  `agentrelay block alice@team` also fences new Relay content.

The saved cursor advances after an event is intentionally rejected by local policy,
coalesced, or durably accepted by the runtime queue. It does not advance after a
runtime enqueue failure. Runtime queue acceptance is not a read, processing,
delivery, acceptance, completion, or reply receipt.

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
- `agentrelay bind codex` / `unbind codex`
- `agentrelay watch [--once]`
- `agentrelay mcp`

## Security posture

Peer content is untrusted data.

Current protections include bearer authentication, participant authorization,
relay-side blocks for new handoffs and later content-bearing thread mutations, audit
records for invite, handoff/message, and block mutations, provenance wrappers or
structural markers on teammate-authored mailbox data, recommended host settings, and
local trust parsing.

Known limits:

- `watch` is a foreground preview, not an installed operating-system service.
- One local state directory permits one watcher at a time, preventing competing
  processes from racing its replay cursor.
- The Codex reference adapter provides content-free attention, not automatic reading
  or work. Queued turns cannot yet receive a narrower host-enforced tool envelope, so
  the generated host policy approval-gates mailbox reads and mutations instead of
  treating the fixed prompt as enforcement.
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

The mailbox product boundary and evidence gates are documented in
[`RFC 002`](https://github.com/swayamg20/AgentRelay/blob/main/docs/rfcs/002-agent-reachability-and-durable-mailbox.md).
The more demanding autonomous enforcement model remains preserved as the Labs
architecture in
[`RFC 001`](https://github.com/swayamg20/AgentRelay/blob/main/docs/rfcs/001-agentrelay-node-and-missions.md).

## Community and help

Join the [AgentRelay Discord community](https://discord.gg/r2R9v3cret) for setup and
usage questions. Do not post credentials, invite URLs, private message content,
unredacted logs, or security reports. Use the repository's
[private security process](https://github.com/swayamg20/AgentRelay/security/advisories/new)
for suspected vulnerabilities.

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
