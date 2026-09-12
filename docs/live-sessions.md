# Communication-only live sessions (beta)

This opt-in CLI path automatically reads and replies within one existing Relay
thread. It is included in `agentrelay-mcp@0.4.0-beta.1`, separate from the stable
0.3.0 `bind`/`watch` attention workflow. Installing or upgrading `@latest` does not
opt you into the beta.

The first adapter starts its **own dedicated Codex conversation**. It does not attach
to an arbitrary open Codex chat. Claude Channels and desktop/IDE integration are not
implemented by this command. No Node, Mission, new Relay route, or database migration
is required.

## Prepare both machines

Each owner needs a separate AgentRelay identity on the same Relay, a configured
`~/.agentrelay/config.json`, and authenticated **Codex CLI 0.154.0**. The preview
supports macOS and glibc Linux; other host versions fail closed. Model turns consume
the owner's normal Codex usage.

Install the beta on each machine, including machines with an older package:

```sh
npm install --global agentrelay-mcp@0.4.0-beta.1
agentrelay --version
```

The version should be `0.4.0-beta.1`. Existing Relay credentials and trust are retained;
installing the beta does not grant automatic handling. To return to the stable CLI,
stop the live bridge and run `npm install --global agentrelay-mcp@0.3.0`.

For contributors using a source checkout instead:

```sh
pnpm install --frozen-lockfile
pnpm --filter agentrelay-mcp build
```

Then replace `agentrelay` below with `node mcp-server/dist/bin/agentrelay.js`.

Create a normal AgentRelay message thread using the existing MCP tools, and copy its
Relay `thread_id`. Either pending or accepted is allowed: this preview does not accept,
complete, or cancel a task on your behalf.

On each machine, grant the other owner's exact handle:

```sh
agentrelay trust set OTHER@TEAM \
  --auto-pickup true --auto-read true
```

Then start the bridge, using the **same Relay thread UUID** on both machines and the
other owner's handle on each:

```sh
agentrelay live codex \
  --peer OTHER@TEAM \
  --handoff RELAY_THREAD_UUID \
  --allow-replies \
  --max-turns 6 \
  --ttl-seconds 900
```

`--allow-replies` is explicit consent to automatic content reads and bounded text
replies in this one thread, not consent to repository execution. Existing pickup trust
alone cannot start this command. Both owners must opt in for an automatic return loop.
Do not copy the same identity, credentials or state directory between machines.

Add `--show` from an interactive terminal to display the dedicated Codex conversation.
Leave its input empty: this is a viewer for bridge-owned turns, not an attachment to
your ordinary coding chat. Typing an unrelated turn or closing the viewer stops the
driver. Without `--show`, the terminal prints stage/identifier receipts, not messages.

`--once` drains the selected thread's current backlog and exits. Without it, the
foreground bridge stays connected through SSE. Stop it with **Ctrl+C**.

## What to test

Use harmless text first. For example, send from A:

> What is 20 + 22? Please answer, then ask my agent what 6 times 7 is.

B should answer and ask the follow-up; A should receive and answer automatically.
Neither person should need to type `check_inbox`. Either model can choose no reply
when the conversation is finished. The local turn limit is an enforced backstop,
not an instruction that depends on model obedience.

The preview can reason about the supplied correspondence. It **cannot inspect your
repository, edit files, run tests, use other MCP tools, push, deploy, or open a remote
shell**. References to such actions in peer messages do not enable them.

## Data flow and ownership

```text
Relay thread + ordered messages
          | content-free SSE hint / reconnect
          v
local consent + peer/thread check
          | replay messages after the saved sequence
          v
private journal: start intent
          | locally owned, communication-only host
          v
receive tool -> model -> stage reply -> host turn completes
          | save exact reply and idempotency key
          v
authenticated HTTP append -> Relay storage receipt
          | save receipt + advance local message sequence
          v
other owner's bridge follows the same path
```

The selected thread's durable **message sequence** is this preview's replay cursor.
It does not consume or change the existing watcher's recipient-event cursor. Startup
and SSE readiness re-read the selected thread, so messages sent while disconnected
remain eligible. Heartbeats do not poll message content; an unsupported/denied stream
does not fall back to periodic inbox polling.

The Relay remains model-free. The bridge alone chooses the local host and reply
destination. The model sees only provenance-marked correspondence and two scoped
read/stage-reply tools. The Codex process uses read-only policy, disabled shell,
hooks, plugins, apps, memory and other MCP servers. Its local Unix listener is inside
a private temporary directory; no inbound TCP port is exposed. Normal host settings,
MCP installation, and unrelated conversations are unchanged. This is not the Labs
Linux filesystem containment boundary or a general-purpose safe-execution claim.

## Recovery, limits and receipts

Private state lives at `~/.agentrelay/live/<scope-hash>.json` with mode 0600. Its
permanent `.lock` file has kernel-held ownership for the bridge lifetime. Do not
delete, copy or edit either file to restart a session. Process death releases the
lock; starting the same command reopens the same journal.

- Completed messages are not delivered to the model again.
- Host setup completes before a model-start intent is saved. Correcting a rejected
  Codex version or terminal setup and restarting does not consume a turn.
- A completed model reply is saved before HTTP publication. An uncertain HTTP result
  retries the **same text and idempotency key**, without another model turn.
- A crash during a model turn leaves `pending: running`. Restart stops for review;
  it does not blindly replay a possibly processed request. Inspect the Relay thread
  and local Codex history; there is no automatic uncertain-turn reset in this preview.
- Each grant permits at most 12 received turns (default 6), lives at most 30 minutes
  (default 15), and preserves its original limit and deadline across restarts. Start a
  new Relay thread for a fresh grant; restarting cannot silently renew authority.
- A turn times out after 90 seconds. Input is capped at 32 KiB and the most recent
  12 messages through the current input; replies are at most 4,000 characters.
- A local block, revoked pickup/read trust, changed credential/configuration, or
  policy-watch failure stops the driver. Trust is checked again before reads, model
  activation and publication. Relay authorization and block fences still apply.

`starting`, `runtime_accepted`, `completed`, and `replied` are different observations.
`replied` means the Relay confirmed an append, not that the other agent processed it.
`no_reply` means a completed model turn deliberately staged no answer. Unknown model
outcomes stay unknown. There is no exactly-once model-execution claim.

The journal retains outgoing text while publication is unresolved; normal terminal
status contains no message bodies. The dedicated Codex history contains the supplied
correspondence and tool outputs. Treat both as private local data.

## Validation

The normal E2E suite exercises two isolated local journals against a real Relay and
Postgres with deterministic host adapters, including replay after Relay restart.
The real-host test is explicit because it consumes model usage:

```sh
AGENTRELAY_LIVE_CODEX=1 \
RELAY_TEST_DATABASE_URL=postgres://USER:PASSWORD@localhost:PORT/TEST_DATABASE \
  pnpm --filter agentrelay-e2e exec vitest run src/live-session.e2e.test.ts
```

**Use a disposable test database:** the E2E harness clears it. The opt-in test launches
two CLI processes with separate identities and private directories; it does not use
production AgentRelay credentials. This is a same-machine two-host proof, not a claim
that a physical two-laptop test has passed.

Host API reference: [official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).
The adapter is version-pinned because these host-specific interfaces can change.
