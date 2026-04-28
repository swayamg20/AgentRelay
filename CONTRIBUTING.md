# Contributing to AgentRelay

Thanks for considering a contribution. AgentRelay is an OSS project under
active development; the codebase is small enough that a careful PR can move
the project meaningfully.

If you're using Claude Code or Codex CLI to help, also read
[`CLAUDE.md`](CLAUDE.md) — it documents the project rules in a form your
agent will pick up automatically.

---

## Quick development setup

Requires **Node 20+**, **pnpm 9+**, **Docker**.

```bash
git clone https://github.com/swayamg20/AgentRelay
cd AgentRelay
pnpm install                          # one workspace for both packages
docker compose up -d                  # local Postgres on :5433 (relay runs on host)
```

> **Note:** plain `docker compose up -d` brings up *only* Postgres — the
> dev mode. Run the relay on your host (`pnpm --filter relay dev`) so
> source changes hot-reload. Self-hosters use `--profile selfhost`,
> which builds and runs the relay container too — but for contributing,
> stay on the host-relay path.

Run unit tests anytime (no DB needed):

```bash
pnpm -r test
```

Run integration tests against live Postgres:

```bash
RELAY_TEST_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay \
  pnpm --filter relay test:integration
```

Iterate on the relay:

```bash
pnpm --filter relay dev               # tsx-watched, restarts on save
```

Iterate on the MCP server:

```bash
pnpm --filter agentrelay-mcp dev      # stdio MCP server, points at $AGENTRELAY_CONFIG_PATH
```

## Repository layout

```
relay/                ← Hono + Drizzle + Postgres relay
mcp-server/           ← agentrelay-mcp (the npm package)
docs/                 ← canonical design docs (start here for any non-trivial change)
docker-compose.yml    ← local Postgres
```

Two packages under one pnpm workspace. Source of truth for the contract
between them lives in [`docs/lld.md`](docs/lld.md).

## Code conventions

- **TypeScript strict.** No `any` without a `// biome-ignore` comment
  explaining why. `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `isolatedModules` all on.
- **ESM only** (`"type": "module"`). Relative imports include `.js`
  extension. No CommonJS.
- **pnpm only.** Never `npm install` / `yarn add` inside the repo.
  Lockfile is `pnpm-lock.yaml`.
- **Validation at the edge.** Every HTTP handler validates with [zod](https://zod.dev).
  Every MCP tool validates input with zod. Internal functions can rely on
  TypeScript types.
- **Lint + format with [Biome](https://biomejs.dev).** No ESLint, no
  Prettier. `pnpm lint` and `pnpm format` from the root.
- **Tests with code, not later.** Each new module ships with a
  `*.test.ts` next to it.

## Testing workflow

```bash
pnpm -r typecheck                     # tsc --noEmit, fast
pnpm -r test                          # unit, no DB
RELAY_TEST_DATABASE_URL=… \
  pnpm --filter relay test:integration  # full integration, needs Postgres
pnpm lint                             # Biome check
```

CI runs all of the above on every PR.

If you're adding a relay-side feature that touches Postgres, prefer
**per-file integration tests** (we run them via a shell loop in
`relay/scripts/test-integration.sh`) over a single big suite — vitest's
shared-DB story has rough edges that the loop sidesteps.

## Trust model invariants — please read before touching

[`docs/architecture.md` §5](docs/architecture.md) describes a four-layer
trust model. **All four are load-bearing.** If your PR touches any of these
surfaces, please understand why before modifying:

- **L1 — Provenance wrapping** (`mcp-server/src/provenance.ts`): every text
  field originating from a teammate gets wrapped with
  `[INBOUND HANDOFF FROM <handle> via AgentRelay]` before reaching the
  agent. There must be no path that returns un-wrapped teammate content.
- **L2 — Permission overlay** (`mcp-server/src/cli/install.ts`): the
  `RECOMMENDED_PERMISSIONS` constants are deliberate. `git push`,
  `npm publish`, `aws`, `kubectl`, `curl` are denied. Don't loosen these
  without a specific user-facing reason.
- **L3 — `trust.yaml`** (`mcp-server/src/trust.ts`): the precedence order
  is `blocked` → listed teammate → unknown policy → defaults. Don't
  reorder.
- **L4 — Audit + revocation** (`relay/src/services/audit.ts`,
  `agent_blocks` table): every state-changing relay endpoint writes an
  audit row in the same DB transaction as the mutation. Never decouple
  these.

If you find one of these properties is structurally unenforceable in the
code as written, that's a bug worth filing.

## Sending a PR

1. **Fork + branch.** `feat/short-thing-name` or `fix/short-thing-name`.
2. **Conventional commits.** `feat(relay): add agent registry`,
   `fix(mcp): trust.yaml glob matcher off-by-one`. Body explains *why*,
   not what.
3. **Tests with code.** Don't ship a feature without tests.
4. **Update docs if you change a contract.** `docs/lld.md` is the contract.
5. **One concern per PR.** A test isolation fix and a new tool surface
   should land separately so reviewers can reason about each.

Open the PR against `main`. CI will run the test suite. A maintainer will
read it and either merge or comment.

## Reporting issues

[github.com/swayamg20/AgentRelay/issues](https://github.com/swayamg20/AgentRelay/issues).
For bug reports, please include:

- Output of `npx agentrelay-mcp doctor` (redact your `relay_url` and
  `api_key` if sharing publicly)
- Relay logs (`RELAY_LOG_LEVEL=debug pnpm --filter relay dev`) at the time
  of the bug
- Reproduction steps from a clean state (`docker compose down -v &&
  docker compose up -d` resets Postgres)

For security issues — do **not** open a public issue. Email the maintainer
listed on the GitHub profile.

## Recognition

Contributors who land non-trivial PRs get added to a `CONTRIBUTORS` section
in the v1.0 release notes. The point is to give a real, public credit
trail — OSS work is real work.

## License

By contributing, you agree your contributions will be licensed under the
project's [MIT license](LICENSE).
