# Ambient Agent (v0.3) — Headless Answer Drafting

## What it is

When a question arrives for Frank and his CLI isn't open (and he isn't in a
live pair), the system can spawn a headless agent on Frank's box to *draft*
an answer. The drafted answer is queued for Frank's approval — never sent
automatically. When Frank returns, the notification reads:

> "Bob asked X. Your agent drafted answer Y. [Approve & send] [Edit] [Drop]."

This makes the system feel responsive without compromising trust.

## Why it's a v0.3, not v0.1 or v0.2

Three reasons to defer:

1. **Cost.** Every incoming question fires a paid LLM run, including spam,
   off-topic asks, or redundant repeats. v0.1 + v0.2 should prove the demand
   is real before we burn tokens on every inbox arrival.
2. **Trust.** Agents drafting on Frank's behalf, even for approval, is a
   credibility risk if the drafts are bad. Better to let humans see how good
   answers look (v0.1) before we automate drafting.
3. **Complexity.** Headless drafting needs:
   - A daemon that wakes on relay events
   - Repo state management (which branch, clean/dirty?)
   - Sandbox / read-only mode to prevent the headless agent from writing files
   - A reliable approval queue that survives reboots

## Architecture

```
Relay ──webhook──► Frank's tray daemon (background process)
                        │
                        │ on incoming read-only question
                        ▼
                   spawn: claude --print  (or codex exec)
                        │ flags: --read-only, --no-permissions, --max-turns 10
                        │ context: question + relevant repo files
                        ▼
                   draft answer
                        │
                        ▼
                   stored in approval queue
                        │
                        ▼
                   desktop notification:
                   "Bob asked X. Draft: Y. [Approve] [Edit] [Drop]"
```

## Required gating

Headless drafting only fires when ALL of these are true:

- Receiver has explicitly enabled `--auto-draft-readonly` in their MCP config
- The question is tagged `read_only: true` by the sender's agent (and the
  relay verifies the tag matches the content shape — no file edits requested)
- Receiver is offline (no live CLI session detected via heartbeat)
- Receiver hasn't hit a daily draft budget (default: 20 drafts/day, configurable)

If any condition fails, fall back to v0.1 mailbox behavior.

## The headless agent's restrictions

The spawned agent runs with:

- `--read-only` filesystem mode (no Write/Edit, only Read/Grep/Bash for
  read-only commands)
- `--max-turns 10` to bound runaway exploration
- `--no-network` except the relay endpoint (no random web fetches)
- A locked-down system prompt: "You are drafting an answer. You cannot edit
  files. You cannot run mutations. Your output will be reviewed by a human
  before sending."

## Smart routing (also v0.3)

Once the basics work, three modes of routing:

### Mode A — Explicit (already in v0.1)

`handoff_to_teammate(to: "frank", ...)` — sender names the recipient.

### Mode B — Role-based

`handoff_to_teammate(to_role: "frontend", ...)` — relay queries Agent Cards
where `role == "frontend"`. If one match, route. If multiple, pick by
last-active timestamp or round-robin.

### Mode C — Repo-aware (CODEOWNERS for agents)

Sender omits `to`. Relay inspects the artifact file paths and matches against
each Agent Card's `repos_owned` field. Like CODEOWNERS but the "owner" is an
agent endpoint, not a GitHub user.

## Desktop tray daemon

Tiny native app (Tauri/Rust or Swift on Mac, similar on Windows) that:

- Subscribes to the relay over SSE for incoming inbox + draft events
- Fires native notifications (macOS Notification Center, Windows Toast)
- Provides "Open in Claude Code" / "Open in Codex" deep-links that spawn
  `claude --resume <session>` pointed at the inbox or draft approval queue
- Shows current pair status (online, paired with whom, listener mode active)
- Can launch headless drafts when configured

## Open questions

- How does the headless agent decide what context to load? Naive answer: full
  repo + question. Better answer: an indexed embedding lookup over the repo
  to pick top-k relevant files.
- What happens if Frank approves a drafted answer that turns out to be wrong?
  The draft included its full reasoning chain — Bob's agent sees both the
  answer and that it was machine-drafted, can flag low confidence.
- Should the receiving human's "Edit" action open the draft in Claude Code so
  they can iterate? Yes — same deep-link pattern as the tray daemon.
- Do we ever auto-send without approval? Default: no. Could expose a
  `--yolo-auto-send-readonly` flag for trusted teammate pairs, off by default,
  warned heavily on enable.
