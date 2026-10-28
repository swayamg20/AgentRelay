# Mailbox reliability evidence

This is a repeatable local proof of the mailbox contracts in issue #103, not a
production availability measurement or a two-owner, two-machine pilot. The process
tests use a real Relay child process, disposable Postgres state, and stdio MCP
processes. Mission, Node, Capsule, and model execution are not mailbox evidence.

## Required cases and evidence

| Case | Evidence | Observable contract |
| --- | --- | --- |
| Same-key handoff creation retry | [Relay route tests](../relay/src/routes/a2a.test.ts): `idempotency replay returns same handoff for same payload`, `serializes concurrent create and append retries`; [process tests](../tests/e2e/src/mailbox-reliability.e2e.test.ts): `retries an append whose committed response was withheld using the identical request and one sequence` | Identical create input returns the same thread. Concurrent retries create one mutation, audit, and recipient event. Changed input with the same key fails. |
| Append retry after lost response | [Process tests](../tests/e2e/src/mailbox-reliability.e2e.test.ts): `retries an append whose committed response was withheld using the identical request and one sequence`; [client tests](../mcp-server/src/a2a-client.test.ts): `preserves caller-supplied idempotency key on retry` | A test-local transport consumes a successful real Relay response, then throws before returning it to the client. Automatic retry sends the same envelope and key, returns the original message receipt, and stores one sequence; the next distinct append gets sequence 3. |
| Relay restart after committed send | [Process tests](../tests/e2e/src/mailbox-reliability.e2e.test.ts): `retrieves the same committed thread in order after Relay restart and offline pickup, then replies` | `TestRelay.restart()` stops and starts the Relay process without resetting its database or secrets. Thread/message IDs, sequence order, and durable recipient events survive. |
| Receiver offline, later retrieval and reply | Same process test | The recipient has no MCP process during create and two follow-ups. After Relay restart, a fresh recipient MCP finds the pending thread, retrieves sequences 1–3, and sends sequence 4 without accepting the task. The sender's existing MCP reads the provenance-marked reply. |
| Non-participant read and mutation | [Relay route tests](../relay/src/routes/a2a.test.ts): `non-participant cannot read/append` | Read, append, accept, complete, and cancel fail with `not_a_participant`, omit a result and private thread text, and leave the pending thread and its single message unchanged. |
| Block commit fence | [Relay route tests](../relay/src/routes/a2a.test.ts): `makes a successful block response a commit fence for queued content`, `blocking a participant stops new messages on an existing thread` | Queued content cannot commit after a successful block response. New blocked appends and completion fail without a content mutation; explicit unblock restores the allowed operation. |
| Invalid lifecycle and ownership | [Relay route tests](../relay/src/routes/a2a.test.ts): `sender cannot accept own thread (-32009)`, `sender can cancel a pending thread; recipient cannot`, `cannot complete a pending (not yet accepted) thread`, `preserves accepted ownership, rejects cancellation, and treats re-accept as idempotent`, and both `rejects new appends and transitions in a ... thread without changing durable state` cases | Only the recipient accepts/completes; only the sender cancels a pending thread. Re-accept is idempotent. Both participants' new appends and all transitions fail in completed/cancelled threads, with thread, audit, and recipient events unchanged. Already committed same-key create/append receipts remain replayable after block or terminal state; these are not new mutations. |
| Teammate provenance | [MCP tool tests](../mcp-server/src/tools/tools.test.ts): `marks only teammate-authored structured fields`, `marks recipient-view peer data while preserving extensible artifact fields`; [provenance tests](../mcp-server/src/provenance.test.ts); [round-trip process test](../tests/e2e/src/handoff-roundtrip.e2e.test.ts): `preserves structured mailbox data and marks only teammate-authored fields` | Summary, questions, metadata, proposed actions, message bodies/payloads, typed/custom artifacts, and completion data carry teammate provenance. Typed structure survives; relay-owned and caller-authored fields are not mislabelled. Spoofed provenance is overwritten. |
| Best-effort notification loss | [Relay route tests](../relay/src/routes/a2a.test.ts): both `keeps committed handoffs and recipient events retrievable when notification enqueue is ...` cases; [dispatcher tests](../relay/src/notifications/dispatcher.test.ts): retry exhaustion and queue overflow | A real dispatcher with zero queue capacity drops jobs; a test sink throws during enqueue. Both create and append still return successful storage receipts and remain retrievable with durable recipient events. Fake Slack transport tests separately establish bounded retry failure; no real webhook is called. |

## Failure found and fixed

The interrupted-enqueue proof initially returned HTTP 500 after the mailbox
transaction had already committed. The notification helper now contains sink
exceptions, retaining the successful storage receipt. Its warning includes only
notification kind and thread ID, not the thrown error, message body, or webhook.
This follows the existing best-effort notification boundary; it does not introduce
an outbox, a persistent notification queue, or a notification delivery receipt.

## Reproduce

Install locked dependencies and migrate the disposable test database first, as
described in [CONTRIBUTING.md](../CONTRIBUTING.md). Do not run database test suites
concurrently against this database: integration files and process harnesses reset
shared state. The e2e global setup builds the binaries used by its process tests.

```bash
pnpm --filter agentrelay-mcp exec vitest run src/a2a-client.test.ts src/provenance.test.ts src/tools/tools.test.ts

RELAY_TEST_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay \
  RELAY_TEST_TRUNCATE_VIA_PSQL=1 pnpm --filter relay test:integration

RELAY_TEST_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay \
  RELAY_TEST_TRUNCATE_VIA_PSQL=1 pnpm --filter agentrelay-e2e exec vitest run \
  src/handoff-roundtrip.e2e.test.ts src/mailbox-reliability.e2e.test.ts

pnpm lint
pnpm -r typecheck
pnpm -r build
env -u RELAY_TEST_DATABASE_URL -u RELAY_DATABASE_URL \
  pnpm --filter @agentrelay/protocol --filter relay --filter agentrelay-mcp --filter agentrelay-node test

RELAY_TEST_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay \
  RELAY_TEST_TRUNCATE_VIA_PSQL=1 pnpm --filter agentrelay-e2e test
```

## Limits

- Response loss and notification faults are deterministic local injections, not
  real network partitions or successful Slack delivery.
- Relay restart is process replacement with preserved database and secrets, not
  machine power loss, Postgres crash recovery, backup/restore, or disaster recovery.
- Receiver offline means no recipient MCP process. It does not prove portable
  wake-up, unattended model processing, or a remote local-machine effect.
- A storage receipt, a durable replay event, retrieval, and a reply are distinct
  facts. Notification success or loss changes none of their meaning.
- These tests do not replace the two-owner/two-machine proof or repeated-use
  evaluation, and make no throughput, latency, or production availability claim.
