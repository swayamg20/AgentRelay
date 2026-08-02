# Low-level design: current relay contracts

> **Scope:** Current repository implementation as of 2026-08-02.
> This is a compact source-oriented reference, not a promise that planned fields or
> routes exist. Unimplemented local Node runtime behavior remains in
> [`RFC 001`](rfcs/001-agentrelay-node-and-missions.md).

## Repository layout

```text
.
├── landing/             GitHub Pages landing page
├── protocol/            Mission schemas, coordinator, fixtures, and adapter contract
├── relay/               Hono, Drizzle, Postgres relay
├── mcp-server/          agentrelay-mcp package and agentrelay CLI
├── tests/e2e/           relay plus two-MCP-process integration harness
├── docs/                product, implementation, operations, and RFC docs
├── docker-compose.yml   Postgres dev service and self-host relay profile
└── package.json         pnpm workspace scripts
```

There is currently no `node/` daemon, persistent event consumer, or real runtime
adapter. The relay does expose Node identity/workspace routes plus a public Mission
and delivery control plane. The executable contracts, deterministic coordinator,
fake adapter, and backend-Android proof fixture live in `protocol/`; they still do
not prove execution on two machines.

## Protocol workspace

`@agentrelay/protocol` currently implements:

- strict Mission, contract, message, artifact, delivery, run, and evidence schemas;
- relay-visible Node/workspace descriptors, a trusted Mission-event envelope, a
  client append-input contract that excludes relay-owned identity/order fields, and
  new-work cursor, recovery-page, delivery-operation input/result, lease, fencing,
  cancellation, and receipt contracts;
- pure Mission lifecycle and fenced-delivery reducers;
- a replayable four-event coordinator boundary for participant acceptance, completed
  turns, explicit contract acknowledgement, and local verification evidence;
- one-current-participant routing, consecutive contract revision pause/activation,
  contract-scoped readiness, required local command IDs, turn limits, terminal-event
  rejection, verification-round fencing, and exact event/idempotency/delivery replay
  handling;
- a runtime-neutral host adapter plus deterministic fake; and
- reproducible backend and Android fixture repositories, a golden 14-event transcript,
  executable backend/Android/contract/public checks, and a separate hidden evaluator.

The coordinator remains a pure reducer. Its `applied_events` projection is test and
replay state, while the relay ledger persists validated event envelopes and reducer
snapshots. The fixture still uses pre-scripted fake outcomes, an explicit pre-kickoff
acknowledgement queue, and pre-authored expected repository snapshots; it does not
show a model writing code, an authenticated Node consuming work, or two Nodes
collaborating across machines. Exact evidence and nonclaims are recorded in
[`experiment 001`](experiments/001-backend-android-deterministic-proof.md).

## Relay tables

Column-level truth lives in [`relay/src/db/schema.ts`](../relay/src/db/schema.ts) and
the committed Drizzle migrations.

| Table | Current purpose |
|---|---|
| `agents` | Developer identity: handle, email, display name, role, active/disabled state. |
| `agent_cards` | One-to-one card JSON, skills, repository labels, optional notification webhook field. |
| `api_keys` | Hashed bearer keys with label, last-used timestamp, and revocation timestamp. |
| `handoffs` | Sender, recipient, summary, intent, four-state lifecycle, initial and completion artifacts, proposed action, metadata, timestamps, idempotency key. |
| `messages` | Append-only handoff messages with separate generic payload and typed artifacts, per-thread sequence, and idempotency key. |
| `audit_log` | Invite, handoff/message, block, Agent-disable, Node/workspace, Mission, and delivery mutation records: actor kind, nullable Agent actor ID, action, resource, metadata, request ID, timestamp. Admin and relay-system actors never borrow an Agent ID. |
| `agent_blocks` | Blocker/blocked pairs enforced for handoff content and as a transaction fence for later Mission activation, events, and delivery mutations. |
| `invites` | Signed-token hash, target handle/role, inviter, expiry, use timestamp, and redeemed agent. |
| `nodes` | Device identity owned by one agent, with relay-visible capabilities, best-effort presence timestamp, and revocation state. |
| `node_credentials` | Hashed Node-only bearer credentials with label, last-used timestamp, and independent revocation timestamp. A partial unique index permits at most one active credential per Node; raw tokens are never stored. |
| `workspace_bindings` | A Node-local logical alias represented at the relay by repository URL and allowed base refs. It deliberately has no checkout path. |
| `missions` | Immutable coordinator config, current reducer projection/status/contract version, sequence, creator, and expiry. |
| `mission_participants` | The exact agent, Node, and workspace binding selected for each two-party Mission, plus that participant's idempotent contract and opaque local-policy-grant acceptance receipt. |
| `mission_events` | Append-only type-specific coordinator payload with relay-generated event ID, Mission sequence/time, service-supplied actor, source delivery, idempotency key, and causal parent. |
| `node_deliveries` | Per-Node opaque cursor pointing to one Mission event, with `stored`, `leased`, `executing`, `acknowledged`, `cancelled`, or `dead_lettered` state; attempts, relay lease/fence, retry availability, settlement, and terminal evidence. |
| `delivery_operation_receipts` | Append-only Node `claim`/`start`/`renew`/`complete`/`release` and relay `lease_expired`/`cancel` evidence, including idempotency identity, attempt, lease/fence, transition, input, output, and database timestamp. |

Public mailbox authentication still represents a logical developer/agent. Until a
separate owner/organization identity exists, that agent credential is the enrollment
authority for its own Nodes. Node credentials now exist for the identity/workspace
surface and delivery leases, but there is no local checkout identity, runtime
session, or Mission-wide execution lease.

## Authentication

- Admin routes use `Authorization: Bearer <RELAY_ADMIN_TOKEN>`.
- Agent routes use an issued `ah_live_*` or `ah_test_*` bearer key.
- The relay hashes incoming API keys with `RELAY_PEPPER` and looks up active hashes.
- Registration and invite redemption return a raw key once; local config stores it
  in a mode-0600 file.
- Self-rotation revokes all active keys for the caller, writes a replacement, and
  updates local config after the response.
- Node routes accept only `ar_node_live_*` or `ar_node_test_*` credentials; agent
  credentials cannot authenticate them, and Node credentials cannot authenticate
  agent or A2A routes.
- Enrollment and credential rotation return a raw Node token once. The relay stores
  only its peppered hash and salt. The owner-only Node summary exposes the current
  credential ID, never its token or hash. Rotation must compare-and-swap that exact
  ID; stale or concurrent requests return `state_changed` without mutation. A lost
  response is recovered by listing the current ID and rotating that generation once
  more.
- Node authentication requires an active credential, active Node, and active owning
  agent. Successful requests update credential last-used and Node presence on a
  best-effort, debounced path.

## Mission and delivery ledger

`relay/src/services/mission-ledger.ts` and `delivery-ledger.ts` back public agent and
Node routes.

- Mission creation validates the shared protocol config, resolves every participant
  to exactly one active `agent + Node + workspace alias + repository URL`, stores
  that routing choice, and uses the manifest Mission ID as exact creation-replay
  identity.
- Participant acceptance stores one strict receipt for the immutable Mission ID,
  exact shared contract, requested local-policy profile, and opaque grant hash. Only
  the second independent receipt derives aggregate activation and first work.
- A Mission-scoped lock serializes event publication. The service rebuilds the
  reducer, validates source delivery ownership, work kind, contract version, and
  verification round, then commits the event, projection, source settlement, derived
  deliveries, and audit together. Node completion is the authenticated and fenced
  public path for publishing a runtime result; there is no raw event-append route.
- New-work polling reads strictly increasing global-`bigserial` cursors and only due,
  unsettled `stored` work. Recovery is cursorless and returns due stored retries plus
  `leased` or `executing` work. Both join the Mission and require `active` or
  `verifying` state with `expires_at` later than the relay database clock.
- Claim issues a relay-generated lease for 60 seconds or the remaining Mission
  lifetime, whichever is shorter. It increments `attempt_count`, uses that attempt as
  the fencing token, and records a receipt. Start, renew, complete, and release
  require the exact lease and fence; renewal extends only from the database clock.
- Exact Node-scoped idempotency replay returns the stored operation result and rejects
  a changed input. New mutations revalidate the active credential, Node owner,
  participant, workspace, Mission route, trust boundary, state, lease, and fence.
- Completion atomically publishes the Mission result, settles the source,
  acknowledges transport, derives later work, and writes its receipt and audit row.
  Transient release returns work to `stored` with relay-controlled backoff; permanent,
  policy, exhausted, or Mission-bound failure dead-letters it.
- Reclaiming an expired lease below the attempt limit records a Relay
  `lease_expired` receipt and audit row before issuing the next claim. Reclaiming an
  expired final attempt records the terminal Node `claim` receipt with
  `claim_outcome: dead_lettered` and no separate expiry receipt. Expired Missions are
  not advertised, but no background or lazy reconciler changes the Mission row to
  `expired` or turns one dead letter into Mission-wide failure and cancellation.

## HTTP surface

Source of truth: [`relay/src/server.ts`](../relay/src/server.ts) and
`relay/src/routes/`.

### Public system and invite routes

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/healthz` | Process liveness; returns `{ "status": "ok" }`. |
| `GET` | `/readyz` | Calls the configured readiness probe. |
| `POST` | `/invites/:jti/redeem` | Verifies and atomically redeems a signed, unexpired, unused invite. |

There is no `/metrics`, `/inbox/:id`, or
`/.well-known/agent-card.json` route in the current server.

### Admin routes

| Method | Path | Behavior |
|---|---|---|
| `POST` | `/admin/agents` | Register an agent and issue the initial API key. |
| `POST` | `/admin/agents/:id/keys/rotate` | Admin rotation for an agent ID. |
| `DELETE` | `/admin/agents/:id` | In one transaction, disable an Agent, revoke its keys, owned Nodes, active Node credentials and workspace bindings, cancel affected active deliveries, and write admin audit evidence. |
| `POST` | `/admin/invites` | Mint a signed, expiring, single-use invite URL. |

### Authenticated agent routes

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/agents/me` | Return caller identity and card metadata. |
| `POST` | `/agents/me/keys/rotate` | Rotate the caller's API key. |
| `GET` | `/agents/me/audit` | Query relay audit rows where the caller is the actor. |
| `GET` | `/agents` | List active teammate roster and public card fields. |
| `PUT` | `/agents/me/card` | Update caller role, skills, repo labels, or webhook field. |
| `GET` | `/agents/me/block` | List caller's server-side blocks. |
| `POST` | `/agents/me/block` | Add a server-side block by handle. |
| `DELETE` | `/agents/me/block/:handle` | Remove a server-side block. |
| `POST` | `/agents/me/nodes` | Enroll a Node and return its raw Node credential once. Duplicate active names return `state_changed`; they never replay a secret. |
| `GET` | `/agents/me/nodes` | List owner-only summaries for every owned Node, including revoked history and the current active credential ID or `null`. No token or hash is exposed. |
| `POST` | `/agents/me/nodes/:nodeId/credentials/rotate` | Require `{expected_credential_id}`, atomically replace only that active generation, and return the new raw credential once. A stale generation returns `state_changed`. |
| `DELETE` | `/agents/me/nodes/:nodeId` | Idempotently revoke an owned Node, its active credentials and bindings, and active deliveries across affected Missions while retaining history. |
| `POST` | `/agents/me/missions` | Validate and create the exact manifest Mission, resolve both persisted participant routes, and return the Mission state and bindings. Fresh already-expired manifests are rejected using relay database time; exact manifest-ID replay returns the prior result even after expiry. |

`/agents` is authenticated. The stored card JSON is not currently exposed through an
A2A well-known discovery URL.

### Authenticated Node routes

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/node/v1/me` | Return the active Node's relay-visible descriptor. |
| `POST` | `/node/v1/workspaces` | Register one logical alias, repository URL, and allowed base-ref set. An exact active replay returns the existing binding; changed input conflicts, and a revoked alias stays retired. |
| `GET` | `/node/v1/workspaces` | List the Node's active and revoked relay-visible bindings. |
| `DELETE` | `/node/v1/workspaces/:alias` | Idempotently revoke a binding and active deliveries across affected Missions; a never-registered alias returns `workspace_not_found`. |
| `GET` | `/node/v1/missions` | List assignments for this Node, optionally filtered by Mission lifecycle status. This is assignment history, not delivery discovery. |
| `GET` | `/node/v1/missions/:missionId` | Return this Node's exact Mission assignment and acceptance state. |
| `POST` | `/node/v1/missions/:missionId/accept` | Store or exactly replay this participant's contract and local-policy acceptance receipt; the second participant activates the Mission. |
| `GET` | `/node/v1/deliveries` | Cursor-page newly due, unsettled `stored` work for active/verifying, unexpired Missions. Reading does not claim it. |
| `GET` | `/node/v1/deliveries/recoverable` | Cursorless scan for due retried `stored` work plus `leased` or `executing` work on active/verifying, unexpired Missions. |
| `POST` | `/node/v1/deliveries/:deliveryId/claim` | Issue or exactly replay a relay lease, incremented attempt, and fencing token; lazily reconcile an expired lease before reclaim. |
| `POST` | `/node/v1/deliveries/:deliveryId/start` | Move the exact active lease from `leased` to `executing`. |
| `POST` | `/node/v1/deliveries/:deliveryId/renew` | Retain lease/fence and extend its deadline from relay database time, bounded by Mission expiry. |
| `POST` | `/node/v1/deliveries/:deliveryId/complete` | Atomically publish the authenticated result and move transport from `executing` to `acknowledged`. |
| `POST` | `/node/v1/deliveries/:deliveryId/release` | Retry with relay backoff or dead-letter the exact leased/executing attempt according to the typed disposition. |

Workspace registration accepts no checkout path, command, credential-bearing URL,
or local policy. Node-authenticated workspace mutations re-check the credential under
the same Node transaction lock used by rotation and revocation, so a completed
revocation fences later mutations. Delivery operations use relay-issued authority;
the wire cannot choose Node identity, server time, lease duration, lease expiry,
working directory, runtime policy, or command permission.

## JSON-RPC surface

`POST /a2a` accepts JSON-RPC 2.0 envelopes with bearer authentication. Current
methods are:

- `message/send`
- `tasks/get`
- `tasks/list`
- `tasks/update`
- `tasks/cancel`
- `agents/list`

These names and result shapes are A2A-inspired extensions for the mailbox. They are
not evidence by themselves of compatibility with the current A2A specification.

### `message/send`

Without `task_id`, creates a handoff and initial message. Required fields include an
explicit recipient, intent, and text message; artifacts and proposed action are
optional according to the intent invariant. With `task_id`, appends a message to an
active handoff for one of its two participants.

For a new handoff, the service:

- Resolves the caller from the bearer key.
- Validates the recipient and block relationship under the same directed-pair
  transaction lock used by block/unblock.
- Enforces `inform`, `ask_question`, or `propose_action` shape.
- Writes handoff/message and audit data transactionally.
- Uses a per-handoff advisory lock for message sequence allocation.
- Applies idempotency behavior when
  `params.metadata.client_idempotency_key` is present.

For an append, the service verifies participation, active state, and the receiving
participant's current block list under that directed-pair lock, then allocates the next
sequence under a per-handoff advisory lock and applies the same metadata idempotency key. Generic `send_message.payload`
and typed message artifacts are stored in separate JSON columns and returned intact.
Exact idempotency replay comparison includes both fields. Idempotency-key advisory
locks serialize simultaneous retries, and an exact committed replay is resolved
before mutable block or terminal-state gates. The relay also recovers the previous
MCP client's metadata-embedded append payload when no top-level payload is present.

### `tasks/get`

Returns one full handoff thread. Only sender or recipient may read it.

### `tasks/list`

Lists caller-owned sent or received handoffs with status and time filters. Current
pagination is incomplete: `next_cursor` is always `null`, and `unread_messages` is
hardcoded to `0`.

### `tasks/update` and `tasks/cancel`

Supported transitions are:

```text
pending --accept--> accepted --complete--> completed
pending --cancel--------------------------------> cancelled
```

Recipient owns accept and complete. Sender owns cancel. Completed and cancelled are
terminal. Completion artifacts are persisted separately from the original handoff
artifacts and returned by both the completion response and `tasks/get`; `view_thread`
also returns the completion summary, provenance-wrapped when read by its peer. Accepting an
already accepted handoff returns its current row, but complete and cancel do not yet
have general idempotency receipts or replay guarantees. A recipient cannot accept a
pending handoff after blocking its sender, and a blocked recipient cannot send
completion summary/artifact content back to the sender.

### `agents/list`

Returns every active teammate. The MCP tool sends optional role, skill, and repository
filters, but the relay currently ignores those filters.

## MCP tool surface

Source of truth: [`mcp-server/src/tools/index.ts`](../mcp-server/src/tools/index.ts).

| Tool | Current behavior |
|---|---|
| `handoff_to_teammate` | Create a typed handoff with summary, intent, artifacts, question/metadata, and optional proposed action. |
| `check_inbox` | List received handoffs through `tasks/list` with provenance-wrapped teammate summaries. |
| `accept_handoff` | Fetch and accept a thread, provenance-mark teammate text/structured data, and return a local trust decision. |
| `view_thread` | Read a participant thread without changing lifecycle state; only teammate-authored fields are marked. |
| `send_message` | Append a message and preserve its generic payload separately from typed artifacts. |
| `complete_handoff` | Transition an accepted handoff to completed and persist result artifacts. |
| `list_teammates` | Fetch the active roster. |

There is no `draft_proposed_action`, pair, listen, wait, runtime-start, or Mission
tool today.

## Artifact types

Current MCP write schemas support:

- `file_diff`
- `file_ref`
- `test_command`
- `api_contract`
- `link`

The relay contract itself accepts an extensible object with a nonempty `type`, so a
direct A2A client can add a custom artifact kind. MCP reads tolerate legacy/custom
objects and mark them structurally instead of rejecting the entire thread.

Artifacts can accompany initial handoffs, messages, and completion. They remain typed
objects, but every teammate-authored object returned by `accept_handoff` or
`view_thread` receives an `agentrelay_provenance` marker that overwrites any spoofed
marker supplied by the peer. Generic teammate payloads, handoff metadata, and
proposed-action objects get the same marker. A known metadata `question` plus free-form
summary/message/rationale text retain the explicit wrapper. Relay-owned idempotency
keys are removed before metadata is returned by MCP. Provenance is context, not
execution authority: never treat an artifact
command, diff, link, or inline contract as locally authorized execution.

## Local files

Default location is `~/.agentrelay/`:

- `config.json`: relay URL, agent handle and ID, API key, optional default session ID.
- `trust.yaml`: schema version, teammate entries, unknown-sender policy, defaults,
  and local blocked list.

`AGENTRELAY_HOME`, `AGENTRELAY_CONFIG_PATH`, and `AGENTRELAY_TRUST_PATH` can override
paths for tests or controlled environments.

The MCP server reloads local trust before each `accept_handoff`, computes a trust
overlay for the sender, and returns it to the agent. No production code applies
`auto_write_paths` dynamically to a Codex or Claude runtime; `isPathAutoWritable` is
currently exercised only by tests and exports.

## CLI surface

The `agentrelay` binary currently provides:

- `register`
- `invite <handle>`
- `join <url>`
- `install --client <claude-code|codex|all>`
- `rotate-key`
- `doctor [--fix] [--json]`
- `audit`
- `block`, `unblock`
- `trust list`, `trust set`, `trust reset`
- `mcp`

`join` writes local credentials, adds the inviter to local trust, and invokes install
for both clients. `install` writes the Claude MCP entry to `~/.claude.json`, the
Claude permission overlay to `~/.claude/settings.json`, and Codex configuration to
`~/.codex/config.toml`.

The generated settings are recommendations. Documentation must not claim every host
enforces identical allow/ask/deny semantics or that a returned trust overlay changes
an active session.

## Notification dispatcher

The relay process owns a bounded in-memory FIFO queue and a Slack webhook worker.
Notifications are enqueued after the domain transaction commits. Dispatch retries
selected failures with backoff and does not roll back the persisted handoff.

Important limits:

- Queue entries do not survive relay restart.
- New jobs are dropped when the queue is full.
- There is no delivery acknowledgement from the receiving agent.
- Card updates encrypt submitted webhook URLs into the authenticated `enc:v1:` form
  expected by the dispatcher. Existing plaintext rows from an older deployment must
  be resubmitted; the dispatcher continues to fail closed on unmarked values.
- Both card update and dispatch restrict targets to exact HTTPS
  `hooks.slack.com/services/...` URLs, and the HTTP poster refuses redirects.

## Audit and revocation

Relay audit rows cover invite mint/redeem, handoff create/accept/complete/cancel,
message append, block/unblock, Node enroll/credential-rotate/revoke, workspace
register/revoke, Mission create/participant accept/event append, every public Node
delivery mutation, and relay lease-expiry/cancellation transitions. The matching
`delivery_operation_receipts` retain exact Node-operation results and relay-owned
transport history. Audit actors are explicit: authenticated Agent mutations retain an
Agent ID, while admin and relay-system mutations use a typed actor with no fabricated
Agent identity. Agent registration, card updates, and agent-key rotation still write
no audit row. Audit also does not record commands, tool arguments/results, file edits,
tests, or permission decisions performed by a local coding-agent host.

The relay has authenticated block endpoints. CLI `block`/`unblock` writes the relay
and local trust file in a fail-safe order. `block` activates the local kill switch
before attempting the relay write; if the relay is unavailable, the local block stays
active. `unblock` clears the relay first and only then clears local trust; either
partial failure therefore leaves local denial active. Every invocation retries the
relay operation even when local state already matches, and the running MCP reloads
trust before accepting a handoff. The two stores still cannot commit atomically, so
retry a reported partial failure and do not claim continuously observed cross-layer
revocation until the Node verifies it. Inside the relay, Mission creation,
acceptance, event publication, and new delivery mutations use the block-pair trust
fence. Node, workspace, or owner revocation cancels active deliveries across every
Mission whose routing authority it invalidates; immutable Mission, delivery,
receipt, and audit history remains.

## Error model

REST failures return a stable envelope with `code`, `message`, `request_id`, and
optional details. `/a2a` wraps relay failures in JSON-RPC errors. Current symbolic
codes are defined in [`relay/src/errors.ts`](../relay/src/errors.ts); consumers should
not copy an error table from documentation without checking that source.

## Configuration

Relay configuration is validated in [`relay/src/config.ts`](../relay/src/config.ts).
Required values include database URL, API-key pepper, encryption key, admin token,
metrics token, invite secret, and public URL. Runtime defaults include environment,
log level, port, audit-retention days, rate-limit value, and pool size.

Some configured values are not yet wired to behavior: there is no metrics route,
rate-limit middleware, audit-retention job, or OpenTelemetry pipeline in the current
server.

The self-host Docker profile currently does not forward the required
`RELAY_INVITE_SECRET` into the relay container. Until that configuration gap is
fixed, use the host-run contributor flow or explicitly correct the deployment config
before relying on invite onboarding.

## Validation commands

From the repository root:

```bash
pnpm lint
pnpm -r typecheck
pnpm -r build
pnpm --filter @agentrelay/protocol --filter relay --filter agentrelay-mcp test
```

Database-backed tests require Postgres and migrations:

```bash
pnpm db:up
RELAY_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay \
  pnpm --filter relay db:migrate
RELAY_TEST_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay \
  pnpm --filter relay test:integration
RELAY_TEST_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay \
  pnpm --filter agentrelay-e2e test
```

`pnpm -r test` includes the E2E workspace and is not the database-free unit-test
command.

## Boundary with the next design

Do not extend `accepted_by_session` or the four-state handoff table into a distributed
runtime scheduler. Nodes, credentials, workspace bindings, Missions, events, and
deliveries have a separate model and public control plane. The next slice is a local
Node consumer with a durable processing journal, worktree/policy enforcement, and
real runtime adapters, plus a real two-machine proof. Mission-level expiry and
dead-letter terminal reconciliation is still a separate relay gap; the mailbox API
remains a compatibility and inspection surface.
