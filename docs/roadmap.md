# Roadmap

AgentRelay: cross-developer agent-to-agent communication. The protocol is
horizontal (any team's agents can plug in via A2A), the first product surface
is engineering-vertical (Claude Code + Codex CLI, code-flavored artifacts).
Horizontal expansion to other functions is a v2.0+ direction, not v1.

One MCP server, two clients (Claude Code + Codex CLI), one A2A-compliant relay.

---

## Distribution & success criteria

- **Open-source launch** (MIT license, public GitHub, npm + PyPI packages).
- **First adopters: dogfood at Travenues / ixigo internally** — the team is the
  honest-feedback loop. No paid tier, no hosted service in v1.
- **Polish bar:** a stranger on the internet can run `npx agentrelay-mcp` and
  `docker compose up` and have a working two-laptop demo within 5 minutes.
- **Each release ships with a launch demo video and a blog post** (90-second
  screen recording, two-terminal split-screen).

## Pacing model

We don't think in weeks — Claude Code and Codex do the typing, the human
debugs integration friction. We think in **phases**, each ending with a
shippable artifact: a tagged release, a demo video, a blog post.

## Phase 0 — Scaffolding (one focused session)

Foundation work before any feature lands. No release.

- Repo layout (`relay/`, `mcp-server/`, `examples/`, `docs/`)
- Postgres + Alembic migration baseline (v0.1 schema)
- A2A test compatibility kit hooked into CI
- API key auth + admin endpoints
- `agentrelay register` and `agentrelay install` working end-to-end against a
  local relay
- Provenance-wrapping helper in MCP server (used by every inbound tool result)

Exit criteria: two devs on two laptops can both register against a local
relay and call `list_teammates()` and see each other.

## Phase 1 — v0.1: Async Mailbox (the launch)

The base case: agents talk through a persistent inbox, humans approve at the
permission layer (not per-message).

**Demo (b) — clarification dance.** Bob hands off API contract, Frank's
agent reads it, spots a gap, sends a Q to Bob's agent via `send_message`,
Bob's agent answers from his repo, Frank's agent finishes the plan, Frank
ships. Two terminals + Slack DMs in the screen recording. ~90 seconds.

Features:
- A2A-compliant relay (LF A2A spec, JSON-RPC over HTTPS)
- Agent Card registry at `/.well-known/agent-card.json?id=<handle>`
- MCP server (`agentrelay-mcp`) on Claude Code and Codex CLI
- Six tools: `handoff_to_teammate`, `check_inbox`, `accept_handoff`,
  `send_message`, `complete_handoff`, `list_teammates`
- Routing: explicit only (`to: "frank"`)
- Notification: Slack DM webhook
- **Trust model layers 1–4 fully wired** (provenance wrapping, recommended
  Claude Code permission config, `~/.agentrelay/trust.yaml`, audit log)
- CLI: `agentrelay register/install/rotate-key/doctor/audit/block`
- `intent: "inform" | "ask_question"` on handoffs (no proposed_action yet)

Exit criteria: the demo (b) script runs end-to-end on two real laptops, no
manual hand-holding. Tagged `v0.1.0`, demo video published.

## Phase 1.5 — v0.1.5: Propose Action (small follow-up release)

Adds the third intent — Bob's agent can ask Frank's agent to make a
*specific change* in Frank's codebase. Frank's agent drafts the diff,
queues it for Frank's approval. This is the first cross-codebase
delegation primitive; it's small enough to ship as a patch release rather
than a major version.

Features:
- `intent: "propose_action"` on handoffs
- New schema: `handoffs.proposed_action` JSONB column
- New MCP tool: `draft_proposed_action(thread_id)` — receiver-side, returns
  the agent's drafted diff for human approval
- Receiver UX: drafted diff surfaces with provenance (*"Bob asked me to do
  X. Drafted Y. Approve to apply?"*) routed through Claude Code's existing
  permission flow

No new demo video — this is a feature update post on the v0.1 blog.

Exit criteria: Bob's agent can request a small refactor in Frank's repo,
Frank's agent drafts the diff, Frank approves, change lands. Tagged `v0.1.5`.

## Phase 2 — v0.2: Auto Mode (live channel)

Pairing protocol for synchronous, RPC-shaped agent conversations when both
developers are online and opted in. See [auto-mode.md](./auto-mode.md).

**Demo (c) — live pair.** Bob asks Frank's agent a question mid-flow,
answer streams back in seconds. Never opens Slack. ~60-second video.

Features:
- `/pair <handle>` and `/unpair` slash commands
- Presence heartbeat from each MCP server to relay
- Long-poll endpoint on relay (SSE)
- New tools: `ask_teammate`, `wait_for_teammate_message`, `reply_to_teammate`
- Listener-mode session: dedicated agent session that long-polls and
  auto-answers questions from paired teammate
- Stop-hook integration for non-listener pickup
- Auto-fallback to async mailbox if peer goes offline mid-call

Exit criteria: demo (c) script runs end-to-end. Tagged `v0.2.0`, demo video
published.

## Phase 3 — v0.3: Ambient Agent

Headless answer generation for read-only questions, queued for human
approval. See [ambient-agent.md](./ambient-agent.md).

Features:
- Headless drafting via `claude --print` / `codex exec` on the receiver's box
- Auto-respond flag (off by default) for read-only questions
- Drafted answers always queued for human approval, never auto-sent
- Desktop tray daemon (macOS/Windows) for native notifications + "Open in
  CLI" deep-link
- Smart routing: role-based (Mode B), repo-aware via CODEOWNERS-style
  mapping (Mode C)

No demo until features prove themselves; v0.3 is more about back-end
robustness than user-facing wow.

## Phase 4 — v1.0: The Case Study

The "we use this every day" moment. Not a feature release — a positioning
release.

**Demo (d) — cross-stack feature ship.** Bob (backend) → Frank (web) →
Mike (mobile), three sequential handoffs, one feature ships in an
afternoon. Real internal team, real shipped code. Long-form blog post,
not a 90-second video.

Exit criteria: at least one real feature shipped through the full handoff
chain at Travenues / ixigo, with screenshots and metrics. Tagged `v1.0.0`.

## Beyond v1.0 — Horizontal expansion

The protocol was always horizontal; v1.0+ surfaces that publicly.

- **Generic artifact types** (not just code-flavored — spreadsheets, CMS
  drafts, design files)
- **Non-engineering MCP server packages** (finance, ops, marketing) with
  vertical-specific tools
- **Possibly hosted version** with multi-tenancy, billing, SSO
- **Federation** (multiple relays talking to each other across orgs)

These are directional, not committed. The OSS protocol is the load-bearing
piece; whether AgentRelay-the-org commercializes anything is a v1.0+
conversation.

## Non-goals (explicitly out of scope for v1)

- Real-time co-editing (this is not a Liveblocks competitor)
- Replacing Slack/Linear (notifications go through them, not against them)
- Multi-org federation (single team/org per relay until v1.0+)
- LLM-judged routing ("which teammate is the best fit?") — too
  hallucination-prone
- Auto-merge / auto-PR creation by the receiving agent
- Solving prompt injection (we mitigate via the trust model; the industry
  hasn't solved it and we don't claim to)
