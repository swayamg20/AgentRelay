# Low-level design: current relay contracts

> **Scope:** Current repository implementation as of 2026-08-20.
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
├── node/                Node, Capsule wire, fake runtime, and guarded Codex boundaries
├── tests/e2e/           relay, MCP, Node, and detached-Capsule process harnesses
├── docs/                product, implementation, operations, and RFC docs
├── docker-compose.yml   Postgres dev service and self-host relay profile
└── package.json         pnpm workspace scripts
```

The private `agentrelay-node` workspace now provides a foreground daemon and durable
consumer for fake-adapter turn deliveries. It validates local workspace/policy state,
journals discovery and operation intent, and can recover exact host events from an
independently persistent fake Mission Capsule after the Node process is killed. There
is now a provider-neutral Capsule server, injected Codex runner, provider guardian,
strict v2 descriptor, persistent adapter, and policy-selected read/write provisioner.
Internal APIs compose them under the private authority boundary, but write activation
deliberately stops before the credential is claimed or the guardian, provider, or
runner is opened. No polling CLI selects either mode and no test executes a real model
turn. The provider process uses its private runtime home as its operating-system
working directory while app-server requests retain the logical workspace separately;
the workspace is pinned untrusted and effective shell/MCP state is attested. The
guardian owns generation spawn and live supervision; its prearmed detached
reaper owns teardown proof and post-absence quiescence. There is also no
contract-acknowledgement or verification-delivery handler, so this still does not
prove execution on two machines. A Linux-only Codex containment library now exists,
and its dedicated process test starts pinned Codex through both guarded boundaries.
The non-claiming `doctor-codex` command verifies only the pinned Linux/x64 artifacts
and version. Separately, the selected persistent
fake-Capsule path now installs and continuously enforces one private, fenced runtime
grant. This does not activate Codex.

## Protocol workspace

`@agentrelay/protocol` currently implements:

- strict Mission, contract, message, artifact, delivery, run, and evidence schemas;
- relay-visible Node/workspace descriptors, a trusted Mission-event envelope, a
  client append-input contract that excludes relay-owned identity/order fields, and
  new-work cursor, recovery-page, delivery-operation input/result, lease, fencing,
  cancellation, and receipt contracts;
- pure Mission lifecycle and fenced-delivery reducers;
- a replayable five-event coordinator boundary for participant acceptance, completed
  turns, explicit contract acknowledgement, local verification evidence, and the
  Relay-owned terminal Mission event;
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
| `mission_events` | Append-only type-specific coordinator payload with relay-generated event ID, Mission sequence/time, explicit `agent`/`system` actor kind, nullable Agent actor ID, source delivery, idempotency key, and causal parent. Only `mission_terminal` is system-authored. |
| `node_deliveries` | Per-Node opaque cursor pointing to one Mission event, with `stored`, `leased`, `executing`, `acknowledged`, `cancelled`, or `dead_lettered` state; attempts, relay lease/fence, retry availability, settlement, and terminal evidence. |
| `delivery_operation_receipts` | Append-only Node `claim`/`start`/`renew`/`complete`/`release` and relay `lease_expired`/`cancel` evidence, including idempotency identity, attempt, lease/fence, transition, input, output, and database timestamp. |

Public mailbox authentication still represents a logical developer/agent. Until a
separate owner/organization identity exists, that agent credential is the enrollment
authority for its own Nodes. Node credentials now exist for the identity/workspace
surface and delivery leases. The Relay deliberately stores no local checkout path or
runtime-session row and has no Mission-wide execution lease; the experimental Node
keeps its checkout mapping and host-session references in local configuration and its
journal.

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

`relay/src/services/mission-ledger.ts`, `delivery-ledger.ts`, and
`mission-reconciliation.ts` back public agent and Node routes.

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
  `leased` or `executing` work. Both first reconcile eligible `active` or `verifying`
  Missions, then return only unexpired runnable state.
- Claim issues a relay-generated lease for 60 seconds or the remaining Mission
  lifetime, whichever is shorter. It increments `attempt_count`, uses that attempt as
  the fencing token, and records a receipt. Start, renew, complete, and release
  require the exact lease and fence. Renewal extends only from the database clock; if
  Mission expiry already caps the active deadline, it records a fresh authority-
  confirming receipt without shortening that deadline.
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
  `claim_outcome: dead_lettered` and no separate expiry receipt. Final dead letters
  reconcile immediately. Expired or previously dead-lettered Missions also reconcile
  lazily from both delivery discovery routes and before every delivery operation.
  Fresh authority and exact receipt replay are validated only after that fence. For
  `active` or `verifying`, deadline maps to
  `expired/deadline_exceeded/null`; otherwise the earliest unsettled dead-letter
  cursor maps to `failed/delivery_dead_lettered/<delivery-id>`.

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
| `GET` | `/node/v1/missions` | List assignments for this Node with newest-first `after_cursor`/`next_cursor` keyset pagination. An unfiltered list is assignment history; `status=awaiting_acceptance` is the live acceptance view and excludes expired Missions using Relay database time. This is not delivery discovery. |
| `GET` | `/node/v1/missions/:missionId` | Return this Node's exact Mission assignment and acceptance state. |
| `POST` | `/node/v1/missions/:missionId/accept` | Store or exactly replay this participant's contract and local-policy acceptance receipt; the second participant activates the Mission. |
| `GET` | `/node/v1/deliveries` | Lazily reconcile eligible Mission terminal causes, then cursor-page newly due, unsettled `stored` work. Reading does not claim it. |
| `GET` | `/node/v1/deliveries/recoverable` | Lazily reconcile eligible Mission terminal causes, then scan due retried `stored` work plus `leased` or `executing` work without a cursor. |
| `POST` | `/node/v1/deliveries/:deliveryId/claim` | Issue or exactly replay a relay lease, incremented attempt, and fencing token; lazily reconcile an expired lease before reclaim. |
| `POST` | `/node/v1/deliveries/:deliveryId/start` | Move the exact active lease from `leased` to `executing`. |
| `POST` | `/node/v1/deliveries/:deliveryId/renew` | Retain lease/fence and extend its deadline from relay database time, bounded by Mission expiry; at that cap, confirm current authority with a fresh receipt without shortening the deadline. |
| `POST` | `/node/v1/deliveries/:deliveryId/complete` | Atomically publish the authenticated result and move transport from `executing` to `acknowledged`. |
| `POST` | `/node/v1/deliveries/:deliveryId/release` | Retry with relay backoff or dead-letter the exact leased/executing attempt according to the typed disposition. |

Workspace registration accepts no checkout path, command, credential-bearing URL,
or local policy. Node-authenticated workspace mutations re-check the credential under
the same Node transaction lock used by rotation and revocation, so a completed
revocation fences later mutations. Delivery operations use relay-issued authority;
the wire cannot choose Node identity, server time, lease duration, lease expiry,
working directory, runtime policy, or command permission.

The two delivery `GET` routes may write terminal reconciliation state. Mission
assignment list and detail routes remain read-only and do not reconcile. There is no
background scheduler.

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

## Node and Capsule process surface

The private `agentrelay-node` binary has two fake-runtime commands:

- `run` keeps `FakeAgentHostAdapter` inside the foreground Node process.
- `run-capsule` launches or reconnects to one detached fake Capsule per Mission. Its
  state defaults to `state/capsules/<mission-id>/` beside the Node config and can be
  moved with `--capsule-root`.

It also exposes `doctor-codex`, a non-polling Linux/x64 preflight that verifies the
exact pinned Codex and Bubblewrap artifacts plus a bounded `codex --version` process.
It opens no config, journal, Relay client, workspace, descriptor, Capsule, or provider.
There is no `run-codex` command.

`agentrelay-capsule serve --directory <path>` is the internal child-process entry
point. It reads the strict descriptor union: schema v1 opens the fake controller, while
schema v2 pins the Codex runtime contract, CLI version, session scope, socket, and exact
containment recovery handle. Both delegate to `PersistentCapsuleServer` and preserve
the versioned newline-delimited JSON wire. The Codex controller opens only passive
state until an authority-gated start, recovery, or cancellation of a durable turn
activates containment and the provider.

`agentrelay-capsule` reserves inherited fd 3 only for a validated schema-v2 Codex
controller. The Codex-only detached launcher claims one fresh opaque owner credential
for each actual Capsule start and writes it once to that fd; schema v1 leaves the
channel untouched. The Capsule arms one refed, non-resettable 30-second deadline when
the schema-v2 controller is constructed. The credential is read lazily only during
authority-gated activation. Expiry closes or aborts the unclaimed channel and requests
generation retirement. Controller shutdown instead closes or aborts any still-unclaimed
channel and awaits an in-progress read before resolving.

The wire exposes `probe`, `install_authority`, `assert_authority`, `renew_authority`,
`revoke_authority`, `ensure_session`, `lookup_turn`, `start_turn`, `recover_turn`,
`cancel_turn`, and `shutdown`. Each request carries the exact Capsule ID, a random
local capability, and a request ID; responses repeat Capsule and request identity.
Capsule directories are mode 0700, and descriptor/state files plus the Unix socket
are mode 0600. The detached child receives a small environment allowlist that excludes
Node and Relay credentials, inherited `HOME`, provider-credential environment
variables, proxy settings, and process-loader injection variables. For a schema-v2
Capsule, the owner API key enters only through fixed fd 3, never argv or environment.
The raw provider later runs with its locally derived private runtime home as process
cwd, not with the logical workspace as process cwd. That workspace is a separately
validated field carried into the exact app-server arguments and thread requests.
Capability authentication happens before any runtime call.
Unexpected internal runtime errors are returned as the fixed public message `Capsule
runtime failed`; the server then removes its owned socket and closes that running
generation. `PersistentCapsuleServer.close()` starts runtime close while socket
handlers drain, and the `CapsuleRuntime.close()` contract must release and fence
admitted work before resolving. Detached background work can call the injected
`lifecycle.retire()` hook to trigger the same teardown.

The wire has separate bounded frames: 128 MiB for requests, which covers the maximum
protocol-valid input after worst-case JSON escaping, and 4 MiB for responses. The
Node journal checkpoints the full validated start input before host lookup/start; its
registry binds `(deliveryId, executionAttempt)` to one Mission, Capsule, and canonical
input hash. Capsule state retains the same parsed input, hash, host turn, stable event
stream, and completion deadline. `recoverTurn(ref, expectedInput)` must match that
durable intent and the Mission/session scope. The Capsule permits one active turn per
Mission.

This process path is experimental and Unix-only. A normal Node exit leaves detached
Capsules running. Before opening the journal or Capsule registry, the Node opens a
stable private mode-0600 `run.lock` and acquires a nonblocking kernel advisory lock
through exact-pinned `fs-native-extensions@1.5.0`. The file and its inode remain
stable; PID, timestamps, and owner metadata live in a separate mode-0600
`run.owner.json` and are diagnostic rather than ownership authority. Normal exit,
`SIGKILL`, and host reboot release the kernel lock, so the process test and
Relay/Postgres E2E restart directly without deleting `run.lock`. A second live,
stopped, or event-loop-stalled Node retains ownership, because there is no heartbeat
or timeout-based stealing. A missing or malformed `run.owner.json` cannot change the
kernel decision.

A new schema-2 lock is fully written and synced in a private same-directory temporary
file, published without overwrite, and followed by a directory sync. Every existing
schema-1 PID lock fails closed: `ESRCH` inside one PID namespace cannot prove an old
Node sharing the state is dead in every namespace. Migration therefore requires a
one-time offline operator check and removal of only the legacy file. Malformed state,
symlinks, wrong owner/mode/type, unsupported lock semantics, extra hard links, or path
replacement also fail closed before local state access. Once schema 2 is established,
its inode is never renamed or unlinked; release closes the held descriptor and leaves
the file in place. That permanent schema-2 file also prevents a pre-kernel-lock Node
binary from creating its schema-1 PID lock.
The validated host boundary is a local macOS or glibc-Linux filesystem; Alpine/musl
and network-filesystem lock semantics are not established by this checkpoint.

There is no installed OS service supervisor or automatic process respawn. Capsule
restart is automatic only after repeated failed authenticated probes and
ownership-safe removal of the same unchanged stale socket inode. The server binds
through a private alias so closing an old process cannot unlink a replacement socket.

### Private local runtime authority checkpoint

`createRuntimeAuthorityGrant` runs only after current Relay authorization, local
policy resolution, repository preflight, transition to `executing`, and adapter
probing. Its strict schema binds one grant to:

- grant, Agent, Node, workspace binding/alias/resource digest, and accepted local
  policy profile/digest;
- Mission, delivery, positive execution attempt, lease ID, and positive fencing
  token; and
- lease expiry, hard Mission expiry, exact capabilities, and the separately retained
  product, local, Mission, and runtime limit sources.

The effective numeric limits are the minimum across all four sources; allowed artifact
types are their intersection. Capabilities must use their canonical action/resource
pair. Product policy rejects repository push/merge, package publish, deployment,
arbitrary network access, secret access, and privilege expansion even if such a
capability appears in an input. The compiled fake-runtime grant includes lifecycle,
workspace-read, usage-report, artifact-publish, and outbound-publish capabilities. An
explicit accepted owner-local `workspace_access: "write"` profile also adds
workspace-write. Omitted or explicit `read` preserves the legacy read-only grant and
canonical policy hash. Verification execution remains absent.

Before runtime activation, Node journal schema 4 checkpoints the exact grant in the
delivery entry. Reopening must reproduce it from the same trusted local inputs; a
changed lease identity, fence, policy digest, workspace resource, or body fails
closed. When trusted Relay recovery advances the fence, the old grant moves atomically
to a predecessor slot. The Node proves that exact Capsule generation retired before a
CAS can promote a successor with the same hard deadline and non-fence scope. Schema 2
and 3 migrate without inventing a predecessor. Lease renewals retain the
original grant, lease ID, and fence while monotonically extending only the current
lease expiry; exact replay is idempotent and rollback is denied.

`NodeRuntimeAuthoritySession` and `CapsuleAuthority` each own a
`LocalReferenceMonitor`. Installation replays the exact grant until the Capsule has
confirmed the latest verified renewal, then creates and binds the local monitor. A
lease that advances while installation is in flight therefore cannot be lost, and an
expired earlier lease is never revived in place. The Capsule gates session
creation, start, recovery, cancellation, and every emitted output/usage/artifact event.
Measurements are cumulative stream state, not per-frame deltas. Its turn timer and
lease/hard-expiry timers revoke the monitor and retire the Capsule generation. The
Node independently revalidates final `outbound_publish`, asks the Capsule to assert the
same request, rechecks locally, and gives the Relay request a continuous abort signal.
The Node also races local authority loss through live host waits and runs one bounded
cancellation/revocation path. Lease renewal or revocation is forwarded to both
monitors; a renewal arriving at the final handoff is buffered and drained before the
session becomes ready. An aborted completion keeps its exact durable intent because
transport cancellation cannot prove whether the Relay committed it.

Authority decisions contain only bounded identifiers, hashes, workspace alias,
action/resource, decision, and denial code. They exclude local paths, prompts, command
arguments, environment values, output, provider IDs, and secrets. Both monitors write
through an injected `RuntimeAuthorityEvidenceSink`; the selected Node/Capsule path uses
a no-op sink today, so this checkpoint does not claim durable evidence. It also does
not provide the registered verification handler (#93), artifact flow (#94), complete
Codex activation (#98), durable evidence store (#99), or adversarial activated-runtime
proof (#104). Detailed evidence and nonclaims are in
[`research/008-local-runtime-authority.md`](research/008-local-runtime-authority.md).

### Guarded Codex Capsule, provider guardian, and teardown-reaper checkpoint

`CodexCapsuleRunner` implements the same runtime-neutral server contract with an
owned `CodexProviderGeneration` supplied by
`SupervisedCodexProviderGuardian.openGeneration()`. It implements probe, session
start/resume, turn start/recovery, one provider-notification consumer, cancellation,
and durable event streaming. Tests open it through the real private Unix wire using
fake app-server clients. The descriptor-driven `agentrelay-capsule` can construct this
controller, and `openCodexNodeRuntime` pairs its provisioner and persistent adapter
after the non-claiming doctor passes. No polling `agentrelay-node` command opens that
factory. `agentrelay-codex-guardian` remains only its internal child-process entry
point, including its private `--reaper` mode.

`CodexCapsuleStore` schema v2 records a stable AgentRelay turn reference and its first
`accepted` event during `prepareTurn`, before `turn/start` or a provider turn ID. The
exact validated `StartTurnInput`, derived prompt/schema, hashes, and deterministic
`clientUserMessageId` remain bound to `(deliveryId, executionAttempt)`. A duplicate
start coalesces on that logical turn; a changed duplicate conflicts. Schema-v1
development state has no migration and is rejected.

`CodexCapsuleRunner.open` obtains one generation from the guardian boundary. Therefore
an unresolved start is inspected only after the guardian has excluded or reconciled
its predecessor, armed the detached reaper, and started the new generation.
Reconciliation reads the bound thread and
accepts exactly one turn whose client ID and text match the persisted intent. A
bounded zero match is durably terminalized as `failed`, or `cancelled` when
cancellation was already requested; it never resends. Cancellation before provider
binding survives reconciliation and produces one interrupt after the provider turn
is found. If a later fresh generation inherits
`interrupt_maybe_sent`, it does not repeat the interrupt. It reads the exact intent
once: an exact terminal turn is normalized and persisted authoritatively, while an
absent or still-`inProgress` turn becomes a redacted transient failure because the
prior provider generation is already proven quiescent. Public events contain no
provider IDs. If the first interrupt RPC rejects, the driver calls
`lifecycle.retire()`; only the replacement generation performs this one-read
resolution.

The guarded app-server client derives `codex-home` locally beneath the Capsule,
requires the Capsule and home to be real canonical current-user-owned directories
with exact mode 0700, and supplies that path as both `HOME` and `CODEX_HOME` inside an
otherwise allowlisted child environment. It also uses that private home as the
provider process cwd while retaining the canonical Mission workspace as a distinct
logical thread cwd. The process boundary must preserve both values exactly. That
client boundary alone does not provide filesystem isolation; the separate containment
library below must wrap its process boundary on Linux.

After `initialize` and `initialized`, the client performs `account/login/start` with
the one-shot API key, then `account/read` with refresh-token loading disabled. It
requires API-key-shaped responses and `requiresOpenaiAuth: true` before any thread
operation. App-server starts with
`cli_auth_credentials_store="ephemeral"`; the live handshake test proves no
`auth.json` exists before or after client close.

The exact app-server arguments and each start/resume request pin
`projects.<logical-workspace>.trust_level="untrusted"` and
`features.shell_tool=false`. Before `thread/start` or `thread/resume`, the client calls
`config/read` with `includeLayers: false` for the logical workspace and requires that
effective trust, the disabled shell tool, and absent or empty `mcp_servers`. After a
successful start or resume it repeats the effective-config check against the private
home and rejects any persisted private `config.toml`. It also pages
`experimentalFeature/list` and requires exactly one disabled `shell_tool` entry.

`thread/start` and every `turn/start` carry `environments: []`, so no
environment-backed shell or native `apply_patch` tool definition is available. This
does not remove the separately eligible model-dependent native `apply_patch` surface,
whose file-change approval remains denied and fatal. `thread/resume` is allowed
only after a bounded, cursor-checked `thread/loaded/list` scan proves that exact thread
is not loaded in the current provider process. Every server-initiated request,
including command, file-change, permission, user-input, MCP elicitation, dynamic-tool,
and legacy approval requests, receives a denial or empty failure response and then
poisons the client. No dynamic patch request is accepted at this checkpoint.

The guardian uses the stable `provider.lock` inode as kernel authority and writes
bounded private lifecycle evidence to `provider-generation.json`. Its phases are
`spawn_maybe_started`, `running`, `stop_requested`, and `quiescent`; the record also
contains the Capsule and generation IDs, kernel boot-session ID, absolute deadline,
last owner heartbeat, authoritative teardown cause, and one of `stopped`, `crashed`, or
`unresponsive`. It contains no PID, path, prompt, provider turn ID, stderr, or secret.

The Capsule retains the lock while a detached guardian inherits a validated duplicate
and a private control channel. Before writing the start barrier or spawning the raw
provider, the guardian starts a second detached process outside its process group. This
teardown witness validates and retains the same lock descriptor; the raw provider never
receives it. Both guardian and witness arm the absolute deadline and observe Capsule
heartbeats before `ready`, while the guardian owns the provider process group.

Provider exit, request timeout, local authority abort, deadline, heartbeat loss, or
explicit shutdown latches one stop cause. The witness sends `SIGTERM` to the complete
guardian/provider group, waits the bounded grace, escalates to group `SIGKILL`, and
polls until the group is absent. Only then may it authoritatively write matching
`quiescent` state and close its inherited lock. The Capsule independently proves group
absence, waits for that durable matching state, and only then releases its own lock and
settles termination. A same-boot non-quiescent predecessor fails closed, while a
changed kernel boot-session ID safely reconciles state left by a host reboot.

This still has no polling CLI wiring, owner-facing credential source, guarded
workspace-write model activation, installed service supervisor, or real model-turn
evidence. The internal
provider generation has only the fixed egress boundary described below.
Capsule-plus-guardian death converges if the witness survives. Loss of the witness or
every local lifecycle owner,
service restart/upgrade/rollback, cgroup containment, and descendants that escape the
supervised process group remain #120.

### Guarded Linux containment checkpoint

`prepareMissionWorkspace` admits an owner-prepared standalone checkout. The canonical
root and its real checkout-local `.git` directory must be current-user-owned and not
group/world writable; repository URL, frozen `HEAD`, allowed base ref, and initial
clean state must match. Linked worktrees, Git alternates, nested mounts, special
files, extra hard links, symlinked Git metadata, and replaced root/Git object identity
fail closed. Recovery revalidates the same identity while allowing expected dirty
Mission edits.

`prepareCodexSandboxContainment` builds a Linux-only Codex `0.146.0` boundary with an
explicit read or write workspace mode. The Codex provisioner selects the exact mode
from the accepted owner-local policy and requires matching workspace authority;
`.git` remains read-only, the pinned minimal system view plus explicit approved
trees are readable, and the owner home, containment control directory, and configured
forbidden roots are denied.
`HOME`, `CODEX_HOME`, and all
temporary variables point to private exact-mode directories; the child environment
is rebuilt and legacy Landlock is explicitly disabled. The outer launcher changes to
the private runtime home before starting the provider rather than changing to the
logical workspace. The exact app-server argv pins the logical workspace as an
untrusted project and pins
`model_provider="openai"`, `openai_base_url="https://api.openai.com/v1"`,
`agents.enabled=false`, and `web_search="disabled"`. It also disables `shell_tool`,
hooks, plugins, apps, multi-agent, and code-mode features, removing `exec_command`,
`write_stdin`, and the legacy shell while leaving native `apply_patch` independently
eligible when the selected model exposes it. Any resulting
`item/fileChange/requestApproval` is still declined and made fatal, so this is
command-surface reduction rather than exact patch mediation. The command selects the
outer `agentrelay-runtime` profile whose full Codex-managed CONNECT proxy permits only
host `api.openai.com`. Exact version checks and the mandatory containment probe select
`agentrelay-offline`, and each nested read-only workspace sandbox uses
`networkAccess: false`. The
launcher rejects `/etc/codex/config.toml`, `managed_config.toml`, and
`requirements.toml` rather than merging ambient system policy.

Before the boundary is returned, executable and bundled Bubblewrap hashes and object
identities are checked, approved read trees are recursively inspected for nested
mounts, hard links, special or group/world-writable entries, ownership, and symlink
aliases into denied roots. Read, write, and deny roots are compared by Linux storage
provenance, and writable roots reject nested mounts. An actual child canary must prove
the selected workspace access, read-only Git metadata, private temp, denied
control/home/shared-temp access, environment filtering, a separate network namespace,
and failed network access through a private token-bound result file.

The exclusive private `containment.json` manifest records `retain_for_review` and
binds the workspace, read/deny roots, executable/helper identities and hashes, config
path and hash, private paths, base commit, fixed provider-egress policy, and supplied
local-policy-grant digest. The returned recovery handle is exactly
`{ manifestPath, instanceId, bindingSha256 }`.
`recoverCodexSandboxContainment` reopens only that manifest and binding, reruns
identity and canary checks, and never resets or deletes the dirty checkout. Legacy
egress-less or altered provider policies are rejected during parse and recovery even
when their binding digest was recomputed. The Codex
provisioner durably stores this exact handle in the v2 descriptor before Capsule launch
and strictly revalidates it during dirty recovery. Once any retained delivery for the
same Mission contains a start intent or host-attempt history, later provisioning is
recovery-only and cannot create a fresh containment instance over the dirty checkout.
Write-mode Capsule activation validates that recovered mode, then fails closed before
claiming the credential or opening the guardian, provider, or runner. The local
controller identifies this as `workspace_write_activation_not_enabled`; the private
wire redacts it to `internal` and retires the Capsule. No polling CLI selects that path.
macOS and other platforms fail closed, no real model turn uses this boundary, and the
Linux process coverage verifies command/profile selection, proxy-environment injection,
and failed direct sockets without making a live OpenAI request; it is library-level
boundary evidence rather than activation evidence.

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
delivery mutation, `mission.terminal`, and relay lease-expiry/cancellation transitions.
Each terminal reconciliation writes a system Mission audit plus Relay `cancel`
receipts and audits tied to the terminal event for every remaining runnable delivery.
The matching `delivery_operation_receipts` retain exact Node-operation results and
relay-owned transport history. Audit actors are explicit: authenticated Agent
mutations retain an Agent ID, while admin and relay-system mutations use a typed actor
with no fabricated Agent identity. Agent registration, card updates, and agent-key
rotation still write no audit row. Audit also does not record commands, tool
arguments/results, file edits,
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

The self-host Docker profile forwards every required Relay secret from `.env`,
including `RELAY_INVITE_SECRET`. Its runtime config validation still rejects empty or
development-only values before the server starts.

## Validation commands

From the repository root:

```bash
pnpm lint
pnpm -r typecheck
pnpm -r build
pnpm --filter @agentrelay/protocol --filter relay --filter agentrelay-mcp \
  --filter agentrelay-node test
```

The Linux-only containment process gate is separate because macOS must not pretend to
prove Bubblewrap behavior:

```bash
pnpm install --frozen-lockfile --package-import-method=copy
pnpm --filter @agentrelay/protocol build
AGENTRELAY_RUN_CONTAINMENT_TESTS=1 \
  pnpm --filter agentrelay-node exec vitest run \
  src/codex-provider-guardian.process.test.ts \
  src/runtime-containment.process.test.ts
```

The copy import is intentional: approved runtime trees must not remain hard-linked
to pnpm's shared content-addressed store. The host must also permit unprivileged user
and network namespaces; containment setup otherwise fails closed. CI enables that
prerequisite only on its disposable Linux proof host.

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
deliveries have a separate model and public control plane. The local Node now proves
both the journaled in-process fake-turn boundary and detached fake-Capsule recovery
after Node-process death. The provider-neutral server, injected Codex runner, and
provider guardian/reaper, strict descriptor, provisioner, and persistent adapter add a
guarded read-only activation path plus a fail-closed write-authority/containment
checkpoint with exact retained recovery identity and a passing Linux process proof.
Internal Codex composition uses the bound reference monitor, but no polling CLI selects
it. The next gates are an owner-facing credential source and polling composition that
selects the fixed provider-only egress boundary, guarded workspace-write model
activation, registered verification and artifact carriage, durable
structured execution evidence, adversarial evaluation, Guarded Real Mission 0, and
finally the two-machine proof. Installed
service/cgroup containment,
witness/all-owner loss, escaped descendants, and restart/upgrade/rollback remain #120. The
mailbox API remains a compatibility and inspection surface.
