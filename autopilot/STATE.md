# Autopilot state

Working memory. Rewrite this file at the end of each session.

## Goal as understood

Ship core-mailbox issues one at a time. Implement only the owner's chosen issue,
then propose three next candidates. The goal is unchanged.

**#40 is complete and previously verified on this branch in `b95dc2b`
(`feat(cli): add safe markdown thread export`).** It is not on origin/main.
Keep `Closes #40` in the full-branch PR description. The owner's earlier
“okay, go ahead” on #161 approved #40 only; #161 is already resolved.

The supplied owner inbox contains the candidate question **#165**, but no owner
reply selecting #111, #10, or #103. Its recommendation is not approval. No new
product issue was implemented in run 40297811021.

## Plan

- [x] Read working memory, newest journal entries, branch history, and issue snapshot.
- [x] Install locked dependencies and migrate the local test database.
- [x] Confirm #40 remains the only product change ahead of origin/main.
- [x] Identify the existing pending candidate question as #165.
- [x] Preserve its proposal without creating a duplicate question.
- [x] Validate memory-only changes and refresh external summary/PR description.
- [ ] Receive the owner's selection on #165 and implement only that issue.

## Next step

Read the owner inbox for a selection on #165. Recheck origin/main and the current
issue snapshot before implementing. If #10 is selected, require approval of
strict-root rejection rather than warning-only validation. If #103 is selected,
first map its nine required cases to existing tests and add only missing proof.
The full plans, touched files, exclusions, and exact checks are in #165.

Stop this run while awaiting selection. The owner may review and merge #40
independently of selecting the next issue.

## Waiting on owner

Choose **#111 (recommended), #10, or #103** on **#165**. Do not duplicate the
question or treat the issue body as a selection. #10 and #103 lack help-wanted
labels; choosing them must approve the narrow plans described in the question.

## Learned about this repository

- This session started clean on `autopilot` at `6b32a2e`. Main updates have been
  merged into the branch; the diff against origin/main contains only #40's source,
  tests, public documentation, and run memory. #11 is already on main.
- Export fetches tasks/get through the shared viewThread provenance boundary.
  Relay getHandoff authorizes participants and does not mutate lifecycle/read
  state. Its implementation does not support the pre-existing viewThread comment's
  access-audit claim; no new audit claim was introduced.
- created_at remains optional in the shared response schema for compatibility;
  export requires it, a recipient, and a matching thread ID. Archives preserve
  typed artifacts/provenance and include lifecycle, ordered messages, and
  completion/cancellation content as sorted-key indented JSON, not instructions.
- Archive writes use exclusive creation and mode 0600, refuse existing paths and
  symlinks, do not create parent directories, and sanitize failures. Authored
  message/artifact secrets are deliberately not redacted.
- #111's forwarded-but-ignored roster filters remain the recommended candidate.
  Preserve legacy calls, active-only selection, current lack of block-list
  discovery filtering, and REST GET /agents. Inspect query plans before indexes.
- #10 uses root passthrough and accepts unknown keys without warning. Strict root
  rejection changes config acceptance; nested schemas and trust behavior must not
  broaden incidentally.
- #103 needs actual mailbox process restart and notification-loss/retrieval proof.
  Existing Relay/MCP tests cover many replay, authorization, lifecycle, block, and
  provenance cases. TestRelay.restart() preserves database/secrets. Labs tests do
  not prove the mailbox acceptance scope.
- #34 needs a disposable Compose restore; previous Docker socket access failed.
  #39 needs a distinct watch contract; #44 is broader architecture; #8 needs two
  people/two machines. Do not silently substitute them for the current proposal.

## Verification this session

- `pnpm install --frozen-lockfile` passed with expected unbuilt Node bin warnings.
- `RELAY_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay pnpm --filter relay exec node --import tsx/esm src/db/migrate.ts` passed.
- `pnpm lint` passed with four existing Relay unused-suppression warnings;
  `git diff --check` and the local Markdown-link check passed.
  Product typecheck/build/unit/integration/e2e were not rerun
  this session because no product code changed. The previous journal entry records
  #40's passing shared gates, 180 Relay integration tests, and handoff process test.

## End-of-session outputs

- Refresh the external summary and full-branch PR description with `Closes #40`.
- Create the external STOP file because further product work requires selection.
- Commit only STATE.md and the new JOURNAL.md entry as
  `chore(autopilot): update run memory`; leave the working tree clean.
