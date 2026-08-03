# Delivery lease control plane

- **Date:** 2026-08-02
- **Status:** Implemented and covered at the Relay service/HTTP boundary; the first
  foreground Node checkpoint is implemented, while Relay restart, OS-process host
  recovery, and two-machine proof remain pending.
- **Decision:** Build a database-backed Node delivery API before starting a local
  runtime.
- **Scope:** Poll, claim, start, renew, complete, release, retry discovery, and
  relay-owned cancellation for one Node and one active Mission turn.

## Question

What is the smallest delivery contract that lets a Node execute Mission work after
disconnects and retries without allowing a delayed process to publish a second result?

## Decision

Keep `node_deliveries` as the current-state projection and add append-only operation
receipts for every state-changing delivery operation.

- Cursor polling discovers newly stored work. It never claims work.
- A separate cursorless recovery scan returns retryable work with an old cursor and
  active or expired leases.
- `claim` creates a server-generated lease, increments the attempt number, and uses
  that attempt number as the monotonically increasing fencing token.
- `start` records the boundary between a durable claim and host execution.
- `renew` retains the lease identity and fence while extending only from the relay's
  current database time. If Mission expiry already caps the active deadline, a
  renewal records a fresh authority-confirming receipt without shortening it.
- `complete` atomically appends the authenticated Mission result, derives subsequent
  deliveries, logically settles the source, and marks its transport acknowledged.
- `release` returns transient work to stored state with relay-controlled backoff or
  dead-letters terminal and exhausted work.
- Relay-owned cancellation closes work invalidated by sibling settlement, workspace
  revocation, or Node revocation. Mission-wide terminal reconciliation remains a
  separate pending control-plane responsibility.

The wire never accepts Node identity, participant identity, server time, lease expiry,
lease duration, a local path, or runtime policy. Those values come from authentication,
stored Mission routing, relay policy, and the database clock.

## Implemented surface

Migration `relay/drizzle/0007_delivery_claims.sql` extends the durable delivery
projection and adds append-only operation receipts. The authenticated routes are:

- `POST /agents/me/missions` for participant-owned Mission creation;
- `GET /node/v1/missions`, `GET /node/v1/missions/:missionId`, and
  `POST /node/v1/missions/:missionId/accept` for assignment and exact acceptance;
- `GET /node/v1/deliveries` for new cursor work and
  `GET /node/v1/deliveries/recoverable` for cursor-independent retry work; and
- `POST /node/v1/deliveries/:deliveryId/{claim,start,renew,complete,release}` for the
  fenced lifecycle.

Mission creation is limited to one of its two participants and is fenced by active
agent, Node, workspace, and mutual-block state. Fresh acceptance, claims, starts,
renewals, completions, and releases revalidate the stored routing authority under the
same lock hierarchy. Node, workspace, and agent revocation cancel affected active
work transactionally without deleting historical Mission events. A committed mutual
block fences fresh Mission and authority-bearing delivery mutations; it does not
rewrite the historical ledger.

## Concurrency boundary

Each Node mutation uses this lock order:

1. Serialize with Node credential rotation and revocation.
2. Revalidate the exact active credential, Node, owner, participant, and workspace.
3. Resolve the Mission ID only through the exact Node-scoped delivery.
4. Lock the Mission, revalidate all participant routing, then lock the exact delivery
   row with `SELECT ... FOR UPDATE`.
5. Resolve the exact Node-scoped idempotency receipt under those locks. Replay still
   checks routing/revocation and cancellation; claim/start/renew replay also checks
   current mutual trust, while complete/release returns only historical evidence.
6. For a fresh mutation, lock and revalidate the Mission trust boundary.
7. Read `clock_timestamp()` after blocking locks are held, then recheck Mission
   status/expiry, delivery status/settlement, lease ID, fence, and deadline.
8. Commit the delivery projection, any resulting Mission event, receipt, and audit
   evidence together.

PostgreSQL documents that `FOR UPDATE` blocks competing writers and lockers on the
same row until the transaction ends. Under Read Committed, a waiter receives the
updated row and its predicate is re-evaluated, which is the behavior needed for an
exact delivery ID. PostgreSQL also distinguishes `clock_timestamp()` from `now()`:
the former is actual wall-clock time, while the latter is fixed at transaction start.
That distinction prevents a renewal that waited behind a lock from validating against
a stale timestamp.

`SKIP LOCKED` is deliberately not part of the claim-by-ID operation. PostgreSQL calls
out its inconsistent view and recommends it for queue-like multi-consumer selection.
It may become useful for a future server-side `claim-next` operation, but the first
Node polls durable identities and then claims one exact delivery.

## Idempotency replay is not lease authority

An exact operation replay returns the stored output with `replayed: true`; the same
Node-scoped key with different operation input is rejected. Routing and revocation
authority are checked before every replay, and a cancelled delivery cannot replay an
old receipt.

Claim, start, and renew replays additionally require the current Mission trust
boundary because their result can expose or prolong execution authority. Complete
and release receipts are historical: their exact response may still be recovered
after a later teammate block because the mutation already committed. That exception
does not grant a new host action. Before any host effect, a Node must compare the
response with the delivery's current durable lease ID, fence, status, and deadline.

## Failure cases this must prove

- Two concurrent claims cannot both acquire a lease.
- Replaying the same operation key returns the same IDs and response; changing its
  input is rejected.
- A previous lease holder cannot start, renew, release, or complete after re-lease.
- A renewal that began before expiry but waited past expiry is rejected.
- Mission acceptance and its derived activation event use one database timestamp, so
  a skewed Relay host clock cannot extend or shorten Mission authority.
- A lost completion response is recovered from its receipt without a second Mission
  event or downstream delivery.
- A retry remains discoverable after the Node cursor has advanced beyond it.
- Revocation racing a mutation establishes a clear order: if revocation commits first,
  the mutation cannot commit; once revocation returns, no active lease remains.
- The final retry becomes dead-lettered, never stored with no attempt capacity.

These cases have deterministic Postgres coverage in
`relay/src/services/delivery-ledger.test.ts`, with route validation in
`relay/src/routes/node-deliveries.test.ts`, revocation coverage in
`relay/src/services/delivery-revocation.test.ts`, and schema constraints in
`relay/src/db/migration-0007.test.ts`. They prove the in-process Relay boundary, not a
real Node journal, a killed Relay process, or two-machine execution.

## Remaining lifecycle work

- Expired and terminal Mission deliveries are excluded from discovery, so stale rows
  cannot consume a bounded recovery page. The Relay does not yet append an explicit
  `expired`, `blocked`, or `failed` Mission transition when expiry or dead-lettering
  makes progress impossible.
- Mission assignment discovery is newest-first with a stable Node-scoped keyset
  cursor. The foreground Node durably advances one bounded page after servicing
  delivery work, while the Relay uses database time to exclude expired
  `awaiting_acceptance` rows so poison pages cannot hide live work or delay lease
  recovery at the start of a cycle.
- The foreground Node now persists its cursor, exact operation intent, lease/fence,
  Mission session, and host-turn mapping in an atomic local journal. Its in-process
  runner reconstruction proves no duplicate fake-host turn, but Relay restart,
  OS-process host recovery, and two-machine correctness remain unproved end to end.

The local checkpoint and its deliberate nonclaims are recorded in
[`002-foreground-node-runtime.md`](002-foreground-node-runtime.md).

## Alternatives rejected for this slice

- **Socket delivery as truth:** notifications can be lost or duplicated and do not
  prove processing.
- **Client-selected lease duration or timestamps:** a Node could retain authority
  beyond relay policy or validate itself with a skewed clock.
- **Separate result and acknowledgement commits:** this creates a recoverable but
  unnecessary intermediate state. Atomic completion provides the stronger invariant
  that an acknowledged delivery always has its Mission result.
- **A manager model choosing retries:** delivery correctness is deterministic state,
  not a reasoning task.

## Primary sources

- [PostgreSQL row-level locking](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS)
- [PostgreSQL `SELECT` locking and `SKIP LOCKED`](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)
- [PostgreSQL Read Committed behavior](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED)
- [PostgreSQL current-time functions](https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT)

This is an implementation decision for AgentRelay's internal Node envelope. It does
not define or claim A2A wire compatibility.
