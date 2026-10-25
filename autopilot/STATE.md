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
- [x] Check whether the permitted local inputs include the open issue inventory.
- [x] Request the missing issue inventory through the workflow question output.
- [ ] Obtain issue numbers, titles, labels, bodies, and relevant owner scope replies.
- [ ] Exclude Labs, demand-gated work, and epics; inspect candidate code, callers,
      consumers, and nearby tests against the relevant design sources.
- [ ] Propose the three best one-run candidates with plans, files, checks, and a
      recommendation through the workflow question output.
- [ ] Wait for the owner's selection, then implement and verify only that issue.
- [ ] Commit the implementation and refresh run memory.

## Next step

Read the owner inbox for the issue inventory requested in
`questions/core-mailbox-issue-input.md` in the run output. Do not call GitHub or
infer approved issue scope from documentation gaps. Once the inventory is available,
inspect the corresponding implementation and tests and prepare the three candidates.

## Waiting on owner

- Provide a snapshot of open `core-mailbox` issues with numbers, titles, labels,
  bodies, and relevant owner scope replies. No snapshot is present in the repository
  or run inputs. The session explicitly forbids calling GitHub, including read-only
  issue retrieval. The question output explains this conflict and recommends
  supplying the snapshot in an owner reply without changing access rules.
- After the candidate proposal, the owner must select an issue before implementation.

## Learned about this repository

- Relay integration tests need Postgres. The autopilot job provides it at
  `localhost:5433` and exports `RELAY_TEST_DATABASE_URL`.
- The initial state had no goal recorded; this session initializes the plan from
  the current owner-controlled goal rather than replacing a previous goal.
- History at session start ends at `d87bffe`; the current branch is `autopilot`, and
  the working tree was clean.
- The workflow collects only open owner-question issues and owner comments into
  the inbox. It does not supply a `core-mailbox` issue inventory. The inbox is empty.
- Public design sources describe current behavior, not approved future issue scope;
  they cannot substitute for the missing issue inventory.
- `CONTRIBUTING.md` requires `git diff --check` and local-link checks for docs-only
  changes. No product code, workflow, or dependency changes are needed for this
  blocked intake session.
