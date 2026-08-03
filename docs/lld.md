# Low-level design: current mailbox contracts

> **Scope:** Implemented code on `main` as of 2026-08-02.
> This is a compact source-oriented reference, not a promise that planned fields or
> routes exist. Future Node and Mission contracts belong to
> [`RFC 001`](rfcs/001-agentrelay-node-and-missions.md) until implemented.

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
adapter. The executable Mission contracts, deterministic coordinator, fake adapter,
and backend-Android proof fixture live in `protocol/`.

## Protocol workspace

`@agentrelay/protocol` currently implements:

- strict Mission, contract, message, artifact, delivery, run, and evidence schemas;
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

The coordinator is pure and in memory. `applied_events` is test evidence, not a
durable ledger or receipt store. The fixture uses pre-scripted fake outcomes, an
explicit pre-kickoff acknowledgement queue, and pre-authored expected repository
snapshots; it does not show a model writing code, a relay surviving restart, or two
Nodes collaborating across machines. Exact evidence and nonclaims are recorded in
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
| `audit_log` | Invite, handoff/message, and block mutation records: actor, action, resource, metadata, request ID, timestamp. |
| `agent_blocks` | Blocker/blocked pairs enforced for new handoffs and each existing-thread append. |
| `invites` | Signed-token hash, target handle/role, inviter, expiry, use timestamp, and redeemed agent. |

The current identity represents a logical developer/agent. It does not distinguish
device, workspace, repository checkout, runtime, or Mission lease.

## Authentication

- Admin routes use `Authorization: Bearer <RELAY_ADMIN_TOKEN>`.
- Agent routes use an issued `ah_live_*` or `ah_test_*` bearer key.
- The relay hashes incoming API keys with `RELAY_PEPPER` and looks up active hashes.
- Registration and invite redemption return a raw key once; local config stores it
  in a mode-0600 file.
- Self-rotation revokes all active keys for the caller, writes a replacement, and
  updates local config after the response.

Node-scoped credentials do not exist yet.

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
| `DELETE` | `/admin/agents/:id` | Disable an agent and revoke its keys. |
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

`/agents` is authenticated. The stored card JSON is not currently exposed through an
A2A well-known discovery URL.

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
message append, and block/unblock. Registration, card updates, key rotation, and agent
disable still write no audit row. Audit also does not record commands, tool
arguments/results, file edits, tests, or permission decisions performed by a local
coding-agent host.

The relay has authenticated block endpoints. CLI `block`/`unblock` writes the relay
and local trust file in a fail-safe order. `block` activates the local kill switch
before attempting the relay write; if the relay is unavailable, the local block stays
active. `unblock` clears the relay first and only then clears local trust; either
partial failure therefore leaves local denial active. Every invocation retries the
relay operation even when local state already matches, and the running MCP reloads
trust before accepting a handoff. The two stores still cannot commit atomically, so
retry a reported partial failure and do not claim continuously observed cross-layer
revocation until the Node verifies it.

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
runtime scheduler. The next slice persists explicit Nodes, workspace bindings,
Missions, events, deliveries, claims, runs, acknowledgements, and idempotency receipts
while keeping the mailbox API as a compatibility and inspection surface.
