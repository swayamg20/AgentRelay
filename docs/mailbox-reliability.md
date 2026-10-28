# Durable mailbox reliability evidence

This record maps the nine mailbox cases in issue #103 to executable evidence.
The tests use disposable local Postgres, real Relay and MCP child processes where
noted, and deterministic faults at the client-response and notification boundaries.
They do not establish a two-person/two-machine pilot, production capacity, automatic
agent processing, or autonomous repository execution.

## Contract and evidence

| Required case | Evidence |
| --- | --- |
| Retry creation with identical input and one key; observe one handoff | `relay/src/routes/a2a.test.ts`: **idempotency replay returns same handoff for same payload** and **serializes concurrent create and append retries** check stable identity and one mutation/audit/event. The process test also retries creation with the same key after restart and sees one inbox item. |
| Retry append after a lost response; observe one ordered message | `tests/e2e/src/mailbox-reliability.e2e.test.ts`: **retries an append whose committed response was lost without a duplicate message** consumes the real successful HTTP response, independently retrieves the committed message through MCP, then withholds that response. The actual MCP A2A client retries the identical serialized request/key. Message ID, sequence, timestamp, payload, artifacts, and event count remain stable, including another same-key retry after Relay restart. |
| Restart after a committed send; retrieve the same thread | **retains committed sends across restart and offline receiver pickup and reply** uses `TestRelay.restart()`, which replaces the Relay process without clearing Postgres or rotating its secrets. The sender's complete MCP thread view is identical before and after restart and creation replay. |
| Receiver offline, later retrieval in order and reply | The same process test creates the receiver identity but starts no receiver MCP process until after three messages commit and the Relay restarts. The receiver finds one inbox thread, retrieves the same ordered IDs/sequences with inbound provenance, and replies as sequence 4. The sender retrieves that reply in the same thread. |
| Non-participant read and mutation fail without thread disclosure | `relay/src/routes/a2a.test.ts`: **non-participant cannot read/append** checks both errors, absence of a result, unchanged history, and no append audit. |
| A committed block fences later content | **makes a successful block response a commit fence for queued content** holds the pair lock to force a content race behind a successful block. **blocking a participant stops new messages on an existing thread** checks both directions, accept/complete gates, unchanged history/artifacts, and no denied-mutation audit. |
| Invalid/terminal mutations preserve ownership | **sender cannot accept own thread**, **sender can cancel a pending thread; recipient cannot**, and **cannot complete a pending (not yet accepted) thread** cover invalid pending-state operations. **rejects new mutations in a completed/cancelled thread while preserving transition ownership** covers both participants' append/accept/complete/cancel attempts, sender completion and accepted-thread cancellation denial, and unchanged thread/audit/event state. |
| Teammate provenance survives on text and structured fields | `mcp-server/src/provenance.test.ts` and `src/tools/tools.test.ts` cover wrappers, spoofed provenance replacement, metadata, proposed actions, and typed artifacts. `tests/e2e/src/handoff-roundtrip.e2e.test.ts`: **preserves structured mailbox data and marks only teammate-authored fields** proves the real Relay/MCP round trip for initial content, question/metadata, proposed actions, message payloads/artifacts, and completion summaries/artifacts, with caller-relative self fields unchanged. |
| Lost best-effort notifications do not lose correspondence | `relay/src/routes/a2a.test.ts`: **retrieves committed content when best-effort notification jobs are lost** discards both actual handoff/append notification jobs at the enqueue boundary. After replacing the HTTP application without those jobs, authenticated inbox/thread reads and durable events still expose both committed messages in order. Existing dispatcher tests separately cover retry exhaustion, non-retryable responses, FIFO dispatch, and overflow drops. |

## Reproduce

Install locked dependencies and prepare the disposable database as described in
[Contributing](../CONTRIBUTING.md). Do not point these commands at a production
database: integration and process harnesses truncate their test database.

Start with existing focused MCP evidence:

```bash
pnpm --filter agentrelay-mcp exec vitest run src/a2a-client.test.ts src/provenance.test.ts src/tools/tools.test.ts
```

Run sequential Relay integration and focused real-process evidence:

```bash
RELAY_TEST_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay RELAY_TEST_TRUNCATE_VIA_PSQL=1 pnpm --filter relay test:integration
RELAY_TEST_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay RELAY_TEST_TRUNCATE_VIA_PSQL=1 pnpm --filter agentrelay-e2e exec vitest run src/handoff-roundtrip.e2e.test.ts src/mailbox-reliability.e2e.test.ts
```

Finish with shared gates and the full process suite. Run database-mutating commands
serially, never alongside another integration/e2e invocation:

```bash
pnpm lint
pnpm -r typecheck
pnpm -r build
env -u RELAY_TEST_DATABASE_URL -u RELAY_DATABASE_URL pnpm --filter @agentrelay/protocol --filter relay --filter agentrelay-mcp --filter agentrelay-node test
RELAY_TEST_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay RELAY_TEST_TRUNCATE_VIA_PSQL=1 pnpm --filter agentrelay-e2e test
```

## Limits that remain

- A Relay receipt proves storage, not device pickup, model processing, or a reply.
  The process proof observes explicit retrieval and reply separately.
- Create/append replay requires the same key and input. A changed input is rejected.
  Accept can re-accept an accepted thread; complete/cancel do not have general
  idempotency receipts. Terminal-state tests do not claim otherwise.
- Restart evidence replaces a running local Relay after a completed commit; it is
  not a power-loss, storage-corruption, backup/restore, or multi-instance proof.
- Slack is a process-local best-effort queue, not a transactional outbox. Its jobs
  can be lost even though the mailbox and recipient event ledger remain durable.
  The fault discards jobs at the local enqueue boundary; it does not simulate a
  remote Slack outage or claim to repair notification loss.
- Provenance marks untrusted content as data. It is not local command authorization
  or a host-enforced runtime permission boundary.
- Existing Mission/Node/Capsule fault tests are Labs evidence, not substitutes for
  these mailbox cases or for the separate two-machine proof.
