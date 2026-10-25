# Autopilot state

Working memory. Rewrite this file at the end of each session.

## Goal as understood

The owner-controlled goal is unchanged and complete: propose three eligible small
core-mailbox issues, then implement the owner's selection with passing checks.
The proposal listed #11, #40, and #34. The owner selected **#11: doctor failure
exit codes** on October 25, 2026 at 22:44:52 UTC. Commit `119d756` implements only
that selection, with regression tests and exit-status documentation.

## Plan

- [x] Inspect the issue snapshot, implementation, callers, tests, and design sources.
- [x] Propose three candidates and obtain the owner's #11 selection (#154).
- [x] Ask for correction of the pre-existing mandatory unit baseline (#157).
- [x] Confirm the corrected runner passes the unchanged database-free unit gate.
- [x] Implement #11 using the existing doctorHasMissing predicate after output.
- [x] Add built-CLI regressions for human and JSON modes, including preserved fix behavior.
- [x] Document the exit contract wherever doctor --json is documented.
- [x] Run focused tests and all mandatory lint/typecheck/build/unit gates successfully.
- [x] Commit the verified implementation and refresh run memory.

## Next step

Stop this run. The current goal is complete; wait for the owner to review the draft
pull request and set a new goal. Do not implement #40, #34, or other backlog issues
without a new owner-controlled goal or explicit selection.

## Waiting on owner

None for this goal. Selection question #154 was resolved in the previous run.
The reply to #157 chose the recommended corrected-runner path. Native Postgres
setup landed in `75b478f` / #158 before this session; the unchanged full unit gate
now passes. Marked #157 resolved in workflow output. No security waiver or Node
change was needed.

## Learned about this repository

- Session 40243414124 began on clean autopilot at `6660759`, which includes the
  owner's native-Postgres runner correction. Baseline Node now passes all 438
  enabled tests, including the 16 previously failing host-mount cases.
- Ordinary doctor now sets process.exitCode to 1 after printing when
  doctorHasMissing(report) is true. Healthy reports still exit 0. The predicate,
  DoctorReport fields, remediation behavior, and fix branch are unchanged.
- The whoami consumer uses authenticated GET /agents/me; any 2xx is success.
  Tests use a local HTTP fixture and verify the request path and bearer header.
  No Relay, protocol, Node, database, or workflow contract changed.
- The new doctor CLI suite has 14 cases: both output modes cover missing config,
  unavailable Relay, rejected key, healthy setup, missing client registration,
  successful repair, and manual-remediation failure. Tests isolate HOME and all
  relevant AgentRelay credential/trust paths and execute children asynchronously.
- Built-CLI tests follow the existing describeIfBuilt convention. Build before
  running them to avoid silent skips. Final full units passed protocol 125,
  MCP 266 (including all CLI cases), Relay 77, and Node 438 tests.
- Unit commands must not inherit either Relay database URL. Use env -u for those
  two variables in the unit subprocess only. Relay's 180 integration tests and
  Node's three opt-in tests skip normally in this tier. Integration reruns are
  required when Relay code changes; none changed for #11.
- pnpm lint passes with four pre-existing Relay unused-suppression warnings.
  Recursive typecheck and build pass. Both public doctor JSON documentation sites
  are mcp-server/README.md and docs/lld.md; their 13 local links resolve.
- The implementation commit is `119d756` (fix(cli): return failure status for
  failed doctor checks). The separate memory commit uses the required
  chore(autopilot): update run memory subject. No push, external mutation, release,
  or unrelated Labs work was performed.
