# Nightshift state

## Goal as understood

Build verified handoff links through all seven owner-supplied steps, preserving
ordinary mailbox and sovereignty boundaries. The goal changed on November 7, 2026
and is unchanged in run 42991114240, session 1. All seven steps are complete in
source, and all six required local checks pass. The receiver kit is ready; actual
Claude Code/Codex/Cursor trials remain unrun and explicitly nonblocking. Release,
publication, deployment, and additional product work are not authorized.

## Plan

- [x] Read memory, recent history, instructions, and supplied feedback; run setup.
- [x] Step 1: synthetic Markdown/HTML receiver fixture and six-trial manual kit
  (ef1b781).
- [x] Step 2: RFC 003 narrowly amends exactly four RFC 002 decisions (9a1b703).
- [x] Step 3: share tables/non-agent audit (c0048d5), admin-attested invite
  domains with unknown historical provenance (3f8f1a4).
- [x] Step 4: durable capability routes, held JSON/form replies, revocation,
  expiry, and retention sweep (8154962).
- [x] Step 5: private reply inspection/public answers (d742ace), previewed and
  secret-scanned MCP/CLI publication (f461124), interactive release and durable
  external inbox replay (1268207).
- [x] Step 6: byte/IP/link admission, invite-redeem limiting, safe rendering/log
  redaction, and content-free Slack waiting hints (06dd901).
- [x] Step 7: measurement producers, explicit invite interest, and current
  API/architecture/provenance/HLD/LLD/MCP documentation (b312e37).
- [x] Confirm the reported historical Basic-auth fixture is already remediated
  in current source (a830510); preserve blocking remote status.
- [x] Investigate newly supplied `unit (22)` feedback: no diagnostic is supplied,
  and the canonical database-free unit command passes locally.
- [x] Rerun all six required checks with database variables unset for units.
- [x] Update memory, external run summary, and full-branch PR description;
  commit and prepare STOP plus IDLE to await owner review/classification.

## Next step

The implementation goal is complete. Read changed goals, concrete PR findings,
and fresh owner replies first when work resumes. Do not invent further source
work or repeat memory-only sessions for unchanged historical scanner feedback.
The owner can classify the synthetic GitGuardian incident if still triggered,
review the full branch, and run `docs/handoff-links-receiver-test.md`. If the remote
unit check still fails, its actual diagnostic is the first investigation input;
do not infer a fix from its name alone.

## Waiting on owner

Supplied feedback still reports GitGuardian incident 39789810 in historical
commit f461124 as triggered and blocking. Current source constructs the synthetic
Basic-auth fixture at runtime from a830510 and retains redacted-error/secret-block
coverage; it is not a deployed credential. Prior journal entries record the
owner's November 9 reply resolving question #183 and undertaking private
test-credential classification. This run supplies no new reply; the issue snapshot
contains neither #183 nor #184. Do not duplicate questions, re-emit resolutions,
rewrite history, weaken scanning, call external systems, or claim the remote
check is green. Further source edits cannot clear that historical occurrence.

New supplied feedback lists `unit (22)` as failing but contains no error output.
The canonical database-free unit command passes locally, including 438 Node tests;
all six required checks pass. This does not establish remote check success. No
source change is justified without a reproducible failure or concrete diagnostic.

Prior #184 requested a lint/typecheck diagnostic. No diagnostic or failing
lint/typecheck check is supplied now; local checks pass. Preserve that history
without inferring remote resolution or investigating protected paths.

Manual receiver results remain nonblocking and unverified. The unchanged merge
guard excludes migrations and integration/e2e script paths included in this
branch, so direct repository review is needed rather than reply-only merge.

## Verification for run 42991114240, session 1

- `bash "$NIGHTSHIFT_HARNESS/setup-install.sh"` and
  `pnpm install --frozen-lockfile`: pass. Installation warns about prebuild e2e
  CLI bins; subsequent recursive builds pass.
- `pnpm lint`: pass with three existing unused-suppression warnings.
- `pnpm -r typecheck` and `pnpm -r build`: pass.
- `env -u RELAY_TEST_DATABASE_URL -u RELAY_DATABASE_URL pnpm --filter
  @agentrelay/protocol --filter relay --filter agentrelay-mcp --filter
  agentrelay-node test`: pass. Protocol 125, MCP 501, Relay 98, Node 438;
  expected skips: Relay 337 database tests and Node three opt-in tests.
- `RELAY_TEST_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay
  RELAY_TEST_TRUNCATE_VIA_PSQL=1 pnpm --filter relay test:integration`: pass,
  337 tests, zero failures, serialized against local Postgres on port 5433.
- `git diff --check`, `git diff --cached --check`, and post-memory
  `pnpm lint`: pass. No product/test changes or remote checks this session.

## Decisions this run

- Keep the current runtime-built fixture: it preserves scanner coverage without
  embedding the encoded literal and needs no additional source remediation.
- Reproduce the newly reported unit check before considering source changes.
  The full unit suite passes, so preserve existing code and report the remote
  discrepancy rather than guessing or weakening tests.
- Stop because all requested source steps are complete and the remaining supplied
  blocker needs private historical classification. Also write IDLE so unchanged
  feedback does not justify repeated memory-only scheduled sessions.
- Include all changes outside origin/main in the PR description, including
  ce0b06e's ordinary-mailbox outbox and 945e9d5's e2e build ordering. Queue metrics
  remain deferred to #30; do not claim broader #44 closure.

## Learned about the repository

- Separate share tables preserve participant-only two-party mailbox handoffs.
  Public capabilities expose only sender content; external replies are private.
- Client creation/answers require exact-content previews and local secret scans
  with no bypass. These are not a server scanner or confidentiality guarantee.
- Links default to seven-day expiry, maximum thirty days and ten external replies.
  Initial content plus public answers is capped at 64 KiB; replies/answers at 16 KiB.
- Sender release is transactional and idempotent. The CLI requires all three
  terminal streams and exact typed confirmation; there is no MCP release tool.
  The Relay authenticates a sender bearer, not a human at a terminal.
- Released inbox content stays `external_unverified`, with provenance, stable
  release cursors, and explicit checkpointing. Release grants no authority.
- Retention nulls content thirty days after expiry, leaving content-free history;
  revocation does not move that deadline. Private inspection/release remains
  available after expiry/revocation until retention deletion.
- Share Slack hints are content-free, bounded, best-effort attempts after commit;
  they do not use the durable ordinary-mailbox outbox or promise retries.
- Explicit invite requests record content-free interest and external audit only;
  they create no account, invite, credential, email, or notification.
- Public rate buckets are per-process and restart-reset. Trusting normalized
  first-position XFF requires ingress that strips spoofed forwarding headers.
- Company domains are admin-attested at invite minting, not externally verified;
  historical/omitted values stay unknown. External authors are never verified.
