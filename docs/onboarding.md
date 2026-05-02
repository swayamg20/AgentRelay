# Onboarding guide — connect your team to AgentRelay

This is the step-by-step for getting two or more developers' coding agents
talking to each other through a self-hosted AgentRelay. It's the canonical
"how do we set this up?" doc — read this if you're either (a) the team
lead bringing AgentRelay up for the first time, or (b) a teammate joining
a relay someone else already runs.

> **Heads up — onboarding is rougher than it should be in v0.1.x.** The
> 2026-04-28 cross-machine test took ~50 min for two people, mostly fighting
> the issues tracked under [v0.1.2](https://github.com/swayamg20/AgentRelay/milestone/1)
> and [v0.2.0](https://github.com/swayamg20/AgentRelay/milestone/2). The
> instructions below include the workarounds. Once those issues land, this
> doc collapses to a much shorter version (track [#6](https://github.com/swayamg20/AgentRelay/issues/6)).

---

## Part 1 — Team lead: stand up the relay (once)

You only do this once per team.

### 1.1 Self-host with Docker

Requires Docker. No Node, no pnpm.

```bash
git clone https://github.com/swayamg20/AgentRelay
cd AgentRelay
cp .env.example .env

# Rotate the secrets before exposing publicly:
sed -i '' "s|^RELAY_PEPPER=.*|RELAY_PEPPER=$(openssl rand -hex 32)|" .env
sed -i '' "s|^RELAY_ADMIN_TOKEN=.*|RELAY_ADMIN_TOKEN=$(openssl rand -hex 16)|" .env
sed -i '' "s|^RELAY_ENCRYPTION_KEY=.*|RELAY_ENCRYPTION_KEY=$(openssl rand -hex 32)|" .env

docker compose --profile selfhost up -d
curl http://localhost:8080/healthz   # → {"status":"ok"}
```

### 1.2 Expose to the internet (so teammates on other laptops can reach it)

Point a reverse proxy at `:8080` (nginx / caddy / cloudflared / Cloudflare
Tunnel). Set `RELAY_PUBLIC_URL` in `.env` to the public URL and restart:

```bash
docker compose --profile selfhost up -d   # picks up new env
```

For testing, an SSH tunnel from a public box or a Cloudflare quick tunnel
works fine.

### 1.3 Stash the admin token securely

`RELAY_ADMIN_TOKEN` from your `.env` is what your teammates need to register.
Store it in 1Password / your team vault. Do not paste it into a public
channel. Until [#6](https://github.com/swayamg20/AgentRelay/issues/6) lands,
you'll DM it to each teammate over a secure channel.

### 1.4 Register yourself

You're a teammate too. Follow Part 2 on your own laptop.

---

## Part 2 — Each teammate: join the relay

Per person. Today this is ~10 min on a good day; target after
[#6](https://github.com/swayamg20/AgentRelay/issues/6) is <5 min.

### 2.1 Prereqs

- Node 20+
- Claude Code or Codex CLI installed
- `jq` if you'll be merging into an existing project's `.mcp.json`
  (`brew install jq` on macOS)

### 2.2 Register your identity with the relay

Use the **`agentrelay`** CLI, not the `agentrelay-mcp` server bin
(see [#2](https://github.com/swayamg20/AgentRelay/issues/2)):

```bash
npx -y -p agentrelay-mcp agentrelay register \
  --relay https://your-team-relay.example.com \
  --admin-token <token-from-team-lead> \
  --handle <your-handle>@<team> \
  --email <your-email> \
  --name "<Your Name>" \
  --role <backend|frontend|infra|...>
```

This writes `~/.agentrelay/config.json` (mode 0600). Verify:

```bash
cat ~/.agentrelay/config.json
```

### 2.3 Wire AgentRelay into Claude Code

Until [#1](https://github.com/swayamg20/AgentRelay/issues/1) lands, **don't
rely on `agentrelay install` for the MCP entry** — it writes to a file
Claude Code doesn't read. Use `claude mcp add` directly:

```bash
claude mcp add agentrelay --scope user -- npx -y agentrelay-mcp
claude mcp list   # should list 'agentrelay'
```

Note: Internally, `agentrelay-mcp` and `agentrelay mcp` are equivalent. The
shorter `agentrelay mcp` form will be the recommended invocation in v0.2;
today both work.

The `--scope user` flag means the entry works in every directory you open
Claude Code in, not just one project.

For the permission overlay (allow/ask/deny rules), still run:

```bash
npx -y -p agentrelay-mcp agentrelay install --client all
```

That part of `install` works correctly — it just shouldn't be relied on for
the MCP server registration today.

### 2.4 Configure trust

Trust is per-teammate. By default unknown senders are accepted with
default-trust permissions; for stricter posture, list teammates explicitly.

Use the **correct schema** (see [#4](https://github.com/swayamg20/AgentRelay/issues/4)):

```bash
mkdir -p ~/.agentrelay
[ -f ~/.agentrelay/trust.yaml ] && cp ~/.agentrelay/trust.yaml ~/.agentrelay/trust.yaml.bak
cat > ~/.agentrelay/trust.yaml <<'EOF'
version: 1
teammates:
  inviter@team:
    auto_read: true
    auto_test: true
    auto_write_paths: []
    require_approval: ["Edit", "Write", "Bash"]
unknown_teammates:
  policy: allow_with_default_trust
defaults:
  auto_read: true
  auto_test: true
  auto_write_paths: []
  require_approval: ["Edit", "Write", "Bash"]
blocked: []
EOF
```

Replace `inviter@team` with the actual handle of whoever invited you. Add
more entries under `teammates:` for every other person on your team.

### 2.5 Verify

```bash
npx -y -p agentrelay-mcp agentrelay doctor
```

You want every line to read `OK`:

```
config:           OK
relay reachable:  OK
api key valid:    OK
mcp[claude-code]: OK
trust.yaml:       OK
```

If any line is `MISSING`, see Troubleshooting below.

### 2.6 Restart Claude Code and confirm the MCP server is loaded

Quit Claude Code and re-open it. Run `/mcp` — `agentrelay` should appear in
the list of MCP servers.

---

## Part 3 — First handoff round-trip (verify end-to-end)

### Sender (you)

In Claude Code, ask:

> *"Use agentrelay to send a handoff to teammate@team. Intent:
> ask_question. Summary: 'Cross-machine setup test'. Body: 'If you can
> read this with the inbound preamble wrapper, the trust model is working
> end-to-end. Reply with accept_handoff then send_message to confirm.'"*

Claude calls the `handoff_to_teammate` MCP tool. You'll see a `thread_id`
in the response. The relay sends a Slack DM to the recipient if their
profile has a webhook set.

### Receiver (teammate)

In their Claude Code, they ask:

> *"Check my agentrelay inbox."*

The handoff appears, **wrapped with the L1 provenance preamble**:

```
[INBOUND HANDOFF FROM <your-handle> via AgentRelay]
<your message body>
[END OF HANDOFF]
```

That preamble is the load-bearing security primitive — it tells their
agent your text is data to be considered, not commands to be executed.

They reply with:

> *"Accept the handoff and send a message back saying confirmed."*

When the reply lands in your inbox (also preamble-wrapped), the round-trip
is complete.

---

## Troubleshooting

**Try `agentrelay doctor --fix` first.** It auto-remediates missing
MCP entries and permission overlays. Manual issues (missing
`~/.agentrelay/config.json`, broken `trust.yaml`) will be reported with
the exact command to run. Use `agentrelay doctor --json` when scripting
or checking the report in CI.

These are the actual errors hit during the 2026-04-28 cross-machine test.

### `"agentrelay config unavailable"` log on register

You ran the wrong bin. `agentrelay-mcp` is the MCP server (stdio) (equivalent
to `agentrelay mcp`); it silently ignores CLI args and starts the server. Use
`agentrelay`:

```bash
npx -y -p agentrelay-mcp agentrelay register ...
```

Tracked in [#2](https://github.com/swayamg20/AgentRelay/issues/2).

### `~/.agentrelay/config.json` is empty after register

Same issue — wrong bin. Re-run with the correct command above and verify
`cat ~/.agentrelay/config.json` is populated.

### `/mcp` in Claude Code doesn't list `agentrelay`

`agentrelay install` wrote the MCP entry to the wrong file
([#1](https://github.com/swayamg20/AgentRelay/issues/1)). Run:

```bash
claude mcp add agentrelay --scope user -- npx -y agentrelay-mcp
```

Then restart Claude Code.

### Handoff rejected with "trust gate denied"

Receiver hasn't added you to their `~/.agentrelay/trust.yaml`. Have them
add a `<your-handle>:` entry under `teammates:` (see §2.4 for schema).
The `unknown_teammates.policy` setting governs the default for unlisted
senders.

### `register` returns `relay … returned 401`

Wrong admin token, or the team lead rotated it after you got it. Ask for
the current token.

### `register` returns `relay … returned 409`

Your handle is already taken. Pick another, or have the lead delete the
existing record (`agentrelay block` then re-register).

### Slack notifications aren't firing

Slack webhook is per-agent; set it via your relay's admin tooling. (CLI
support tracked separately.)

### Agent runs commands the user didn't expect

That's the L2 permission overlay job. Check
`~/.claude/settings.json` `permissions` block — it should `ask` for
`Edit`/`Write`/`Bash` and `deny` `git push` / `npm publish` / `aws` /
`kubectl` / `curl`. If the overlay is missing, re-run
`agentrelay install --client all`.

---

## Quick reference

| Step | Command |
|---|---|
| Register | `npx -y -p agentrelay-mcp agentrelay register …` |
| Wire MCP | `claude mcp add agentrelay --scope user -- npx -y agentrelay-mcp` |
| Permission overlay | `npx -y -p agentrelay-mcp agentrelay install --client all` |
| Verify | `npx -y -p agentrelay-mcp agentrelay doctor` |
| Block teammate | `npx -y -p agentrelay-mcp agentrelay block <handle>` |
| Audit log | `npx -y -p agentrelay-mcp agentrelay audit --tail 20` |
| Rotate API key | `npx -y -p agentrelay-mcp agentrelay rotate-key` |

---

## Future state

After [#6](https://github.com/swayamg20/AgentRelay/issues/6) lands, all of
Part 2 collapses to:

```bash
agentrelay join 'https://your-relay.example.com/join#v1.…&sig=…'
```

The lead mints the URL, the teammate runs one command, and they're set.
This doc will shrink accordingly.
