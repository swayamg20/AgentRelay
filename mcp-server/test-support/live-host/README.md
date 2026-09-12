# Live host probes

These development fixtures test whether an installed host accepts incoming session
events and returns correlated tool replies. They use synthetic data and an in-memory
session; they never connect to a Relay or use AgentRelay credentials. Live runs reuse
the selected host's authentication and may consume model usage.

## Claude Code Channel

From a terminal with Claude Code installed and authenticated:

```sh
pnpm --filter agentrelay-mcp probe:claude-channel
```

Claude asks for development-channel consent. Approve the local fixture and leave the
chat empty. Three notifications should each cause Claude to fetch a synthetic
challenge and reply through the fixture tool. The runner stops its own Claude process
after three replies or two minutes and prints the result and local receipt-log path.

The child session has no built-in tools, skills, hooks, or other MCP servers. Only the
fixture's receive/reply tools are allowed. Permission relay is not declared. A fresh
temporary working directory prevents loading repository instructions.

The evidence distinguishes `signal_written`, `turn_observed`, and `reply_recorded`.
Writing a notification never counts as agent processing. The fixture also tests exact
references, duplicate replies, conflicts, stop, and expiry without running a model:

```sh
pnpm --filter agentrelay-mcp exec vitest run test-support/live-host/probe-session.test.ts
```

This is an opt-in host experiment, not an installed mailbox feature. Its temporary
files are retained for inspection. It does not prove cross-machine delivery, durable
replay, or safe repository execution.

If Claude reports that Channels are blocked by organization policy, the probe cannot
pass: notifications can be written successfully but silently dropped by the host.
An authorized administrator must enable Channels before rerunning it; the fixture
does not change managed policy. Folder trust and development-channel consent may
both appear before the empty chat opens.

## Codex managed turn

With Codex CLI 0.154.0 installed and authenticated:

```sh
pnpm --filter agentrelay-mcp probe:codex-turn
```

This version-pinned probe starts its own stdio app-server and an ephemeral thread in
a fresh temporary directory. It injects three reference-only inputs through
`turn/start` and requires a receive/reply tool exchange plus `turn/completed` for each.
It never resumes or queues input into an existing conversation.

The thread uses a read-only sandbox. Shell tools, hooks, plugins, apps, browser tools,
and other effectful integrations are disabled for this process. The runner checks
that inherited MCP servers are disabled with empty tool/resource inventories before
sending model input, and refuses unexpected host requests. The two synthetic fixture
tools share the same schemas and session checks as the Claude probe.

Configuration overrides are process/thread-local, not edits to the owner's Codex
configuration. The runner retains only stage/identifier evidence, not model text or
raw host diagnostics. A passing result proves a managed-session round trip, **not**
injection into an already-open Codex terminal UI, cross-machine Relay delivery, or
production containment for arbitrary tasks.

## Codex queue with a visible terminal

On macOS/Linux, from an interactive terminal:

```sh
pnpm --filter agentrelay-mcp probe:codex-queue
```

This variant starts a private Unix-socket app-server, creates a new synthetic thread,
and opens the Codex TUI on that exact thread. Leave the chat empty. Three separate
`codex queue --remote <private-socket> --thread <created-id>` commands must each
produce the same receive/reply exchange and completed-turn evidence. The runner does
not type into or scrape the terminal. It stops only its own processes afterward.

The synthetic thread is named `AgentRelay synthetic queue probe` and retained in
local Codex history for inspection. No pre-existing conversation is selected. Remote
resume preserves the server's read-only permissions; the probe does not request a
permission override. This tests a visible TUI attached to the probe-managed server,
not arbitrary pre-existing sessions on the default Codex daemon.

The local WebSocket bridge uses the existing `undici` dependency with an explicit
Unix connector. It omits the optional compression extension, which Codex 0.154.0
rejects during this handshake. No TCP port is exposed or permission policy changed.

The probes follow the host-specific interfaces documented in
[Claude Channels](https://code.claude.com/docs/en/channels-reference) and
[Codex app-server](https://learn.chatgpt.com/docs/app-server). These experimental
surfaces require host-specific checks; ordinary MCP support alone is not equivalent.
