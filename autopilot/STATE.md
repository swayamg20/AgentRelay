# Autopilot state

Working memory. Rewrite this file at the end of each session.

## Goal as understood

The original goal is unchanged: propose three eligible small core-mailbox issues,
then implement only the owner's selection with passing checks. The proposal is
complete. On October 25, 2026 at 22:44:52 UTC, the owner selected **#11: doctor
failure exit codes** in the reply to #154. That authorizes #11 only, not a Node
security fix or an exception to mandatory checks.

## Plan

- [x] Inspect the eligible issue snapshot, code, tests, design sources, and history.
- [x] Submit three candidates (#11, #40, #34), recommending #11.
- [x] Accept the owner's #11 selection; record #154 as resolved in workflow output.
- [x] Reinspect current status, implementation, callers, and validation guidance.
- [x] Recheck the database-free full unit baseline before making product changes.
- [x] Ask the owner to unblock the still-failing Node baseline through a corrected
      runner or separately scoped resolution; do not alter security or skip tests.
- [ ] Obtain a passing unchanged full unit baseline or an approved prerequisite fix.
- [ ] Implement #11, add built-CLI regression coverage, and document exit statuses.
- [ ] Run the focused CLI tests and all mandatory static/build/unit gates.
- [ ] Commit the verified implementation, then refresh run memory.

## Next step

Read the owner inbox for the response to
`questions/doctor-unit-baseline-blocker.md`. Resume #11 only when the mandatory
full unit gate can pass without weakening unrelated security or hiding failures.
Do not ask the owner to select an issue again: #11 is already approved.

The small implementation is clear: after the ordinary doctor action prints its
human or JSON report, set `process.exitCode = 1` when `doctorHasMissing(report)`
is true. Preserve `DoctorReport` and the existing `--fix` behavior. Add built-CLI
tests using an isolated temporary home and asynchronous child execution against a
local HTTP fixture for missing config, unavailable Relay, rejected key, and healthy
setup in both modes, plus existing fix success/failure behavior. Build first so
`describeIfBuilt` cannot silently skip the tests. Document the exit contract in
`mcp-server/README.md` and `docs/lld.md`, the public JSON-option documentation sites.

## Waiting on owner

- Unblock the pre-existing full unit failure through a baseline-green execution
  environment or a separately scoped Node mount-metadata resolution. The question
  explains both options and recommends correcting the runner first. This run stops
  because committing #11 requires checks that the unchanged checkout cannot pass.
- No issue-selection decision remains outstanding. #154 is resolved by the reply.

## Learned about this repository

- Session 40241657270 started on clean `autopilot` at `cf293e1`. History includes
  `de00e37` / #155, which scopes database variables to integration runs. The owner
  fixed the Relay collision problem, not the independent Node mount failure.
- Before any edits, the canonical unit command with both database variables unset
  passed protocol (125 tests), MCP (248 tests), and Relay (77 tests). Node failed
  16 tests, passed 422, and skipped 3. Eight failures are in
  `containment-read-tree.test.ts`, eight in `mission-workspace.test.ts`.
- Their cause is `Linux mount metadata was malformed` from
  `node/src/linux-mounts.ts:42`; workspace admission maps it to
  `workspace_mounts_unsupported`. These reproduce the previous run's failures.
  No Node, workflow, product, or test files changed. Do not bypass the fail-closed
  mount/storage checks or infer Node-fix scope from the selected mailbox issue.
- Doctor's ordinary action prints its report without evaluating
  `doctorHasMissing`; the fix branch already evaluates the after-report. The
  existing predicate includes missing config, MCP entries, overlays, trust,
  unreachable Relay, and rejected credentials. No new diagnostic is needed.
- The whoami consumer uses authenticated `GET /agents/me`; any 2xx is success.
  The Relay producer supplies the self-agent JSON response. No Relay or protocol
  contract, schema, or database mutation is needed for #11.
- Client configuration paths use `HOME`; credential/trust paths also have
  AgentRelay overrides. CLI fixtures must isolate both rather than reading or
  installing into the runner's real home. A synchronous child would block a local
  HTTP fixture on the test process's event loop; use asynchronous execution.
- Unit invocations must not set either database URL. Use
  `env -u RELAY_TEST_DATABASE_URL -u RELAY_DATABASE_URL` in that subprocess only
  if inherited variables exist. Use the separate sequential integration runner
  only for applicable Relay changes; never `pnpm -r test`.
- This run's `pnpm lint`, `pnpm -r typecheck`, and `pnpm -r build` passed.
  Lint retains four existing Relay unused-suppression warnings. After building,
  the focused existing MCP CLI/command suite passed all 44 tests. These are baseline
  results, not evidence of an implemented #11 fix. No Relay integration rerun was
  needed because no Relay or other product code changed.
- Only this memory file and `JOURNAL.md` change in the repository. The owner
  question, resolution marker, logs, summary, and STOP stay in workflow output.
  No implementation was attempted or retained while the required gate was red.
