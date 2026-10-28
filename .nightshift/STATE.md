# Nightshift state

Working memory. Rewrite at the end of each session; history and active tests take
precedence over notes.

## Goal as understood

Ship owner-chosen `core-mailbox` issues, with small concern-specific commits and
passing checks, then request the next selection. The goal is unchanged. The owner's
October 28, 2026, 16:30:54 UTC reply on #176, “agreed with these 3,” endorses the
conditional #34/#44/#8 plans. It does not supply Docker access, real two-owner
evidence, or a decision on the explicitly excluded #30 metrics dependency.
Do not repeat the candidate-selection question or treat missing prerequisites as
waived. Work may resume on an endorsed issue when its prerequisite is resolved.

The previous three selected issues are now complete on `origin/main`:

- #10: `46bea8d` — `fix(trust): reject unknown root policy keys`.
- #103: `e34465a` — `test(mailbox): prove retry and restart reliability`.
- #39: `be91a0f` — `feat(cli): add passive stdout mailbox observation`.

This session started clean at `cc61e09`, the merge of PR #175. Both `HEAD` and
`origin/main` included that merge; the initial branch comparison was empty.
Do not reuse `Closes #10`, `Closes #103`, or `Closes #39` in this run's PR.
#111, #40, and #11 also remain prior main work, not new branch changes.

## Plan

- [x] Read state, recent journal/history, repository instructions, relevant design
  sources, issue snapshot, and the owner's conditional plan endorsement on #176.
- [x] Run harness setup/locked installation and prepare the disposable database.
- [x] Confirm previous product work is merged and there are no PR findings.
- [x] Recheck #34 Docker access without changing daemon permissions; still denied.
- [x] Inspect #44's dispatcher/callers/tests and current design: no durable outbox
  or metrics endpoint exists, and #30 remains demand-gated.
- [x] Check #8/#101 evidence requirements against the available local proof record;
  no actual two-owner/two-machine recording or redacted transcripts were supplied.
- [x] Finish all required shared gates and prepare the memory-only commit/outputs.
- [ ] Resume an endorsed issue after its required access/evidence/scope is supplied.

## Next step

Read the owner inbox for a substantive prerequisite resolution on #176 and the
refreshed issue snapshot. The three conditional plans are endorsed; do not ask the
owner to choose the same candidates again. First check whether Docker access is
available for #34, whether #44's metrics scope has been explicitly resolved, or
whether actual #101 proof evidence is supplied for #8. Implement only an unblocked
endorsed scope. Recheck origin/main/history before making closure claims.

The eligible non-epic backlog still contains only #34, #44, and #8. #176 already
lists their plans, files, checks, prerequisites, and the recommendation to unblock
#34. Do not create a duplicate question. Epics, Labs, demand-gated work,
non-mailbox-labelled interop issues, and completed main work stay excluded.

## Waiting on owner

- #171 is historical and answered; the prior product branch is merged.
- #176 remains open: its reply endorses the plans but does not fully resolve the
  prerequisite request. Do not record 176 in `resolved.txt` yet.
  - #34 requires a disposable Docker-capable environment/approved daemon access.
    `docker version --format '{{.Server.Version}}'` still fails with permission
    denied; `sudo -n true` still requires a password. Do not change socket
    permissions, protected workflows, or deployment configuration. Native job
    Postgres is usable, but is not the required Compose backup/restore proof.
  - #44's conditional outbox plan is endorsed, but its requirement to expose
    metrics through #30 still conflicts with the goal's demand-gated exclusion.
    The owner must explicitly defer that requirement for this issue or authorize
    a bounded notification-metrics exception. Do not implement all of #30,
    silently omit criteria, or close the full issue for a partial outbox.
  - #8 needs actual redacted #101 prerequisite evidence and two owners/machines;
    none was supplied in the reply or available records. Local process tests
    cannot certify that proof. Do not fabricate participants or recordings.

## Learned about the repository

- Trust root keys are now exactly `version`, `teammates`, `unknown_teammates`,
  `blocked`, and `defaults`. Unknown roots return existing `invalid` policy,
  doctor reports broken trust, MCP retains safe fallback, and attention watch
  refuses pickup without checkpointing. Nested schemas and trust precedence are
  unchanged; pickup is still exact-sender consent, never inherited.
- #103's real-process proof preserves Postgres and Relay secrets through
  `TestRelay.restart()`. It retries creation after restart, starts receiver MCP
  only after three messages commit offline, observes ordered provenance-marked
  retrieval, and proves a same-thread reply as sequence 4.
- The lost-append-response transport consumes the real committed HTTP response,
  independently observes the message through MCP, withholds the response, and
  verifies identical serialized automatic retries plus stable receipt/data/event
  count after another restart. Its fault flag prevents retry logic from hiding
  failed assertions inside the injected transport.
- Notification evidence discards actual handoff/append enqueue jobs and replaces
  the HTTP app before retrieval. This is local loss-boundary proof, not a killed
  Slack worker, remote-provider outage, durable outbox, power-loss, or capacity
  claim. Slack remains process-local best effort.
- Non-participant read/append disclose no result/private content and leave no
  mutation audit. Completed/cancelled tests cover both participants' append and
  all transitions, preserving ownership and unchanged thread/audit/event state.
  Existing block-fence/provenance tests remain the evidence for those rules.
- `watch --stdout` uses only configured bearer metadata replay/SSE reads and emits
  six-field `thread.created`/`message.appended` NDJSON. No body fetch, binding,
  trust read/mutation, runtime enqueue, connector lock, or shared state access
  occurs. Default attention-mode code remains intact apart from CLI option parsing.
- Passive cursors are exclusive positive decimal strings within Postgres bigint
  range. CAC numerically coerces option values, so the CLI preserves the original
  cursor token before Zod validation; max-bigint, exponential/hex/leading-zero,
  duplicate-flag, and `--` separator regressions cover that boundary.
- Replay asks for 100 events per page, advances over filtered lifecycle events
  only in memory, suppresses duplicate cursors, and rejects unordered new events
  before printing. SSE ready/change/resync triggers replay; heartbeat does not
  poll. Reconnect waits for ready before replay, permanent 4xx other than 408/429
  fail, and output/schema failures stop rather than printing unsafe diagnostics.
- Source docs explicitly do not claim the new flag is in published 0.3.0.
  A printed ledger reference is not pickup, model processing, or a reply receipt.
- Run database-mutating integration/e2e/smoke commands serially. Keep both Relay
  database variables unset for unit tests; avoid simultaneous dist writers during
  process tests. Do not use recursive `pnpm -r test`.
- No dependencies, versions, release notes, migrations, workflows, infra, runtime
  activation, or notification architecture changes were made.

## Verification this session

- Harness setup passed locked installation and migration preparation on the job's
  native disposable Postgres. Explicit frozen-lockfile installation passed;
  expected initial unbuilt Node-bin warnings disappeared on the post-build install.
- All six shared gates passed: frozen-lockfile install, lint, recursive typecheck,
  recursive build, database-unset package unit tests, and sequential Relay
  integration. Unit results: 125 protocol, 393 MCP, 77 Relay, and 438 Node passed;
  233 Relay DB and three Node opt-in tests skipped normally. Integration: 233
  passed, zero failed.
- Lint retains four pre-existing unused-suppression warnings. `git diff --check`
  passed. No public Markdown links, source, or tests changed; no new e2e or
  Compose proof was run or claimed. Previous proof commands remain in the journal.
- Docker server access and noninteractive sudo both failed as expected access
  probes, not failing repository gates. No permission/deployment changes were made.
- Exact validation commands and outcomes are in the newest journal entry.

## End-of-session outputs

- External summary explains the endorsed plans and still-missing prerequisites.
- External PR description covers only memory changes against `origin/main`;
  previous product work is merged and no new issue closure is claimed.
- No duplicate question or resolution record is created: #176 remains open until
  its prerequisite request is fully answered. `STOP` ends this blocked run.
- Memory commit: `chore(nightshift): update run memory`. No push or GitHub calls.
