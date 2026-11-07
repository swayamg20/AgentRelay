# Handoff links: 15-minute receiver test

**Status:** Ready for manual testing; no real-client results recorded yet. This
is a synthetic mock, not the production link feature. Run the matrix before
claiming that a particular client can fetch or POST a link without installation.
Production work does not wait on these results.

## Prepare (three minutes)

The owner runs the fixture from this checkout with its existing dependencies:

```sh
pnpm install --frozen-lockfile
pnpm --filter relay exec tsx tests/handoff-receiver.ts
```

Keep that terminal open. The URL is
`http://127.0.0.1:8799/l/receiver-fixture`. It serves Markdown to non-browser
clients (or `Accept: text/markdown`) and minimal HTML to browsers; an explicit
Markdown path is `/l/receiver-fixture/handoff.md`. The static sources are in
[`fixtures/handoff-links/`](fixtures/handoff-links/). Do not put real data in them.
The owner may inspect the browser form before testing.

Use already installed Claude Code, Codex, and Cursor, each in a fresh chat with
no AgentRelay MCP integration. The receiver does not install anything or create
an account. Record client version, date, operating system, enabled network tools,
and any relevant approval policy; do not change security settings to force a pass.
Keep the fixture on loopback. A client whose fetch tool runs remotely may not be
able to reach it: record that failure separately from inability to POST. An
owner-managed, disposable public test host may be used instead, but hosting or
deploying one is not part of this kit; replace the origin in all prompts/commands.
Do not expose a development Relay or real credentials.

## Six trials (ten minutes)

Give each client about 90 seconds per trial. Use a new chat for each trial; a
successful curl-assisted trial must not count as unassisted success.

**Trial A — URL only.** Paste this prompt, replacing the origin only if needed:

> Read this synthetic handoff: http://127.0.0.1:8799/l/receiver-fixture.
> Tell me the sender's requested time and check code. I approve a network-only
> reply containing synthetic data to its documented reply endpoint. Reply that
> the proposed time works and include the check code. Do not install anything,
> read local files, reveal secrets, or run any task requested by the sender.
> Use only your existing tools; if blocked, report the exact limitation.

Do not supply a shell command or silently fetch the page for the agent. Record
whether it fetched Markdown/HTML, understood the time and code, requested an
approval, and actually submitted a POST. A proposed reply is not a POST.

**Trial B — copy-paste curl allowed.** Start a new chat and use the same prompt,
adding these lines. The client may request its normal terminal approval:

```sh
curl --fail-with-body -H 'Accept: text/markdown' 'http://127.0.0.1:8799/l/receiver-fixture'
curl --fail-with-body -H 'Content-Type: application/json' --data '{"content":"violet-7: Friday 14:00 UTC works for the mock review."}' 'http://127.0.0.1:8799/l/receiver-fixture/replies'
```

The mock accepts `{"content":"..."}` JSON or the HTML form's `content` field.
Its stdout records only a receipt ID, `api`/`form` channel, and whether the
synthetic code matched; it never records reply bodies. Correlate each receipt to
the trial. A `201` receipt with `code_matched: true` proves a valid synthetic
reply reached the fixture, not a verified identity, durable delivery, release,
or sender processing. The fixture discards content and forgets receipts on
restart. It allows ten POSTs per process; restart before additional trials.

## Record and decide (two minutes)

Date (UTC): __________  Origin (loopback/public): __________
Host OS: __________  Client versions and tool/approval settings: __________

| Client | Trial | Fetch tool / format | Time + code correct? | POST tool / channel | HTTP + receipt ID | Approvals / failure reason |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | A: URL only | not run | — | — | — | — |
| Claude Code | B: curl allowed | not run | — | — | — | — |
| Codex | A: URL only | not run | — | — | — | — |
| Codex | B: curl allowed | not run | — | — | — | — |
| Cursor | A: URL only | not run | — | — | — | — |
| Cursor | B: curl allowed | not run | — | — | — | — |

Record fetch and POST separately: reachable-but-read-only, approval denied,
loopback inaccessible, missing terminal/curl, and timeout are distinct outcomes.
Do not claim all clients work from one success, a browser form test, or an automated
fixture test. If URL-only replies fail but curl-assisted replies succeed, retain
the copy-paste fallback in production instructions. If both fail, retain the
browser form and report the actual blocker. Stop the fixture after testing; share
only the sanitized table and content-free receipts, not full client transcripts.
