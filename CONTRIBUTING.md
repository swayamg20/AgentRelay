# Contributing to AgentRelay

AgentRelay is an early open-source project. Small, well-understood changes are more
valuable than broad rewrites or speculative framework work.

If you use a coding agent, give it [`AGENTS.md`](AGENTS.md). Claude Code also reads
[`CLAUDE.md`](CLAUDE.md).

## Development setup

Requires Node 20+, pnpm 9+, Docker, and Git. CI tests Node 20 and 22.

```bash
git clone https://github.com/swayamg20/AgentRelay
cd AgentRelay
pnpm install
docker compose up -d
```

Plain `docker compose up -d` starts Postgres on port 5433. Run migrations and the
relay on the host so source changes are easy to inspect:

```bash
RELAY_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay \
  pnpm --filter relay db:migrate
```

To start the full relay, provide the required values documented in `.env.example`
and [`relay/src/config.ts`](relay/src/config.ts), then run:

```bash
pnpm --filter relay dev
```

Start the stdio MCP server during local client work with:

```bash
pnpm --filter agentrelay-mcp dev
```

## Repository layout

```text
relay/          Hono + Drizzle + Postgres relay
mcp-server/     agentrelay-mcp package and agentrelay CLI
tests/e2e/      real relay plus two MCP processes
landing/        static GitHub Pages site
docs/           current design, operations, roadmap, and RFCs
```

There is no local Node package yet. Its accepted target is
[`docs/rfcs/001-agentrelay-node-and-missions.md`](docs/rfcs/001-agentrelay-node-and-missions.md).

## Understand the contract first

Before editing, trace the behavior through its producer, consumer, schema, and tests.
For cross-package work, inspect both `relay/` and `mcp-server/`.

- [`docs/architecture.md`](docs/architecture.md) defines current and target boundaries.
- [`docs/hld.md`](docs/hld.md) describes the shipped mailbox flow.
- [`docs/lld.md`](docs/lld.md) lists current routes, tables, tools, and known gaps.
- Accepted RFCs define target behavior until implementation lands.

Code and tests are the source of truth for shipped behavior. If a document disagrees,
fix or flag the documentation; do not silently build on an imaginary contract.

## Implementation principles

- Make the smallest coherent change that solves the issue.
- Keep code direct, readable, and boring where possible.
- Do not add speculative abstractions, unrelated cleanup, or unused configuration.
- Preserve public HTTP, JSON-RPC, MCP, CLI, database, and config contracts unless the
  change explicitly reopens them.
- Add a dependency only when existing code and platform APIs cannot solve the need.
- Comment constraints and non-obvious reasons, not line-by-line behavior.
- Keep tests beside source as `*.test.ts` unless the test is truly cross-package.

## Code conventions

- pnpm only; do not use npm or yarn in the repository.
- TypeScript strict mode, ESM-only, and `.js` on relative imports.
- Avoid `any`; narrow unknown input at the boundary.
- Validate HTTP, JSON-RPC, MCP, CLI, and config inputs with Zod.
- Relay routes use Hono; database work uses Drizzle and Postgres.
- Formatting and linting use Biome, not ESLint or Prettier.
- Biome uses tabs, double quotes, semicolons, trailing commas, and 100-column lines.

## Security invariants

Peer messages and artifacts are untrusted input.

- Preserve bearer authentication, participant authorization, block checks, and
  lifecycle-transition ownership.
- State-changing operations need an idempotency strategy and transactionally
  consistent audit behavior.
- Provenance-wrap every teammate-originated text-bearing field, including fields
  inside typed artifacts, before returning it to a local model host. Preserve the
  artifact structure.
- Never log API keys, invite tokens, webhook URLs, secrets, or sensitive message
  bodies.
- Do not treat prompts or returned policy JSON as enforcement. Security decisions
  that matter must be applied outside the model.
- A remote participant must not choose local paths, command policy, sandbox,
  permissions, credentials, or budgets.

The existing trust model has known gaps documented in `docs/lld.md`. A contribution
must not claim those gaps are closed without an end-to-end test.

## Test tiers

Fast static gates:

```bash
pnpm lint
pnpm -r typecheck
pnpm -r build
```

Database-free package tests, matching CI's unit job:

```bash
pnpm --filter relay --filter agentrelay-mcp test
```

Focused iteration:

```bash
pnpm --filter relay exec vitest run src/path/file.test.ts
pnpm --filter agentrelay-mcp exec vitest run src/path/file.test.ts
```

Relay integration tests require a migrated Postgres database:

```bash
docker compose up -d
RELAY_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay \
  pnpm --filter relay db:migrate
RELAY_TEST_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay \
  pnpm --filter relay test:integration
```

The integration runner executes database test files sequentially and truncates tables
between files. Do not parallelize it without replacing that isolation contract.

End-to-end tests:

```bash
RELAY_TEST_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay \
  pnpm --filter agentrelay-e2e test
```

`pnpm -r test` includes `agentrelay-e2e`, so it is not a database-free unit command.
For docs-only changes, run at least `git diff --check` and check local links.

## Pull requests

- Branch from current `main` and keep one concern per PR.
- Use Conventional Commits, for example `fix(relay): preserve message payload`.
- Explain why the change is needed and which contract it affects.
- Include tests with behavior changes.
- Update documentation when a route, schema, tool, security boundary, or operational
  command changes.
- Do not mix unrelated refactoring into a product or bug-fix PR.

Open PRs against `main`. Report security issues privately to the maintainer rather
than opening a public issue.

## License

Contributions are licensed under the repository's [MIT license](LICENSE).
