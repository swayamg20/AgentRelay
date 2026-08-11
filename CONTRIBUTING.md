# Contributing to AgentRelay

AgentRelay is an early open-source project. Small, well-understood changes are more
valuable than broad rewrites or speculative framework work.

If you use a coding agent, give it [`AGENTS.md`](AGENTS.md). Claude Code also reads
[`CLAUDE.md`](CLAUDE.md).

By participating, you agree to follow the project
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## Choose and coordinate work

Search the open issues and pull requests before starting so two contributors do not
solve the same problem.

Use the [AgentRelay Discord community](https://discord.gg/PHcB9qsS2) for questions and
early design discussion. GitHub issues remain the source of truth for approved scope
and ownership; a Discord conversation does not reserve an issue.

- An issue labeled `ideas` is a proposal for discussion, not approved or scoped work.
- Issues labeled `good first issue` or `help wanted` have maintainer-approved scope and
  are ready for contributors to claim.
- For any non-trivial change, comment on the issue with your intended scope and wait
  for a maintainer to confirm it. An assignment or explicit maintainer reply is the
  claim; an expression of interest alone does not reserve an issue indefinitely.
- If no issue covers the change, open one before investing in a large implementation.
  Small, obvious documentation or typo fixes may go directly to a pull request.
- Link your pull request from the issue as soon as it is open. Report suspected
  vulnerabilities privately through [`SECURITY.md`](SECURITY.md).

## Development setup

Requires Git, Docker, Node 20.18.1+, and pnpm 9+. The repository-selected toolchain is
Node 22 from `.nvmrc` and pnpm 9.15.0 from `package.json`; CI also checks the minimum
supported Node 20 line.

Fork the repository on GitHub, then clone your fork and register the main repository
as `upstream`:

```bash
git clone https://github.com/YOUR_GITHUB_HANDLE/AgentRelay.git
cd AgentRelay
git remote add upstream https://github.com/swayamg20/AgentRelay.git
git fetch upstream
git switch -c fix/short-description upstream/main
```

Install the repository-selected Node and pnpm versions, then install the locked
dependencies:

```bash
nvm install
nvm use
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm install --frozen-lockfile
```

For local development, copy the safe development defaults, export them into the
current shell, start Postgres on port 5433, and migrate it:

```bash
cp .env.example .env
set -a
. ./.env
set +a
pnpm db:up
pnpm --filter relay db:migrate
pnpm --filter relay dev
```

Do not reuse the values in `.env.example` in a public or production deployment. The
full configuration contract is documented in `.env.example` and
[`relay/src/config.ts`](relay/src/config.ts).

Start the stdio MCP server in another terminal during local client work with:

```bash
pnpm --filter agentrelay-mcp dev
```

## Repository layout

```text
protocol/       Mission contracts, coordinator, test fixtures, and runtime adapters
relay/          Hono + Drizzle + Postgres relay
mcp-server/     agentrelay-mcp package and agentrelay CLI
node/           foreground Node, local policy, journal, and fake Mission Capsules
tests/e2e/      real relay, MCP, Node, and detached-Capsule process harnesses
landing/        static GitHub Pages site
docs/           current design, operations, roadmap, and RFCs
```

The Node package currently proves one fake-adapter turn with durable local journaling,
in-process runner reconstruction, and recovery from a killed Node through a detached
Mission Capsule. The Capsule is Unix-only and still hosts a deterministic fake; the
real-runtime target remains
[`docs/rfcs/001-agentrelay-node-and-missions.md`](docs/rfcs/001-agentrelay-node-and-missions.md).

## Understand the contract first

Before editing, trace the behavior through its producer, consumer, schema, and tests.
For cross-package work, inspect `protocol/`, `relay/`, `mcp-server/`, and `node/`
wherever the contract crosses those boundaries.

- [`docs/architecture.md`](docs/architecture.md) defines current and target boundaries.
- [`docs/hld.md`](docs/hld.md) describes the shipped mailbox and Relay control-plane
  flow.
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
- Keep agent and Node bearer credentials type-separated. A Node credential must not
  authenticate `/agents` or `/a2a`, and an agent key must not authenticate `/node/v1`.
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

The repository pins recursive workspace concurrency to one because the Relay and Node
package hooks both materialize `protocol/dist`; parallel writers can expose a partial
build to a clean-checkout consumer.

Database-free package tests, matching CI's unit job:

```bash
pnpm --filter @agentrelay/protocol --filter relay --filter agentrelay-mcp \
  --filter agentrelay-node test
```

Focused iteration:

```bash
pnpm --filter @agentrelay/protocol exec vitest run src/path/file.test.ts
pnpm --filter relay exec vitest run src/path/file.test.ts
pnpm --filter agentrelay-mcp exec vitest run src/path/file.test.ts
pnpm --filter agentrelay-node exec vitest run src/path/file.test.ts
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

Open PRs against `main`, or against the explicit prerequisite branch when recording a
short-lived stacked change. Report security issues through the private process in
[`SECURITY.md`](SECURITY.md), not through a public issue.

## License

Contributions are licensed under the repository's [MIT license](LICENSE).
