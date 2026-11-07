# Nightshift goals

status: running

<!--
Owner-controlled. Edit this file on the default branch (the GitHub web editor or
mobile app is fine). Every run reads the latest version from the default branch
before it starts; the agent cannot change the copy it reads.

- `status: running` lets runs work. `status: paused` makes them exit immediately.
  Keep the line exactly in the form `status: <value>`.
- Changing the goal takes effect on the next run. The agent rewrites its plan in
  `.nightshift/STATE.md` when the goal changes.
- Close the Nightshift draft PR without merging to discard its work. The next run
  starts fresh from the default branch.
- Runs start on the schedule in `.github/workflows/nightshift.yml` (skipped while a
  question waits on the owner, unless the PR has review findings or failing
  checks), and immediately when the owner replies on an open `nightshift:needs-you`
  issue.
- Reply `merge` to a run-report email (or comment `merge` on the Nightshift PR) to
  merge the exact commit that report names, once the default branch's required
  checks pass. A reply can merge only paths that `merge.allow` in
  `.nightshift/config.yml` permits and `merge.deny` does not; anything else must be
  reviewed and merged on GitHub.
- Reactions on your comment show progress: a thumbs-up when a reply or `merge` is
  picked up, then a rocket when the merge lands or a confused face when it does not
  (a reply explains why).

The goal below is a starting point. Replace it with your own before setting
`status: running`.
-->

## How to work

Decide for yourself. Do not ask the owner to choose what to work on next: pick the
most valuable next step toward the goal, build it, verify it, and say what you picked
and why in the run summary and the PR description. Open a question only when you
cannot proceed without something only the owner can give: credentials or accounts,
real-world evidence, or a decision that would contradict `AGENTS.md`, an RFC, or a
public product promise. When you do ask, keep working on everything that does not
depend on the answer.

## Current goal

Build verified handoff links, the next AgentRelay product step. The sender's agent
turns a handoff into a URL; a person at another company gives that URL to their own
agent, which reads it and replies without installing anything. Replies are held until
the sender's owner releases them. Work through these steps in order, one or more per
run.

1. **Receiver test kit.** A static mock link page (markdown for agents, minimal HTML
   for browsers) and `docs/handoff-links-receiver-test.md`: a 15-minute manual test
   the owner runs with Claude Code, Codex, and Cursor, with and without a copy-paste
   `curl` line, recording whether each agent can read the handoff and post a reply.
   Do not wait for the result; continue with step 2.
2. **RFC 002 amendment** (new RFC or amendment section) covering exactly four changes:
   public reads of sender-authored link content, unauthenticated external replies held
   for owner release, link threads with more than two parties, and audit entries from
   actors that are not agents. Keep every other RFC 002 promise.
3. **Data model:** `share_links`, `share_replies` (`author_kind` sender or external,
   `channel` api or form), and `share_events` tables with a migration. Admin-attested
   company domain on invites (recorded with an audit entry when the invite is minted;
   backfill existing agents as unknown).
4. **Relay routes:** `GET /l/<id>` with content negotiation (markdown for non-browser
   clients and `Accept: text/markdown`, minimal HTML otherwise) showing only
   sender-authored content; `POST /l/<id>/replies` (JSON) and an HTML fallback form.
   The link id is the only capability: long, unguessable, up to 10 replies, default
   expiry 7 days (maximum 30), revocable, content deleted 30 days after expiry by an
   in-process sweep. Replies are never shown publicly.
5. **Client:** MCP `share_handoff` and CLI `agentrelay share` create links after a
   preview; `agentrelay share replies <link-id>`, `agentrelay share release
   <reply-id>` (interactive terminal only), and `agentrelay share answer <link-id>` /
   MCP `answer_share`. A client-side secret scan blocks creation and answers on a
   match. Released replies reach `check_inbox` with a new provenance origin,
   `external_unverified`.
6. **Safety:** content capped at 64 KB per link and 16 KB per reply or answer;
   in-process rate limiting per client IP (honouring `X-Forwarded-For`) and per link,
   which also closes the invite-redeem rate-limit TODO; strict CSP and output escaping;
   `X-Robots-Tag: noindex`; no content in Open Graph or meta tags; Relay-authored
   instructions first, then sender content inside a delimiter that is random per
   response, rejecting content that contains it. A content-free "reply waiting" hint
   through the sender's existing Slack webhook when configured.
7. **Docs and measurement:** document links in `docs/lld.md`, `docs/architecture.md`
   (including the provenance section), and the MCP README; `share_events` records
   `link.created`, `link.fetched` (HTML, markdown, known bots), `reply.posted` (api or
   form), `reply.released`, `answer.posted`, and `invite.requested`.

Out of scope: receiver accounts, self-serve signup, email sending, cryptographic
signing, live sessions, wake-up, Missions and Node, A2A conformance, and any execution.
Nothing in a link or reply may grant the receiving agent authority on the sender's side.

## Done when

- Each step above lands on the Nightshift PR with passing checks and tests, and the PR
  description says which steps are complete.
- The receiver test kit is ready for the owner to run.

## Priorities and constraints

- Keep changes small and reviewable. Prefer one concern per commit.
- Code and tests define behavior; keep documentation truthful about what is shipped.

## Off-limits

- Release, publish, and deploy workflows (`.github/workflows/deploy*.yml`,
  `publish-image.yml`) and `infra/azure/`.
- Package version bumps and changelog release entries.
- Anything under `.nightshift/` except `STATE.md` and `JOURNAL.md`.
