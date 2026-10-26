# Autopilot state

Working memory. Rewrite this file at the end of each session.

## Goal as understood

The owner changed the goal to ship core-mailbox issues one at a time, proposing
the next three candidates whenever no selected issue remains in progress. The
previous selection, #11 (doctor failure exit codes), is complete in `119d756` and
already merged into main through `d4cea26` / #150. This is a new selection cycle,
not permission to implement another issue automatically.

Run 40286683512 proposed **#40 (recommended), #10, and #111** in issue **#161**.
Run 40291157370 supplies that question in the inbox but no owner selection. The
goal is unchanged, and no product files changed. Wait for an explicit choice.

## Plan

- [x] Read memory, history, updated goal, open issue snapshot, and design sources.
- [x] Confirm #11 is on main and no selected issue is in progress.
- [x] Inspect candidate implementations, consumers, nearby tests, and feasibility.
- [x] Write the external three-candidate question with plans, paths, and checks.
- [ ] Receive the owner's selection and any necessary scope clarification.
- [ ] Implement only that selection with focused regression tests and truthful docs.
- [ ] Run all canonical static/build/unit gates, and Relay integration if applicable.
- [ ] Commit the verified selection, describe it with Closes #N, and propose the next three.

## Next step

Read the owner inbox for the choice requested in issue #161. Inspect the
chosen contract again against the current main and snapshot before editing. If
#10 is chosen, confirm approval for strict top-level validation rather than a
warning-only mode. Do not broaden nested policy schemas or trust semantics.

Stop this run while waiting: no remaining product work is authorized without a
selection. No need to ask again unless the question is missing or the goal changes.

## Waiting on owner

Choose #40, #10, or #111 in issue #161. The question recommends #40 and includes the
implementation plan, likely files, verification commands, and compatibility
choices for each. This run's inbox reproduces the question, not a choice; do not
treat a recommendation or the owner's mention as approval. Do not duplicate it.
#10 carries the ideas label, so its selection must approve the stated strict-root
scope. No issue is newly completed or resolved in this run.

## Learned about this repository

- Run 40291157370 starts clean on autopilot at `ec6ef7c`, matching origin/main.
  The previous proposal memory is on main through `4164dba` / #160. #11 remains
  complete on main; the current snapshot still includes #40, #10, and #111.
- #40 has scoped help-wanted acceptance criteria. The existing viewThread helper
  already marks peer participants, summaries, metadata, proposed actions,
  messages/payloads/artifacts, and completion content, stripping Relay idempotency
  metadata. Relay tasks/get includes created_at, but viewThread's schema drops it;
  preserve that field if exporting lifecycle timestamps. CLI writeSecretFile uses
  rename and can overwrite, so it is not suitable unchanged for archive creation.
- #10 is a small ideas-labelled compatibility change requiring explicit approval.
  Root trustFileSchema and inherited entries currently use passthrough; one test
  explicitly accepts extra root keys despite its misleading warning title. A
  strict-root plan should leave nested schemas and overlay precedence untouched.
  Invalid loaded policy already falls back safely in MCP and blocks watcher pickup;
  doctor detects invalid policy. CLI-generated files must remain parseable.
- #111 is scoped help-wanted work with a wider MCP/Relay boundary. MCP already
  forwards role/skill/repo, but Relay dispatch calls handleAgentsList(ctx), ignoring
  all params. Both JSON-RPC and REST rosters currently select active agents without
  block-list filtering. Preserve current behavior rather than inventing a discovery
  policy. New paginated opt-in must preserve legacy no-filter/no-pagination callers;
  validate cursors, keep provenance, inspect query plans before adding indexes.
- #34 was excluded by the previous run: Docker Compose was installed but
  docker info failed with socket permission denied; sudo -n docker info required a
  password. Docker access was not retested this run. Native database testing is
  not the required disposable Compose proof.
  Do not alter runner/security/Compose files or ask for unrelated setup before the
  owner chooses an issue. #103 is a broader mailbox fault/evidence matrix; #39
  overlaps existing watch behavior, and #44 proposes a larger notification redesign.
- Build before built-CLI tests to avoid describeIfBuilt skips. Never let the unit
  command inherit RELAY_DATABASE_URL or RELAY_TEST_DATABASE_URL: unset both in that
  subprocess. Use the sequential canonical Relay integration command with its
  database URL only when Relay code changes. No Relay code changed this session.
- Session verification outcomes and exact commands are recorded in the newest
  journal entry. Only STATE.md and JOURNAL.md are committed; selection question,
  summary, PR description, and STOP are external workflow outputs. Do not push,
  call GitHub, or implement unchosen backlog work.
