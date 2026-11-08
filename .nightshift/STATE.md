# Nightshift state

## Goal as understood

Build verified handoff links through all seven owner-supplied steps while preserving
ordinary mailbox and sovereignty boundaries. The goal changed on November 7, 2026
and is unchanged in run 42512358810, session 1. All seven steps are complete in source
with passing required local checks. Current feedback reports only failing GitGuardian
Security Checks on PR #178, without incident details. The previously reported
lint-typecheck failure is absent from this snapshot, but no passing rerun or owner
diagnostic is supplied. Previous source/static, export, packed-artifact and available
local Azure compilation checks pass. A synthetic Basic-auth fixture mitigation is
committed, but neither remote gate is independently verified fixed.
The receiver kit is ready; actual Claude Code/Codex/Cursor trials remain unrun and
explicitly nonblocking. No package release or deployment.

## Plan

- [x] Read memory/history/instructions/designs, inspect the clean tree, run setup.
- [x] Step 1: synthetic Markdown/HTML fixture and six-trial manual kit (ef1b781).
- [x] Step 2: RFC 003 narrowly amends exactly four RFC 002 decisions (9a1b703).
- [x] Step 3: share tables/external audit actors (c0048d5) and admin-attested invite
  domains with unknown historical provenance (3f8f1a4).
- [x] Step 4: capability create/read, held JSON/form replies, revocation, expiry,
  and in-process retention (8154962).
- [x] Step 5: private inspection/public answers (d742ace), MCP/CLI previews and
  scanning (f461124), interactive release and durable external inbox (1268207).
- [x] Step 6: byte/IP/link limits, invite-redeem admission, secure rendering/log
  redaction, and content-free Slack waiting hints (06dd901).
- [x] Step 7: all seven measurement producers, explicit invite interest, and final
  API/architecture/provenance/HLD/LLD/MCP documentation (b312e37).
- [x] All six required gates, focused contracts, documentation links, and current
  branch-wide mailbox/share/notification process regressions pass.
- [x] Commit product work; finalize memory, branch-wide PR text, summary, and STOP.
- [x] Investigate supplied security feedback without contacting GitHub or exposing
  credentials; construct the Basic-auth scan fixture at runtime (a830510) and stop
  parameterized test names from echoing credential-like content.
- [x] Rerun all six required checks and focused publication tests successfully.
- [x] Reproduce lint-typecheck's source/static, protocol-export and packed-artifact
  steps; validate shell syntax and Azure compilation with available Bicep 0.48.1.
  Do not download CI's pinned 0.46.1 binary from GitHub or edit protected paths.
- [ ] Confirm GitGuardian passes or obtain content-free detector/path/commit/error
  details and address the specific finding. Do not claim the candidate fix resolves it.
- [ ] Confirm lint-typecheck passes or obtain its failing step/commit/sanitized
  diagnostic and fix the identified in-scope cause. Open issue #184 requests it;
  the current snapshot no longer lists that job as failing, not proof of a rerun.

## Next step

Read actual owner replies to #183 and #184, plus refreshed check feedback first.
If both gates pass, no further product change is required. Otherwise use only
content-free incident/error details to fix the specific in-scope cause. A workflow
or Azure asset change requires explicit approval because those paths are off-limits.
Do not weaken scanners, rewrite history or assume a credential is synthetic.
The owner can independently run the 15-minute matrix in
`docs/handoff-links-receiver-test.md`. Real-client compatibility is not established
by synthetic tests. Stop further sessions in this run while awaiting details.

## Waiting on owner

Open issue #183 already requests the detector, path/line, affected commit, and
sanitized status/error for PR #178, or confirmation that the newly published commit
passes. Run 42512358810 still supplies only the failing check name. The owner inbox
reproduces the existing question, not an answer or finding details. Do not duplicate
this question or mark #183 resolved. Do not request raw secrets or credentials.
Open issue #184 requests the previously failing lint-typecheck job's failing step,
affected commit and sanitized diagnostic, or confirmation of a passing rerun.
Current feedback lists only GitGuardian; do not infer that #184 is resolved from
omission alone. Do not duplicate either open question or append either issue to
resolved.txt. Previous locally reproduced job steps pass. The previous run's installed
Bicep was 0.48.1 rather than CI's pinned 0.46.1; no GitHub binary download/checksum
or private check is verified. No further Azure investigation is needed without a
diagnostic, and protected paths remain off-limits.
Manual receiver results remain nonblocking.
The unchanged merge guard denies migrations and does not allow integration-runner/
e2e package-script paths. This approved branch includes those paths and needs direct
repository review rather than reply-only merge.

## Verification for run 42512358810, session 1

- Setup script and frozen install pass. Lint passes with three existing warnings.
- Recursive typecheck/build and canonical units pass: protocol 125, MCP 501,
  Relay 98, Node 438; expected Relay 337 database and Node three opt-in skips.
  Never set database variables for units or use recursive workspace tests.
- Serialized Relay integration passes 337 against local Postgres on port 5433,
  with RELAY_TEST_TRUNCATE_VIA_PSQL=1; zero failures.
- Run 42494936182 additionally passed protocol `test:exports`, MCP `pnpm pack`
  (including 501 tests), installed packed-artifact CLI/MCP smoke, and Azure shell/
  template/parameter compilation using Bicep 0.48.1, not CI's pinned 0.46.1.
  Those extra commands are not rerun for this memory-only session. No Azure files
  are changed, GitHub download attempted, or remote binary step verified.
- No product or fixture edits in this run. The prior run's 62 focused publication/
  CLI/MCP contracts are included in the passing MCP suite, not rerun separately.
- Whitespace checks pass. GitGuardian was not run locally; no private findings or
  credentials were accessed, no scan suppression was added, and both open diagnostic
  questions remain unresolved pending a rerun or owner-supplied details. The previous
  candidate fixture mitigation is already committed; no further speculative
  mitigation, scanner suppression, history rewrite, or external API call is made.
- Previous session 5 additionally passed 53 focused share/render tests, six process
  regressions across four files, and 70 local Markdown targets/seven documents.
  Those extra commands are not rerun separately for this memory-only session.
- Post-memory lint and inline local Markdown-target checks pass; both memory files
  have no local Markdown links. Frozen installation warns about e2e CLI bins before
  Node is built; recursive typecheck/build subsequently pass. This is not a newly
  reproduced source failure. Branch-wide PR text and summary retain the distinction
  between completed source, unrun receiver trials, and unverified remote gates.

## Learned about the repository

- Separate share tables preserve ordinary participant-only two-party handoffs.
  Owner routes require active agent bearers, not Node credentials. Capabilities
  expose only sender content; external replies are never rendered publicly.
- Creation/answers require exact-content client previews and local secret scanning
  without a bypass. There is no server scanner or confidentiality guarantee.
  Limits: seven-day default/thirty-day max expiry, ten external replies, 64 KiB
  initial plus public answers in aggregate, 16 KiB per reply/answer (UTF-8 bytes).
- Private inspection/release remains available after expiry/revocation until
  content deletion without reviving public access. Release is sender-owned,
  idempotent by reply ID, and transactionally writes state/event/audit.
- CLI release requires all three terminal streams and exact typed release plus
  reply ID; wrong input/EOF cancels. No flags or MCP release tool bypass it.
  The Relay authenticates the sender bearer, not a human at a terminal.
- check_inbox exposes only released external replies in a separate array with
  external_unverified, untrusted/data-only text and record provenance, stable
  release-event cursors, and explicit caller checkpointing. Sender lifecycle locks
  serialize release allocation and reads, preventing late lower cursors. Reads are
  replay, not processing acknowledgements or ordinary mailbox watch events.
- Retention sweeps at startup/minute, drains SKIP LOCKED batches, and nulls all
  content thirty days after expiry. Content-free IDs, release state, cursors,
  measurement, and audit remain; revocation does not move the deletion deadline.
- Share Slack hints reuse encrypted configured webhooks, exact HTTPS Slack
  allowlisting and redirect refusal. The constant payload has no identity, IDs,
  capability, or body. Attempts follow only new committed API/form replies, are
  bounded to five seconds, and cannot alter storage receipts. No outbox/retry or
  delivery/processing guarantee; a crash may lose the hint.
- POST /l/:id/invite-requests records explicit anonymous interest only. Strict
  JSON/form accepts a UUID retry key within 1,024 body bytes; link locks deduplicate
  same-key/channel retries. Event and external audit commit together. No account,
  invite, credential, contact, email, inbox item, or notification is created.
  A fetch never records interest. Existing admin mint/redeem stays unchanged.
- Invite requests share reply-write admission: ten/IP/minute, twenty/link/minute.
  Reads are sixty/IP and 120/link/minute; invite redemption is ten/IP/minute.
  Normalized XFF-first-position addresses require trusted ingress that strips
  spoofed headers. Quotas are bounded, per-process and restart-reset.
- Company domains are admin-attested at invite minting and copied on redemption;
  historical/omitted values stay unknown. External authors are never verified.
- Inherited ce0b06e (#44 ordinary notification outbox) and 945e9d5 (restart-test
  build ordering) remain outside origin/main and are included in PR text. Queue
  metrics through #30 stay deferred. This session adds no migration, dependency,
  version bump, protected-path modification, publication, or Labs expansion.
- The security feedback snapshot contains only the failing check name. The static
  Basic-auth fixture decoded to explicitly synthetic test text; runtime construction
  preserves its bytes and scan coverage. This is a plausible false-positive source,
  not an identified incident. Historical occurrences remain in existing commits.
