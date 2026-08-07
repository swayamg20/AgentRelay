# Onboarding: current AgentRelay mailbox

This guide connects two or more developers to the current asynchronous handoff
mailbox. It does not install or configure the experimental foreground AgentRelay Node
or enable real-runtime autonomous pickup. Each recipient still asks an already-running
agent to check its inbox.

## 1. Team lead: run a relay

The relay needs Postgres 16, a public HTTPS URL for cross-device use, and the required
secrets defined in `.env.example`.

### Local evaluation

Requires Node 20.18.1+, pnpm 9+, Docker, and a clone of this repository:

```bash
pnpm install
cp .env.example .env
docker compose up -d

set -a
. ./.env
set +a

pnpm --filter relay db:migrate
pnpm --filter relay dev
```

The default database is on `localhost:5433`; the relay listens on port 8080. Verify:

```bash
curl http://localhost:8080/healthz
curl http://localhost:8080/readyz
```

Replace every development secret before exposing the relay. Keep `RELAY_PEPPER`,
`RELAY_ENCRYPTION_KEY`, and `RELAY_INVITE_SECRET` stable in a secret manager; casual
rotation invalidates existing agent and Node credentials, encrypted fields, or
outstanding invites.

### Team deployment

The relay is a container plus Postgres. See [`hosting.md`](hosting.md) for options,
[`deploy-azure.md`](deploy-azure.md) for the Azure team pilot, and
[`deploy-fly.md`](deploy-fly.md) for a relay-only Fly example. The repository's
`docker compose --profile selfhost` service forwards every required Relay secret from
`.env`, including `RELAY_INVITE_SECRET`.

Set `RELAY_PUBLIC_URL` to the externally reachable HTTPS origin before minting
invites. The URL is embedded in invite links.

## 2. Team lead: register and invite

### Register the first teammate

The initial administrator-controlled registration uses the relay admin token:

```bash
npx -y -p agentrelay-mcp agentrelay register \
  --relay https://relay.example.com \
  --admin-token <admin-token> \
  --handle bob@acme \
  --email bob@acme.com \
  --name "Bob" \
  --role backend

npx -y -p agentrelay-mcp agentrelay install --client all
npx -y -p agentrelay-mcp agentrelay doctor
```

Registration writes `~/.agentrelay/config.json` with mode 0600. Do not paste its API
key into issues, logs, or shared chat.

### Mint an invite

Run this from a registered machine so the CLI knows the inviter handle and relay URL:

```bash
AGENTRELAY_ADMIN_TOKEN=<admin-token> \
  npx -y -p agentrelay-mcp agentrelay invite frank@acme \
  --role android \
  --expires 24h
```

Share the returned URL through a trusted channel. It is signed, expiring, and
single-use. The token lives in the URL fragment so browsers do not send it to an
unrelated origin, but the recipient CLI will submit it to the relay redemption route.

## 3. Teammate: join

Requires Node 20.18.1+ and at least one supported host: Claude Code or Codex.

```bash
npx -y -p agentrelay-mcp agentrelay join 'https://relay.example.com/join#v1.…'
```

`join` performs four operations:

1. Redeems the invite and receives the one-time API key.
2. Writes mode-0600 `~/.agentrelay/config.json`.
3. Creates or updates `~/.agentrelay/trust.yaml` with the inviter.
4. Runs `agentrelay install --client all`.

Verify the result:

```bash
npx -y -p agentrelay-mcp agentrelay doctor
```

If an MCP entry or permission recommendation is missing:

```bash
npx -y -p agentrelay-mcp agentrelay doctor --fix
```

Restart the coding-agent host after configuration changes. In Claude Code, `/mcp`
should list `agentrelay`. For Codex, inspect the configured MCP servers using the
current Codex CLI command for your installed version.

## 4. Manual registration fallback

Invites are the preferred human onboarding path. CI or tightly controlled
administration may still register directly:

```bash
npx -y -p agentrelay-mcp agentrelay register \
  --relay https://relay.example.com \
  --admin-token <admin-token> \
  --handle frank@acme \
  --email frank@acme.com \
  --name "Frank" \
  --role android

npx -y -p agentrelay-mcp agentrelay install --client all
```

## 5. First round trip

### Sender

Ask the running host agent:

> Use AgentRelay to list my teammates, then send an `ask_question` handoff to
> `frank@acme` with the summary "Cross-machine setup test" and ask them to confirm
> they can read this thread.

The result contains a `thread_id`.

### Receiver

The receiver asks their running host agent:

> Check my AgentRelay inbox, accept the setup-test handoff, and reply "confirmed."

### Sender again

The sender asks:

> View the AgentRelay thread `<thread_id>` and show the latest reply.

This verifies registration, relay authentication, persistence, both MCP processes,
participant authorization, and the manual message flow. It does not verify autonomous
runtime activation.

## 6. Current trust behavior

- Treat every remote summary, message, diff, command, contract, and link as untrusted
  data.
- The inbox and thread tools provenance-wrap teammate-authored text and attach a
  non-spoofable marker to structured teammate payloads, proposals, and artifacts.
- `agentrelay install` writes recommended host settings. Host semantics differ and
  the settings are not a substitute for an operating-system sandbox.
- `trust.yaml` influences the decision returned by `accept_handoff`; the result is
  not dynamically applied to an active runtime.
- Relay audit covers invite, handoff/message, block, Node/workspace, Mission, and
  delivery-operation mutations. It still omits several agent-management mutations
  and every local command, edit, and test because the experimental Node does not
  report those actions yet.

For this mailbox release, keep writes and external actions behind the host's normal
human approval flow. Do not treat a teammate's message as permission to push, deploy,
publish, expose secrets, or execute an arbitrary command.

## 7. Useful commands

| Action | Command |
|---|---|
| Verify setup | `npx -y -p agentrelay-mcp agentrelay doctor` |
| Repair safe config gaps | `npx -y -p agentrelay-mcp agentrelay doctor --fix` |
| Rotate local API key | `npx -y -p agentrelay-mcp agentrelay rotate-key` |
| Read relay audit | `npx -y -p agentrelay-mcp agentrelay audit --limit 20` |
| Block a teammate | `npx -y -p agentrelay-mcp agentrelay block <handle>` |
| Unblock a teammate | `npx -y -p agentrelay-mcp agentrelay unblock <handle>` |
| Inspect trust entries | `npx -y -p agentrelay-mcp agentrelay trust list` |
| Reinstall clients | `npx -y -p agentrelay-mcp agentrelay install --client all` |

`block` activates local trust denial before syncing the relay. `unblock` clears the
relay before clearing local denial. A partial failure therefore stays fail-safe on
this machine, and the command explains which side succeeded; retry it to converge the
two stores. A running MCP process reloads trust before accepting work, so it does not
need a restart to observe a new local block.

## 8. Common failures

### `doctor` reports config missing

Run `join` or `register`; install alone does not create relay credentials.

### Relay returns 401

The admin token or developer API key is wrong or has been rotated. Registration uses
the admin token; ordinary MCP and self-service calls use the developer key.

### Invite is expired or already used

Mint a new invite. Redemption locks the invite row and permits one successful use.

### Host does not show AgentRelay tools

Run `doctor --fix`, restart the host, and check the host's MCP configuration. Claude's
MCP entry and permission settings live in different files; the installer handles both.

### Slack notification does not arrive

The handoff is still durable. Ask the recipient to check the inbox. Webhook URLs are
encrypted at rest, but dispatcher delivery is best effort and its queue does not
survive relay restart. An installation upgraded from before migration `0004` must
submit its webhook URL once more because the migration clears the legacy plaintext
secret instead of retaining it unencrypted. The relay accepts only exact
`https://hooks.slack.com/services/...` targets and refuses redirects.

### Agent proposes an unexpected command or edit

Reject it. Remote content is untrusted and the current trust overlay is advisory.
Inspect host settings, local trust, the thread, and relay audit before continuing.
