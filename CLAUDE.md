# AgentRelay — project rules for Claude Code teammates

## What this project is

AgentRelay is a cross-developer agent-to-agent communication system on the
A2A protocol. One MCP server (`@agentrelay/mcp`), one relay, two clients
(Claude Code + Codex CLI). Engineers' agents talk through the relay with
provenance-wrapped messages; humans approve writes via Claude Code's
permission system.

**Authoritative design docs (read first):**
- `docs/architecture.md` — system overview, components, the four-layer trust model
- `docs/hld.md` — high-level design, state machine, sequence diagrams
- `docs/lld.md` — every schema, every endpoint, every CLI command, every error code
- `docs/roadmap.md` — phase plan
- `docs/auto-mode.md`, `docs/ambient-agent.md` — future versions, not v0.1

If code disagrees with these docs, the docs win — flag the discrepancy via
SendMessage to the team lead instead of silently diverging.

## Stack (locked, do not substitute)

- **Runtime:** Node 20+ (engines field enforces this)
- **Package manager:** pnpm 9+ — never `npm`/`yarn`. Lockfile is `pnpm-lock.yaml`
- **Module system:** ESM only (`"type": "module"` everywhere). Relative imports include `.js` extension. No CommonJS.
- **TypeScript:** strict mode, `noUncheckedIndexedAccess`, `noImplicitOverride`, `isolatedModules`
- **Lint + format:** Biome (single tool, no ESLint, no Prettier)
- **Validation:** zod (every external input + every public function boundary)
- **Tests:** vitest (alongside source, `*.test.ts` files)
- **Logger:** pino (structured JSON)

### Relay-only
- **HTTP:** Hono (not Express, not Fastify)
- **DB:** Postgres 16
- **ORM + migrations:** Drizzle ORM + drizzle-kit
- **A2A:** the official `a2a-js` SDK (npm: `@a2a-js/sdk` or whatever the official package name resolves to — check before depending)

### MCP-server-only
- **MCP:** `@modelcontextprotocol/sdk`
- **Transport:** stdio
- **A2A client:** the same `a2a-js` SDK (relay's client side)

If you need a library that isn't already in `package.json`, **send a message to
the team lead before adding it.** No silent dependency expansion.

## Directory ownership (hard boundaries)

| Path                    | Owner                  |
| ----------------------- | ---------------------- |
| `relay/`                | `relay-builder`        |
| `mcp-server/`           | `mcp-builder`          |
| `docs/`, root files     | `team-lead` (the lead) |
| `examples/`             | `team-lead`            |

Teammates do not write outside their directory. Cross-cutting concerns
(shared types, root tooling) go through the lead via SendMessage.

## Code conventions

- **No `any`.** If you must, justify in a `// biome-ignore` comment with reasoning.
- **Validate at the edge.** Every HTTP handler validates input with zod. Every MCP tool validates input with zod. Internal functions can rely on types.
- **Idempotency keys** on every state-mutating relay endpoint (per `lld.md` §10).
- **Audit log every state mutation** in the relay (per `lld.md` §2.6, §11.1).
- **Provenance wrapping is non-optional** in the MCP server. Every inbound text payload from a teammate is wrapped with the Layer 1 preamble before being returned to the agent (per `architecture.md` §5.2).
- **No comments that restate the code.** Only comment WHY, when it's non-obvious.
- **Tests with code, not later.** A new module ships with its own `*.test.ts`.
- **Conventional Commits.** `feat(relay): add agent registry`. Lead handles all git operations — teammates do not run `git commit` / `git push`.

## Trust model is load-bearing

The four layers in `architecture.md` §5 are not optional:

1. **L1 — Provenance wrapping** (mcp-server)
2. **L2 — Permission overlay in Claude Code/Codex settings** (mcp-server's `agentrelay install` writes this)
3. **L3 — `~/.agentrelay/trust.yaml`** (mcp-server reads + applies)
4. **L4 — Audit log + `agentrelay block`** (both relay and mcp-server)

If you skip a layer, the security guarantee evaporates. Implement all four.

## Communication protocol within the team

- **Idle is normal**, not a bug. After each turn, you go idle. The lead messages you when there's new work.
- **Use SendMessage, not terminal output**, when responding to teammates. Plain text in your turn is invisible to other agents.
- **Refer to teammates by name** (`relay-builder`, `mcp-builder`, `team-lead`), never by UUID.
- **Plain text only** in SendMessage — no JSON status objects. Use TaskUpdate to mark progress.
- **Check TaskList after completing each task** — newly unblocked work may be available.
- **Prefer tasks in ID order** when multiple are open. Earlier tasks usually set up context.
- **If blocked, message the lead with specifics.** Don't silently stall.

## How to handle disagreement with the docs

If you think the docs are wrong (a schema choice, an API shape, an error code,
a tool signature) — **don't silently change your implementation.** Send a
message to the team lead with: (a) what the doc says, (b) what you'd prefer,
(c) why. Lead decides; lead updates the doc; you implement to the new spec.

## What you don't need to ask about

- Imports, types, naming inside your own files — use your judgement
- Folder structure inside your subpackage's `src/` — keep it sensible
- Test cases to write — cover happy path + obvious failure modes
- Refactoring for clarity — fine, just don't change behaviour without flagging

## Build and test commands

From repo root:
- `pnpm install` — installs all subpackage deps via workspaces
- `pnpm -r build` — builds everything
- `pnpm -r test` — runs all tests
- `pnpm lint` — Biome lint across the repo
- `pnpm format` — Biome format-write
- `pnpm typecheck` — `tsc --noEmit` per subpackage
- `docker compose up -d` — local Postgres on port 5433

Per-subpackage commands run via `pnpm --filter <name> <script>`.
