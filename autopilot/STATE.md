# Autopilot state

Working memory. The agent rewrites this file at the end of every session. It must
describe where the work stands well enough for a fresh session to continue.

## Goal as understood

Select three small, verifiable implementation candidates from open `core-mailbox`
issues, excluding `labs`, `demand-gated`, and epics. Present plans, touched files,
verification commands, and a recommendation to the owner. Implement nothing until
the owner chooses; then implement the chosen issue with passing checks.

## Plan

- [x] Read the goal, recent history, repository instructions, and validation guidance.
- [x] Obtain the workflow's read-only issue snapshot; the previous input blocker is resolved.
- [x] Exclude Labs, demand-gated work, and epics; inspect candidate code, callers,
      consumers, and nearby tests against the relevant design sources.
- [x] Propose the three best one-run candidates with plans, files, checks, and a
      recommendation through the workflow question output.
- [x] Run baseline static, unit, focused MCP, and sequential Relay integration checks;
      document the existing Node host-mount failures without changing product code.
- [ ] Wait for the owner's selection, then implement and verify only that issue.
- [ ] Recheck the Node baseline in the selected implementation's runner; obtain an
      owner decision if unrelated failures still prevent the required full unit gate.
- [ ] Commit the implementation and refresh run memory.

## Next step

Read the owner inbox for a selection on
`questions/choose-first-core-mailbox-issue.md` in the run output. The candidates are
#11 (recommended: doctor exit codes), #40 (safe Markdown thread export), and #34
(tested Compose backup/restore runbook). The question contains inspected contracts,
plans, files, exact verification commands, exclusions, and the baseline caveat.
Do not implement before selection, call GitHub, or infer new scope from design gaps.

After selection, inspect fresh status/history and applicable instructions. Recheck
the Node test baseline in that runner. If it still fails, ask the owner how to
resolve the environment or separately scope the baseline problem; do not weaken
Labs security or skip tests to obtain an implementation commit. This run stops
because the next product action depends on owner selection.

## Waiting on owner

- Choose #11, #40, or #34 through the generated workflow question. No owner reply
  or selection is present in this session.
- The proposal flags the full unit gate's existing Node host-mount failure. A
  selected implementation needs a runner where the baseline passes or a separate
  owner-approved resolution; no Labs changes are authorized by this mailbox goal.

## Learned about this repository

- The owner goal has not changed. History at session start ends at `1f0120f`;
  `e6afe6a` supplies issue snapshots and aligns documented CI commands. This supersedes
  the prior memory's missing-inventory assumption. The branch is `autopilot`, and
  the initial working tree was clean. No implementation changed in this session.
- Eligible scoped small issues are #11, #40, and #34, all `help wanted`. #111 is a
  larger filter/pagination contract. #103 needs a coverage audit; #10 and #39 are
  ideas with policy/contract questions; #44 is broad with a demand-gated metrics
  dependency; #8 needs real two-owner evidence. Labs, demand-gated, and epics are excluded.
- Doctor's ordinary CLI branch never checks `doctorHasMissing`; `--fix` already
  does. `commands.test.ts` covers the predicate but not ordinary CLI exit wiring.
  `agentrelay-cli.test.ts` runs a built binary and self-skips without a build.
- `viewThread` preserves teammate provenance and strips Relay-owned metadata.
  Relay `tasks/get` returns `created_at`, but that field is absent from the validated
  MCP result. Export should retain that existing field, not add a Relay route.
  `writeSecretFile` overwrites via rename; export needs exclusive creation instead.
- Compose's services are `postgres` and `relay`, its database/user are `agentrelay`,
  and its volume is `postgres-data`. Fixed container names/ports need isolation for
  disposable selfhost validation. Docker's daemon and Postgres dump/restore tools
  are available; no restore was attempted before issue selection.
- Relay roster dispatch ignores params, although the MCP client already sends
  filters. Its filter-support comment disagrees with code; `docs/lld.md` is truthful.
- Baseline `pnpm lint`, `pnpm -r typecheck`, and `pnpm -r build` pass. Lint has four
  existing unused-suppression warnings in Relay tests. Focused MCP CLI/tool tests
  pass (64 tests); sequential Relay integration passes (180 tests).
- The job exports database connection variables. Run the canonical database-free
  unit command with `env -u RELAY_TEST_DATABASE_URL -u RELAY_DATABASE_URL` in that
  subprocess only. Otherwise Relay Vitest runs database files concurrently against
  shared tables; the initial baseline had 97 collision/deadlock failures. The proper
  sequential integration runner passes with the original job environment.
- The database-free unit rerun passes protocol, MCP, and Relay but fails 16 existing
  Node tests in `containment-read-tree.test.ts` and `mission-workspace.test.ts` with
  `Linux mount metadata was malformed` / `workspace_mounts_unsupported`. This is
  an unchanged runner/baseline issue, not authority to modify Labs containment.
- Only `STATE.md` and `JOURNAL.md` change in the repository. The proposal, summary,
  and STOP output stay outside it. Docs-only memory checks are lint, diff whitespace,
  and local links; no product failure was introduced or retained by this change.
