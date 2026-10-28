# agentrelay-mcp

The current local tool surface for [AgentRelay](https://github.com/swayamg20/AgentRelay).
It provides a stdio MCP process for mailbox tools plus an optional foreground
connector that gives an owner-selected runtime low-latency mailbox attention.

> **Package:** `agentrelay-mcp` 0.4.0-beta.1 (`beta` channel); stable `latest` is 0.3.0.
> **Existing `bind`/`watch` boundary:** the connector does not wake a closed host, load peer content, perform
> work, or grant local authority. Its first Codex adapter queues only a content-free
> attention turn. Autonomous execution remains outside the mailbox product.
>
> **Pickup preview:** `bind` and `watch` are included in 0.3.0 as an optional,
> owner-started foreground connector. They are not a background service.

Requires Node 20.18.1 or newer.

**Beta live sessions:** `agentrelay live codex` supports bounded automatic text replies
in a dedicated, locally owned conversation. It does not attach to an arbitrary coding
chat or execute repository work. Install explicitly with
`npm install --global agentrelay-mcp@0.4.0-beta.1`; this requires authenticated Codex CLI
0.154.0 on macOS or glibc Linux. See
[live-session setup and safety limits](https://github.com/swayamg20/AgentRelay/blob/main/docs/live-sessions.md).

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
| `list_teammates` | Discover active teammates with exact role/skill/repo filters and optional bounded pages. |

In stable 0.3.0, the relay stores messages durably, but pickup is explicit. A human or
running agent must call `check_inbox` or `view_thread`. The beta live command adds a
separate, explicitly consented read/reply loop.

### Roster filters and pagination

`list_teammates` accepts optional `role`, `skill`, and `repo` filters. Inputs are
trimmed, then matched case-sensitively and exactly: role equality or whole-element
membership in skills/owned repositories. Filters combine with AND; no comma or
whitespace tokenization occurs. Stored card values are not normalized. Empty,
whitespace-only, non-string, unknown-key, or overlong filters fail validation
(role/skill maximum 60 characters, repo maximum 200). A valid unmatched value
returns an empty roster.

Filtered tool input:

```json
{ "role": "backend", "skill": "TypeScript", "repo": "acme/core" }
```

Without `page`, existing callers still receive the full matching roster with no
`next_cursor` field. To bound results, supply `page` with an integer `limit` from
1 to 200 (default 50) and optional `cursor` (default null):

```json
{ "skill": "TypeScript", "page": { "limit": 2 } }
```

The response includes provenance-marked `teammates` and `next_cursor`. If the
cursor is non-null, pass it back unchanged with the same filters; for example,
if it is `{ "after_handle": "bob@acme" }`:

```json
{ "skill": "TypeScript", "page": { "limit": 2, "cursor": { "after_handle": "bob@acme" } } }
```

A null `next_cursor` ends the traversal. The cursor is a validated exclusive
handle position, not a snapshot or permission. Handles are ordered ascending
under the Relay database's text ordering; an unchanged roster has no duplicates
across pages. Concurrent card/identity changes can change matches. Only active
identities appear, but the caller and blocked agents remain discoverable. Discovery
does not grant messaging consent. REST `GET /agents` is unchanged.

## Foreground auto-pickup preview

The preview removes silent mailbox waiting without making a remote teammate an
operator of your machine. It uses a persistent server-sent-event connection as a
content-free wake hint and an authenticated cursor API for authoritative replay.
Losing or duplicating the live hint cannot lose mailbox data.

For the stable attention-only workflow, install the exact release, then refresh the generated host policy.
Existing installations should use `--overwrite` so the old broad AgentRelay tool
wildcard is removed:

```bash
npm install --global agentrelay-mcp@0.3.0
agentrelay --version
agentrelay install --client all --overwrite
```

Then grant one exact sender, bind the Codex chat that should receive attention, and
run the foreground connector:

```bash
agentrelay trust set alice@team --auto-pickup true

# Run from a shell launched inside the target Codex chat so CODEX_THREAD_ID is local.
agentrelay bind codex

# Keep this running in a terminal while you want live pickup.
agentrelay watch
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
- `agentrelay export-thread <thread-id> [--output <path>]`
- `agentrelay block <handle>` / `unblock <handle>`
- `agentrelay trust list|set|reset`
- `agentrelay bind codex` / `unbind codex`
- `agentrelay watch [--once]`
- `agentrelay live codex --peer <handle> --handoff <Relay-thread-uuid> --allow-replies`
- `agentrelay mcp`

`agentrelay doctor` and `agentrelay doctor --json` exit with status `0` when no
checks fail, or `1` when configuration, client MCP entries, permission overlays,
trust parsing, Relay connectivity, or API-key validation fail. Both modes print
the report before exiting; `--json` preserves the existing `DoctorReport` fields.
With `--fix`, the exit status reflects the report after remediation, and `--fix
--json` retains its `{ before, after, fixed, skippedManual }` result.

Archive a thread using your configured participant identity:

```bash
agentrelay export-thread 11111111-1111-4111-8111-111111111111 --output review.md
```

Without `--output`, this writes `agentrelay-thread-<thread-id>.md` in the current
directory. The command uses participant-authorized `tasks/get` through `viewThread`,
prints the written path, refuses existing paths (including symlinks), and creates a
mode `0600` file. It does not change thread state or mark messages read. Failures
print actionable stderr and exit non-zero without printing credentials or Relay
response bodies. Create the destination directory first.

The deterministic Markdown archive includes participants, lifecycle timestamps,
initial content, ordered messages with payloads/artifacts, and completion/cancellation
state. All data is indented JSON, so teammate Markdown, HTML, and backticks stay
inert; typed artifact fields and existing caller-relative provenance are preserved.
Local configuration and Relay-owned idempotency metadata are not included. User-authored
message or artifact content is not secret-redacted; review the archive before sharing it.

## Security posture

Peer content is untrusted data.

Current protections include bearer authentication, participant authorization,
relay-side blocks for new handoffs and later content-bearing thread mutations, audit
records for invite, handoff/message, and block mutations, provenance wrappers or
structural markers on teammate-authored mailbox data, recommended host settings, and
local trust parsing.

The root of `trust.yaml` accepts only `version`, `teammates`, `unknown_teammates`,
`blocked`, and `defaults`. Unknown or misspelled root keys make the policy invalid,
not a warning. `doctor` reports broken trust, MCP uses safe defaults, and the attention
watcher refuses pickup without advancing its cursor until the file is fixed. A missing
file still uses safe defaults; nested schema acceptance is unchanged.

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
