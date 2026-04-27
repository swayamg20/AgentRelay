# Low-Level Design (v0.1, v0.1.5)

> Concrete contracts. If `architecture.md` is the map and `hld.md` is the
> blueprint, this is the construction spec — every schema, every endpoint,
> every error code. v0.1.5 additions are flagged inline (`intent`,
> `proposed_action`, `draft_proposed_action`).

---

## 1. Repository layout

```
A2A/
├── docs/
│   ├── architecture.md
│   ├── hld.md
│   ├── lld.md            ← you are here
│   ├── roadmap.md
│   ├── auto-mode.md
│   └── ambient-agent.md
├── relay/                ← Node TypeScript Hono service
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── drizzle.config.ts
│   ├── drizzle/
│   │   └── migrations/             ← drizzle-kit generated SQL
│   ├── src/
│   │   ├── main.ts                 ← entry: dotenv + node-server bootstrap
│   │   ├── server.ts               ← Hono app factory
│   │   ├── config.ts               ← zod-validated env loader
│   │   ├── logger.ts               ← pino with PII redaction
│   │   ├── errors.ts               ← RelayError + §3.5 code map
│   │   ├── middleware.ts           ← request-id, access logging, auth resolver
│   │   ├── db/
│   │   │   ├── schema.ts           ← Drizzle table definitions
│   │   │   └── client.ts           ← postgres-js pool + Drizzle binding
│   │   ├── auth.ts                 ← API key hashing + bearer resolution
│   │   ├── a2a/
│   │   │   ├── router.ts           ← /a2a JSON-RPC dispatcher
│   │   │   └── mappings.ts         ← our concepts ↔ A2A primitives
│   │   ├── routes/
│   │   │   ├── admin.ts            ← register, list agents
│   │   │   ├── agents.ts           ← Agent Card endpoints
│   │   │   └── system.ts           ← /healthz, /readyz, /metrics
│   │   ├── services/
│   │   │   ├── handoff.ts          ← Handoff state machine
│   │   │   ├── messaging.ts        ← Message append
│   │   │   └── audit.ts            ← AuditLog writes
│   │   └── notifications/
│   │       ├── dispatcher.ts       ← in-process bounded queue + retry
│   │       └── slack.ts            ← Slack webhook adapter
│   └── *.test.ts                   ← vitest tests alongside source
├── mcp-server/           ← Node TypeScript MCP server
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts                ← MCP entry
│   │   ├── config.ts               ← config file loader
│   │   ├── a2a-client.ts           ← thin wrapper on a2a-js
│   │   ├── tools/
│   │   │   ├── handoff.ts          ← handoff_to_teammate
│   │   │   ├── inbox.ts            ← check_inbox
│   │   │   ├── accept.ts           ← accept_handoff
│   │   │   ├── message.ts          ← send_message
│   │   │   ├── complete.ts         ← complete_handoff
│   │   │   └── list-teammates.ts   ← list_teammates
│   │   └── cli/
│   │       ├── register.ts         ← `agentrelay register`
│   │       ├── install.ts          ← `agentrelay install` (writes settings)
│   │       └── rotate-key.ts       ← `agentrelay rotate-key`
│   └── tests/
└── examples/
    ├── README.md
    ├── claude-code-settings.json   ← sample MCP config
    └── codex-config.toml           ← sample Codex config
```

---

## 2. Database schema (Postgres)

All tables include `created_at TIMESTAMPTZ DEFAULT now() NOT NULL` and
`updated_at TIMESTAMPTZ DEFAULT now() NOT NULL` (auto-updated via trigger)
unless noted. UUIDs are v4 unless noted. All FKs are `ON DELETE RESTRICT`
to preserve audit history.

### 2.1 `agents`

The canonical identity table.

```sql
CREATE TABLE agents (
    id            UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    handle        TEXT            NOT NULL UNIQUE,    -- e.g. "frank@acme"
    email         CITEXT          NOT NULL UNIQUE,
    display_name  TEXT            NOT NULL,
    role          TEXT            NOT NULL,           -- "frontend", "backend", "mobile", ...
    status        TEXT            NOT NULL DEFAULT 'active',  -- active|disabled
    created_at    TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ     NOT NULL DEFAULT now()
);
CREATE INDEX idx_agents_handle ON agents(handle);
CREATE INDEX idx_agents_status ON agents(status);
```

### 2.2 `agent_cards`

The public-facing Agent Card. 1:1 with `agents`. JSON column for the
A2A-spec card body so we can evolve the schema without ALTER TABLEs.

```sql
CREATE TABLE agent_cards (
    agent_id      UUID            PRIMARY KEY REFERENCES agents(id),
    card          JSONB           NOT NULL,           -- A2A AgentCard
    repos_owned   TEXT[]          NOT NULL DEFAULT '{}',
    skills        TEXT[]          NOT NULL DEFAULT '{}',
    notification_webhook_url TEXT,                   -- Slack incoming webhook (encrypted at rest)
    created_at    TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ     NOT NULL DEFAULT now()
);
CREATE INDEX idx_agent_cards_repos ON agent_cards USING GIN (repos_owned);
CREATE INDEX idx_agent_cards_skills ON agent_cards USING GIN (skills);
```

`notification_webhook_url` is encrypted at rest using `pgcrypto` symmetric
encryption with a key from `RELAY_ENCRYPTION_KEY`. Decrypted only at
dispatch time, never logged.

### 2.3 `api_keys`

Hashed API keys. Multiple per agent for rotation.

```sql
CREATE TABLE api_keys (
    id            UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id      UUID            NOT NULL REFERENCES agents(id),
    key_hash      BYTEA           NOT NULL,           -- sha256(salt || key)
    salt          BYTEA           NOT NULL,           -- per-row, 16 bytes
    label         TEXT,                               -- "laptop-may2026" etc.
    last_used_at  TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ     NOT NULL DEFAULT now()
);
CREATE INDEX idx_api_keys_agent ON api_keys(agent_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX idx_api_keys_active_hash ON api_keys(key_hash) WHERE revoked_at IS NULL;
```

Lookup is O(1): hash the incoming bearer, query by `key_hash`. The unique
index on active hashes prevents duplicate keys.

### 2.4 `handoffs`

The thread top-level row.

```sql
CREATE TYPE handoff_status AS ENUM ('pending','accepted','completed','cancelled');

-- intent ships as TEXT not ENUM so we can add new values without migrations.
-- Allowed values: 'inform' | 'ask_question' | 'propose_action'.
-- v0.1: 'inform', 'ask_question'.  v0.1.5 adds: 'propose_action'.

CREATE TABLE handoffs (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id       UUID            NOT NULL REFERENCES agents(id),
    recipient_id    UUID            NOT NULL REFERENCES agents(id),
    summary         TEXT            NOT NULL,
    intent          TEXT            NOT NULL DEFAULT 'inform',
    status          handoff_status  NOT NULL DEFAULT 'pending',
    artifacts       JSONB           NOT NULL DEFAULT '[]',  -- array of artifact descriptors
    proposed_action JSONB,                                   -- v0.1.5; non-null only when intent='propose_action'
    metadata        JSONB           NOT NULL DEFAULT '{}',
    accepted_by_session  TEXT,                              -- caller session ID, for audit
    accepted_at     TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    completed_summary TEXT,
    cancelled_at    TIMESTAMPTZ,
    idempotency_key TEXT            UNIQUE,                 -- per-create idempotency
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),

    CHECK (sender_id != recipient_id),
    CHECK (intent IN ('inform','ask_question','propose_action')),
    CHECK ((intent = 'propose_action') = (proposed_action IS NOT NULL))
);
CREATE INDEX idx_handoffs_recipient_status ON handoffs(recipient_id, status, created_at DESC);
CREATE INDEX idx_handoffs_sender ON handoffs(sender_id, created_at DESC);
```

`proposed_action` JSON shape (v0.1.5):

```json
{
  "description": "Update API client to match new paginated response",
  "target_files": ["src/api/users.client.ts"],
  "rationale": "Backend now returns { items, next_cursor } instead of array",
  "suggested_diff": "@@ ... @@\n- ...\n+ ..."   // optional; receiver can draft fresh
}
```

The `idx_handoffs_recipient_status` index is the hot path: it serves
`check_inbox` queries which always filter by recipient + status.

`artifacts` JSON shape:

```json
[
  {"type": "file_diff", "path": "src/api/users.py", "diff": "..."},
  {"type": "file_ref", "path": "openapi.yaml", "git_sha": "abc123"},
  {"type": "test_command", "command": "pytest tests/users/"},
  {"type": "api_contract", "schema_url": "https://..."}
]
```

### 2.5 `messages`

Append-only thread messages.

```sql
CREATE TABLE messages (
    id            UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    handoff_id    UUID            NOT NULL REFERENCES handoffs(id),
    author_id     UUID            NOT NULL REFERENCES agents(id),
    body          TEXT            NOT NULL,
    payload       JSONB           NOT NULL DEFAULT '{}',  -- structured attachments
    sequence_no   INT             NOT NULL,                -- monotonic per handoff
    idempotency_key TEXT          UNIQUE,
    created_at    TIMESTAMPTZ     NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_messages_seq ON messages(handoff_id, sequence_no);
CREATE INDEX idx_messages_handoff ON messages(handoff_id, created_at);
```

`sequence_no` is computed at insert time using a SELECT-MAX-then-INSERT
pattern wrapped in a transaction, or — better — a Postgres advisory lock
keyed on `handoff_id`. Either ensures monotonicity even under concurrent
appends.

The initial summary message of a handoff is also stored as `messages`
row with `sequence_no = 1`. The `handoffs.summary` field duplicates it
for fast list rendering — denormalized intentionally.

### 2.6 `audit_log`

Append-only mutation history.

```sql
CREATE TABLE audit_log (
    id            BIGSERIAL       PRIMARY KEY,
    actor_id      UUID            NOT NULL REFERENCES agents(id),
    action        TEXT            NOT NULL,           -- "handoff.create", "handoff.accept", etc.
    resource_type TEXT            NOT NULL,           -- "handoff", "message", "agent_card", ...
    resource_id   UUID            NOT NULL,
    metadata      JSONB           NOT NULL DEFAULT '{}',
    request_id    TEXT,                               -- propagated from API request
    created_at    TIMESTAMPTZ     NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_resource ON audit_log(resource_type, resource_id, created_at DESC);
CREATE INDEX idx_audit_actor ON audit_log(actor_id, created_at DESC);
```

Retention controlled by `RELAY_AUDIT_RETENTION_DAYS` (default 90).
A daily job (Postgres `pg_cron` extension) deletes rows older than that.

### 2.7 `agent_blocks`

Server-side mirror of the per-developer block list. Populated when a
developer runs `agentrelay block <handle>` (lld §5.6). The CLI sources
from `~/.agentrelay/trust.yaml`'s `blocked: []` array and syncs to the
relay; the relay enforces the block on `message/send` so a blocked
sender cannot reach the blocker even if the blocker's MCP server isn't
running. The check happens BEFORE any state mutation.

```sql
CREATE TABLE agent_blocks (
    blocker_id    UUID            NOT NULL REFERENCES agents(id),
    blocked_id    UUID            NOT NULL REFERENCES agents(id),
    reason        TEXT,                               -- optional human-set context
    created_at    TIMESTAMPTZ     NOT NULL DEFAULT now(),

    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id != blocked_id)
);
CREATE INDEX idx_agent_blocks_blocked ON agent_blocks(blocked_id);
```

The `(blocker_id, blocked_id)` PK serves the hot-path check at
`message/send` time: "did the recipient block the caller?" — O(1) PK
lookup. The `idx_agent_blocks_blocked` index supports the inverse
audit query ("who has blocked me?") for a future tool.

The `agentrelay block` / `unblock` CLI commands sync via three
auth-required REST endpoints (additive to §3.3, caller's own API key —
not the admin token):

- `POST /agents/me/block`              — body `{ handle: "bob@acme", reason?: "..." }`
- `DELETE /agents/me/block/:handle`
- `GET /agents/me/block`               — returns the caller's block list

Naming convention: rows are stored with the *acting* developer as
`blocker_id` regardless of which side initiates the request — i.e. when
Frank calls `POST /agents/me/block { handle: "bob@acme" }`, the row
inserted is `(blocker_id=frank.id, blocked_id=bob.id)`.

---

## 3. Relay HTTP API

Two surfaces:
- **A2A JSON-RPC** at `POST /a2a` — agent-to-relay calls
- **Plain REST** for system endpoints — registration, admin, health

All endpoints authenticate via `Authorization: Bearer <api_key>` except
where noted. All responses are JSON. All errors follow §3.5 below.

### 3.1 A2A JSON-RPC: `POST /a2a`

Single endpoint that multiplexes by JSON-RPC `method`. Conforms to A2A spec.

#### `message/send` — create or append to a handoff

Sender posts a message. If `task_id` is omitted, creates a new handoff
(thread). If `task_id` is present, appends to that thread.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "message/send",
  "params": {
    "task_id": null,
    "recipient": "frank@acme",
    "intent": "inform",
    "message": {
      "role": "user",
      "parts": [
        {"type": "text", "text": "Refactored /users API. New shape: ..."}
      ]
    },
    "artifacts": [
      {"type": "file_diff", "path": "src/api/users.py", "diff": "..."}
    ],
    "proposed_action": null,
    "metadata": {
      "client_idempotency_key": "uuid-from-mcp"
    }
  }
}
```

The `intent` and `proposed_action` params are A2A spec extensions.
`intent` is one of `inform` | `ask_question` | `propose_action`. The
relay validates the v0.1.5 invariant: `proposed_action` is non-null
exactly when `intent == 'propose_action'`. Validation error code
`-32012` `invalid_intent_payload`.

**Response (new handoff created):**
```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "result": {
    "task_id": "01HXYZ...",
    "status": {"state": "pending"},
    "created_at": "2026-04-25T10:00:00Z"
  }
}
```

**Authorization:** caller's API key must resolve to either `sender` (when
creating) or any participant of `task_id` (when appending).

**Errors:**
- `-32602` invalid params (missing `recipient` on create)
- `-32004` `recipient_not_found`
- `-32005` `not_a_participant` (when appending to a thread you don't own)
- `-32007` `thread_terminal` (appending to completed/cancelled)

#### `tasks/get` — read a thread

```json
{ "method": "tasks/get", "params": { "task_id": "..." } }
```

Returns the full handoff including all messages and artifacts. Caller
must be sender or recipient.

#### `tasks/list` — inbox / sent items

```json
{
  "method": "tasks/list",
  "params": {
    "filter": {
      "role": "recipient",       // "recipient" or "sender"
      "status": ["pending"],     // optional, multi-valued
      "since": "2026-04-20T00:00:00Z"  // optional
    },
    "page": { "limit": 50, "cursor": null }
  }
}
```

Returns the caller's tasks where they are sender or recipient (per `role`).

#### `tasks/update` — state transitions

Used for `accept`, `complete`, and `cancel`. The relay enforces the state
machine.

```json
{
  "method": "tasks/update",
  "params": {
    "task_id": "...",
    "transition": "accept",         // accept | complete | cancel
    "session_id": "claude-1234",    // for accept; recorded for audit
    "result_summary": "..."         // for complete
  }
}
```

**Errors:**
- `-32008` `invalid_transition` (e.g., calling `accept` on a completed thread)
- `-32009` `not_authorized` (e.g., sender trying to accept their own thread)
- `-32010` `state_changed` (someone else got there first)

### 3.2 Agent Card endpoints (REST, partly public)

#### `GET /.well-known/agent-card.json?id=<handle>` (public)

Returns the public Agent Card for the given handle. No auth required —
this is the standard A2A discovery endpoint.

```json
{
  "id": "frank@acme",
  "name": "Frank — Frontend",
  "description": "Frontend agent for Acme apps",
  "endpoint": "https://relay.acme.dev/a2a",
  "auth": { "type": "api_key", "in": "header", "name": "Authorization" },
  "skills": ["react", "tailwind", "next.js"],
  "metadata": {
    "role": "frontend",
    "repos_owned": ["apps/web/", "packages/ui/"]
  }
}
```

The `email` and `notification_webhook_url` fields are **never** returned
by this endpoint. Internal-only fields stay internal.

#### `PUT /agents/me/card` (auth required)

Updates the caller's own card.

```json
{ "skills": [...], "repos_owned": [...], "role": "..." }
```

#### `GET /agents` (auth required)

Lists all agents in the team. Returns public Agent Card fields + handle.
No secrets. Used by `list_teammates`.

### 3.3 Admin endpoints (REST, admin auth)

Admin auth uses a separate `RELAY_ADMIN_TOKEN` env var. Only used during
team setup — not exposed to agents.

#### `POST /admin/agents`

Register a new agent. Returns the one-time API key.

```json
// Request
{ "handle": "frank@acme", "email": "frank@acme.com", "display_name": "Frank", "role": "frontend" }

// Response
{ "agent_id": "01HXYZ...", "handle": "frank@acme", "api_key": "ah_live_..." }
```

The `api_key` field is returned **only on creation** and never again.
Lost keys must be rotated.

#### `POST /admin/agents/<id>/keys/rotate`

Rotate the API key for an agent. Old keys are revoked atomically; the new
key is returned once.

#### `DELETE /admin/agents/<id>`

Soft-delete (sets status='disabled'). Existing handoffs are preserved.

### 3.4 System endpoints

#### `GET /healthz`

Public. Returns 200 if the process is alive.

#### `GET /readyz`

Public. Returns 200 if the DB connection pool is initialized and at
least one query succeeds. 503 otherwise.

#### `GET /metrics`

Prometheus exposition format. Behind `RELAY_METRICS_TOKEN`.

### 3.5 Error model

All errors are JSON-RPC 2.0 errors for `/a2a`, REST errors for the others.
Both share an envelope:

```json
{
  "code": "recipient_not_found",
  "message": "No agent with handle 'ghost@acme'",
  "request_id": "req_01HXY...",
  "details": {}
}
```

Mapping table:

| Code (RPC) | Code (HTTP) | Symbol                    | Meaning                                             |
| ---------- | ----------- | ------------------------- | --------------------------------------------------- |
| -32700     | 400         | parse_error               | Malformed JSON                                      |
| -32600     | 400         | invalid_request           | Not a valid JSON-RPC envelope                       |
| -32601     | 404         | method_not_found          | Unknown method                                      |
| -32602     | 400         | invalid_params            | Missing or wrong-typed params                       |
| -32001     | 401         | unauthenticated           | No or invalid bearer                                |
| -32002     | 403         | forbidden                 | Authenticated but not authorized for this resource  |
| -32003     | 429         | rate_limited              | Caller exceeded rate limit                          |
| -32004     | 404         | recipient_not_found       | Recipient handle does not exist                     |
| -32005     | 403         | not_a_participant         | Caller is not sender or recipient of the thread     |
| -32006     | 404         | thread_not_found          | Thread ID unknown                                   |
| -32007     | 409         | thread_terminal           | Thread is completed or cancelled                    |
| -32008     | 409         | invalid_transition        | State transition not allowed from current state     |
| -32009     | 403         | not_authorized_transition | Caller cannot perform this transition               |
| -32010     | 409         | state_changed             | Optimistic concurrency conflict                     |
| -32011     | 409         | duplicate_idempotency_key | Same idempotency key with different payload        |
| -32012     | 400         | invalid_intent_payload    | `proposed_action` mismatched with `intent` value (v0.1.5)         |
| -32013     | 403         | teammate_blocked          | Sender is blocked by recipient via `agentrelay block`              |
| -32099     | 500         | internal                  | Catchall; details redacted                          |

### 3.6 Rate limits (v0.1)

Per agent:
- 60 requests/minute on `/a2a` (token bucket)
- 5 requests/minute on `/admin/*` per admin token

Exceeding returns `-32003` with a `Retry-After` header.

---

## 4. MCP server tools

Each tool's input schema is enforced via zod. Output is the JSON returned
to the agent. Errors propagate as MCP tool errors.

### 4.1 `handoff_to_teammate`

```typescript
input: {
  to: string,                                   // handle, e.g. "frank@acme"
  intent: "inform" | "ask_question"             // v0.1
        | "propose_action",                     // v0.1.5
  summary: string,                              // 1-2 paragraph summary, required
  artifacts?: Artifact[],                       // optional structured payload
  question?: string,                            // optional initial question (intent='ask_question')
  proposed_action?: ProposedAction,             // required iff intent='propose_action' (v0.1.5)
  metadata?: Record<string, any>                // freeform
}

type Artifact =
  | { type: "file_diff",  path: string, diff: string }
  | { type: "file_ref",   path: string, git_sha?: string, lines?: [number,number] }
  | { type: "test_command", command: string, cwd?: string }
  | { type: "api_contract", schema_url?: string, inline?: any }
  | { type: "link", url: string, title?: string }

type ProposedAction = {              // v0.1.5
  description: string,               // human-readable summary
  target_files: string[],            // paths the receiver's agent will touch
  rationale: string,                 // why this change is needed
  suggested_diff?: string            // optional; receiver may draft fresh
}

output: {
  thread_id: string,
  status: "pending",
  recipient: string,
  created_at: string,    // ISO 8601
  inbox_url: string      // deep link
}
```

Behaviour:
1. Validate input. If `intent === 'propose_action'`, verify
   `proposed_action` is present and shape-valid.
2. Generate a client idempotency key (UUIDv4).
3. POST `message/send` to the relay with `intent` and `proposed_action`.
4. On 2xx, return the result to the agent. On 4xx, raise an MCP tool error
   with the relay's error message.

### 4.2 `check_inbox`

```typescript
input: {
  status?: ("pending"|"accepted"|"completed"|"cancelled")[],  // default: ["pending","accepted"]
  since?: string,    // ISO 8601
  limit?: number     // default 50, max 200
}

output: {
  items: InboxItem[],
  next_cursor: string | null
}

type InboxItem = {
  thread_id: string,
  sender: { handle: string, name: string, role: string },
  summary_preview: string,    // first 240 chars of summary
  status: HandoffStatus,
  unread_messages: number,    // since last accept/check
  created_at: string,
  updated_at: string
}
```

### 4.3 `accept_handoff`

```typescript
input: {
  thread_id: string,
  session_id?: string   // defaults to MCP-generated ID
}

output: {
  thread_id: string,
  status: "accepted",
  intent: "inform" | "ask_question" | "propose_action",
  sender: { handle, name, role, email? },
  summary: string,                              // already wrapped with L1 provenance
  artifacts: Artifact[],
  proposed_action?: ProposedAction,             // present iff intent='propose_action' (v0.1.5)
  messages: Message[],                          // full thread, each message body L1-wrapped
  accepted_at: string,
  trust_overlay: {                              // L3 derived from ~/.agentrelay/trust.yaml
    auto_read: boolean,
    auto_test: boolean,
    auto_write_paths: string[],
    require_approval: string[]
  }
}
```

Behaviour:
1. Calls `tasks/get` then `tasks/update` with `transition=accept` (server
   collapses into one transaction).
2. Wraps every text field (summary, message bodies, proposed_action.rationale)
   with the Layer 1 provenance preamble before returning to the agent. The
   agent sees teammate content tagged as untrusted data, never raw.
3. Reads `~/.agentrelay/trust.yaml`, computes the trust_overlay for this
   sender, and returns it. The MCP server is also responsible for surfacing
   this to the agent so it knows what's pre-authorized.
4. If sender is in the receiver's block list, returns
   `-32013 teammate_blocked` and does not transition state.

### 4.4 `send_message`

```typescript
input: {
  thread_id: string,
  body: string,
  payload?: Record<string, any>
}

output: {
  thread_id: string,
  message_id: string,
  sequence_no: number,
  created_at: string
}
```

### 4.5 `complete_handoff`

```typescript
input: {
  thread_id: string,
  result_summary: string,
  artifacts?: Artifact[]
}

output: {
  thread_id: string,
  status: "completed",
  completed_at: string
}
```

### 4.6 `list_teammates`

```typescript
input: {
  role?: string,
  skill?: string,
  repo?: string
}

output: {
  teammates: Teammate[]
}

type Teammate = {
  handle: string,
  name: string,
  role: string,
  skills: string[],
  repos_owned: string[]
}
```

No secrets, no inbox counts (closed in HLD §11).

### 4.7 `draft_proposed_action` (v0.1.5)

Receiver-side tool. After accepting a handoff with
`intent='propose_action'`, the agent uses this to record its drafted
diff back to the thread *without applying it*. The actual file write
happens through Claude Code/Codex's normal `Edit`/`Write` tools, which
go through Layer 2 permissions (default `ask`).

```typescript
input: {
  thread_id: string,
  drafted_diff: string,         // unified diff
  drafted_files: string[],      // paths the agent proposes to modify
  rationale: string,            // why this draft satisfies Bob's request
  alternatives_considered?: string  // optional, for transparency
}

output: {
  thread_id: string,
  message_id: string,           // the draft is appended as a thread message
  sequence_no: number,
  created_at: string
}
```

Behaviour:
1. Append a special message of type `proposed_action_draft` to the
   thread. The drafted_diff is stored as an artifact on this message.
2. The relay does not auto-apply anything. The message is informational —
   Bob's agent sees "Frank's agent has drafted a response" on next poll.
3. To actually apply the draft, Frank's agent calls Claude Code's
   `Edit`/`Write` tools normally. Those go through Layer 2 (ask by
   default) and Layer 3 (per-teammate trust overlay may auto-allow if
   target_files match the trust.yaml `auto_write_paths`).

This separates "drafting an answer" from "applying it" — critical for
the trust model. A drafted action is a normal thread message; applying
it is a normal local tool call subject to Frank's permission system.

---

## 5. CLI (`agentrelay`)

The MCP server package also installs a CLI binary used for one-time setup
operations. Implemented in the same TypeScript package.

### 5.1 `agentrelay register`

```
agentrelay register \
  --relay <url> \
  --admin-token <token> \      # only required for first user; later the admin can pre-create the agent
  --handle <handle> \
  --email <email> \
  --name <display name> \
  --role <role>
```

Calls `POST /admin/agents`, stores the returned API key in
`~/.agentrelay/config.json` with file mode 0600.

### 5.2 `agentrelay install`

```
agentrelay install --client claude-code   # or codex, or 'all'
```

Does two things:

**(a) Adds the MCP server entry.** Detects the client's config file
location, adds the entry, prompts before overwriting any existing entry.

For Claude Code (`~/.claude/settings.json`):
```json
{
  "mcpServers": {
    "agentrelay": {
      "command": "npx",
      "args": ["-y", "agentrelay-mcp"],
      "env": {}
    }
  }
}
```

For Codex CLI (`~/.codex/config.toml`):
```toml
[mcp_servers.agentrelay]
command = "npx"
args = ["-y", "agentrelay-mcp"]
```

**(b) Writes the recommended permission overlay (Layer 2 of the trust
model).** Merges the AgentRelay-recommended `permissions` block into
the same settings file. Detects existing rules; if the user has
customized them, shows a unified diff and asks before applying:

```json
{
  "permissions": {
    "allow": [
      "Read", "Grep", "Glob",
      "Bash(npm test*)", "Bash(pytest*)", "Bash(cargo test*)",
      "Bash(npm run lint*)", "Bash(tsc*)",
      "mcp__agentrelay__*"
    ],
    "ask": [
      "Edit", "Write",
      "Bash(git commit*)", "Bash(git diff*)"
    ],
    "deny": [
      "Bash(git push*)", "Bash(npm publish*)", "Bash(rm -rf*)",
      "Bash(curl*)", "Bash(wget*)",
      "Bash(eval*)", "Bash(*ssh*)",
      "Bash(*aws*)", "Bash(*kubectl*)"
    ]
  }
}
```

For Codex CLI's `~/.codex/config.toml`, the equivalent permission
syntax is written under `[permissions]`.

If the user wants to customize, they can edit the resulting file
freely. AgentRelay only re-applies the recommended overlay on
subsequent `install` runs after explicit confirmation.

The MCP server reads the relay URL and API key from
`~/.agentrelay/config.json`, not from env vars passed via the client
config — keeps secrets out of CLI config files.

**(c) Creates a default `~/.agentrelay/trust.yaml`** if absent. See §6.2
for schema. Defaults to `unknown_teammates: { policy: reject }`,
i.e. explicit-only trust.

### 5.3 `agentrelay rotate-key`

```
agentrelay rotate-key
```

Calls `POST /admin/agents/<self>/keys/rotate` (using the *current* key as
auth, not the admin token; an agent can rotate its own key). Updates
local config atomically.

### 5.4 `agentrelay doctor`

```
agentrelay doctor
```

Verifies: config file exists and is readable, relay is reachable, API key
is valid (`whoami` call), MCP entry is present in client configs,
permission overlay is applied (Layer 2), `trust.yaml` is present
and parseable (Layer 3).

### 5.5 `agentrelay audit`

```
agentrelay audit \
  [--since <ISO ts>] \
  [--from <handle>] \
  [--action <symbol>] \
  [--limit 100]
```

Reads the local audit ledger (every action Frank's agent took in
response to a remote handoff) and the relay-side audit log for events
where Frank is a participant. Outputs a TSV/JSON-lines stream:

```
timestamp                handoff_id    from         action        details
2026-04-26T10:01:23Z     01HXY...      bob@acme     edit_drafted  src/api/users.client.ts (12 ins / 4 del)
2026-04-26T10:01:25Z     01HXY...      bob@acme     edit_applied  src/api/users.client.ts (approved by frank)
2026-04-26T10:02:11Z     01HXY...      bob@acme     test_run      pytest tests/users/  → pass
```

Layer 4 of the trust model. Used for forensics, incident response,
or just curiosity ("what did Bob's agent get me to do this week?").

### 5.6 `agentrelay block`

```
agentrelay block <handle>
agentrelay unblock <handle>
agentrelay block --list
```

Atomic revocation. Adds `<handle>` to the local block list and
syncs to the relay. After `block`, that sender's `message/send`
calls targeting Frank return `-32013 teammate_blocked` and Frank's
inbox stops receiving from them.

The block list lives in `~/.agentrelay/trust.yaml` under a
top-level `blocked: [...]` array, so it survives across MCP
server restarts.

### 5.7 `agentrelay trust`

```
agentrelay trust list
agentrelay trust set <handle> --auto-write-paths "docs/,README.md"
agentrelay trust reset <handle>
```

Manage `~/.agentrelay/trust.yaml` from the CLI. Layer 3 of the trust
model. The schema is human-editable so users can also edit the file
directly; this is the typed accessor for scripting and discoverability.

---

## 6. Local config

Two files in `~/.agentrelay/`, both mode 0600.

### 6.1 `config.json` — credentials and connection

```json
{
  "relay_url": "https://relay.acme.dev",
  "agent_handle": "frank@acme",
  "agent_id": "01HXYZ...",
  "api_key": "ah_live_...",
  "default_session_id": null
}
```

Loaded by the MCP server on startup. If missing or unreadable, the MCP
server still starts but every tool call returns an instructive error
("Run `agentrelay register` first").

### 6.2 `trust.yaml` — per-teammate trust policy (Layer 3)

```yaml
version: 1

# Default policy for handoffs from teammates listed below.
teammates:
  bob@acme:
    auto_read: true              # bob's handoffs trigger reads with no extra prompt
    auto_test: true              # ...and test runs
    auto_write_paths: []         # ...but no auto-writes
    require_approval: ["Edit", "Write", "Bash"]

  carol@acme:
    auto_read: true
    auto_test: true
    auto_write_paths: ["docs/", "README.md"]   # carol can auto-write docs
    require_approval: ["Edit", "Write", "Bash"]  # everything outside the auto_write_paths
                                                  # still asks the human

unknown_teammates:
  policy: "reject"               # 'reject' | 'allow_with_default_trust'

blocked:                          # populated by `agentrelay block`
  - mallory@external

defaults:                         # applied to listed teammates if not overridden
  auto_read: true
  auto_test: true
  auto_write_paths: []
```

Schema rules:
- `version: 1` is required. Future schema bumps document migration.
- Unknown top-level keys produce a warning, not an error.
- `auto_write_paths` are matched as glob prefixes. `docs/` matches
  `docs/api.md` and `docs/setup/quickstart.md`.
- `policy: "reject"` for unknown teammates means handoffs from anyone
  not in the `teammates` map are auto-rejected by Frank's MCP server
  (returns `-32013 teammate_blocked` to the relay).
- `blocked` is a hard override; entries here always reject regardless
  of any `teammates` entry.

---

## 7. Authentication & authorization

### 7.1 Authentication

API keys are the v0.1 mechanism. Format: `ah_live_<32-char-base32>` for
prod relays, `ah_test_<32-char-base32>` for test/dev.

On every authenticated request:

1. Extract the bearer token from `Authorization: Bearer <key>`.
2. SHA-256 hash with the per-row salt of every active key for performance:
   actually, we do this differently — see below.
3. Resolve to an `api_keys` row → `agent_id`.

**Hashing strategy (corrected):** since we can't iterate over all salts,
we use a global pepper and per-row hash. Concretely:

- On creation: `hash = sha256(GLOBAL_PEPPER || raw_key)`. Store
  `key_hash = hash`. The `salt` column is unused in v0.1; keep it for
  future flexibility (e.g., per-tenant peppers).
- On lookup: `hash = sha256(GLOBAL_PEPPER || incoming_key)`. Single
  indexed lookup on `key_hash`.

`GLOBAL_PEPPER` lives in `RELAY_PEPPER` env var, never logged.

If the key is found and not revoked: bind the request to its agent.
Update `last_used_at` async (every-N-seconds debounce to avoid write
amplification).

If not found: return `unauthenticated`.

### 7.2 Authorization

Authorization is checked at the service layer, not the router. Three
fundamental rules:

1. **Self-only writes on identity.** An agent can only modify its own
   `AgentCard`, rotate its own `ApiKey`.
2. **Participant-only access on threads.** Reading or appending requires
   the caller to be either sender or recipient of the thread.
3. **Role-restricted state transitions.**
   - `accept` and `complete`: recipient only
   - `cancel`: sender only, and only from `pending`

Every authorization failure increments a `forbidden_total` metric tagged
with the rule that fired.

---

## 8. A2A protocol mapping (concrete)

Where our domain meets the A2A spec.

| Our concept             | A2A primitive                                    | Field mapping                                                      |
| ----------------------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| Agent (DB row)          | A2A Agent (logical)                              | `handle` → A2A `id`; `display_name` → `name`                       |
| AgentCard (DB row)      | A2A AgentCard JSON                               | served at `/.well-known/agent-card.json?id=<handle>`               |
| Handoff                 | A2A Task                                         | `id`, `status.state`                                               |
| HandoffStatus           | A2A `Task.status.state`                          | `pending`→`submitted`, `accepted`→`working`, `completed`→`completed`, `cancelled`→`cancelled` |
| Message in thread       | A2A Message in Task.history                      | `body` → first text part; `payload` → metadata                     |
| Artifact                | A2A Task.artifacts (extended)                    | direct, with our typed shape                                       |
| send (new)              | `message/send` with no `task_id`                 | server creates Task                                                |
| send (append)           | `message/send` with `task_id`                    | appended to Task.history                                           |
| accept                  | `tasks/update` to state `working`                | extension param `transition: accept`                               |
| complete                | `tasks/update` to state `completed`              | extension param `transition: complete`                             |
| cancel                  | `tasks/cancel`                                   | spec method                                                        |
| inbox                   | `tasks/list` filter                              | extended with `role: recipient`                                    |

We use A2A extensions (a documented mechanism in the spec) for the
`transition` and `role` filter params. A vanilla A2A client can still
read our tasks; ours just expose extra ergonomics.

---

## 9. Notification dispatcher

### 9.1 Trigger

Every successful state-mutating call enqueues a notification job after
its DB transaction commits. Jobs:

- `notify.handoff.created` → recipient
- `notify.message.appended` → the *other* participant
- `notify.handoff.completed` → sender
- `notify.handoff.cancelled` → recipient (only if they had accepted)

### 9.2 In-process queue (v0.1)

A bounded async queue (e.g. `p-queue` or a small handwritten one) consumed
by a single worker task in the same Hono process. Drains in FIFO order.
Bounded at 10k items; full queue blocks the producing request — surfaces
backpressure rather than silently dropping.

### 9.3 Slack adapter

For each job:

1. Look up recipient's `notification_webhook_url`. If null, log and skip.
2. Decrypt URL.
3. Render Slack Block Kit payload (template per job type).
4. POST to webhook. Timeout 5s.
5. On 2xx: emit success metric.
6. On 5xx or timeout: retry up to 3 times with exponential backoff
   (1s, 4s, 16s). Final failure logs an error and emits
   `notification_failures_total{recipient,channel="slack",reason}`.
7. On 4xx other than 429: do not retry; emit failure metric.
8. On 429: respect `Retry-After`, retry once.

### 9.4 Failure isolation

Notification failures **never** roll back the inbox write. The relay's
correctness boundary is "the row is persisted" — notifications are a
best-effort signaling layer.

### 9.5 Rendered Slack payload (template)

```json
{
  "blocks": [
    { "type": "header", "text": { "type": "plain_text", "text": "👋 New handoff from Bob" } },
    { "type": "section", "text": { "type": "mrkdwn", "text": "*Summary:* Refactored /users API. New shape: paginated...\n*Thread ID:* `01HXY...`" } },
    { "type": "actions", "elements": [
      { "type": "button", "text": { "type": "plain_text", "text": "Open inbox" }, "url": "https://relay.acme.dev/inbox/01HXY..." }
    ]}
  ]
}
```

---

## 10. Idempotency

Every state-mutating MCP call generates a UUIDv4 client-side. The relay
stores it on the resulting row (`handoffs.idempotency_key`,
`messages.idempotency_key`).

On the relay:
- If the key is absent: proceed.
- If the key is present + payload matches the existing row: return the
  existing result with status 200 (idempotent replay).
- If the key is present + payload differs: return
  `duplicate_idempotency_key` (`-32011`).

This protects against:
- The MCP retrying on transient 5xx
- The model accidentally calling the same tool twice with the same args

Idempotency keys live for 24h and are then GC'd.

---

## 11. Observability (concrete)

### 11.1 Logging

`pino` structured JSON. Mandatory fields per record: `timestamp`, `level`,
`event`, `request_id`, `actor_id` (when authenticated), `route`.

Log volume budgets (per request):
- 1 access log line at start
- 1 access log line at completion (with status, duration_ms)
- N audit log lines (one per state mutation)
- 0–2 error/warn lines as needed

No PII in log bodies. Email and webhook URLs are redacted at the
logger configuration layer.

### 11.2 Metrics

Prometheus, exposed at `/metrics` behind `RELAY_METRICS_TOKEN`.

Counters:
- `requests_total{method,route,status_code}`
- `handoffs_created_total{sender_role,recipient_role}`
- `handoffs_accepted_total{recipient_role,duration_bucket}`
- `handoffs_completed_total{recipient_role,duration_bucket}`
- `notification_dispatch_total{channel,outcome}`
- `auth_failures_total{reason}`
- `forbidden_total{rule}`

Histograms:
- `request_duration_seconds{route}` (buckets 5,10,25,50,100,250,500,1000,5000ms)
- `inbox_latency_seconds` (created → first list returning the row)
- `notification_dispatch_duration_seconds`

### 11.3 Tracing

OTel SDK, OTLP exporter. Spans:

- `http.request` (root)
  - `db.query` (one per query)
  - `notify.enqueue`
  - `auth.resolve_key`

Trace ID propagated through Slack webhook in a header (`X-Trace-ID`) for
correlation with downstream issues.

---

## 12. Configuration (env vars)

### 12.1 Relay

| Var                          | Required | Default       | Description                                     |
| ---------------------------- | -------- | ------------- | ----------------------------------------------- |
| `RELAY_DATABASE_URL`         | yes      | —             | Postgres connection string                       |
| `RELAY_PEPPER`               | yes      | —             | API key hashing pepper, ≥32 bytes               |
| `RELAY_ENCRYPTION_KEY`       | yes      | —             | Symmetric key for `notification_webhook_url`    |
| `RELAY_ADMIN_TOKEN`          | yes      | —             | Bearer token for `/admin/*`                     |
| `RELAY_METRICS_TOKEN`        | yes      | —             | Bearer token for `/metrics`                     |
| `RELAY_PUBLIC_URL`           | yes      | —             | e.g. `https://relay.acme.dev`                   |
| `RELAY_ENV`                  | no       | `production`  | `production`/`staging`/`dev`                    |
| `RELAY_LOG_LEVEL`            | no       | `info`        |                                                 |
| `RELAY_AUDIT_RETENTION_DAYS` | no       | `90`          |                                                 |
| `RELAY_RATE_LIMIT_PER_MIN`   | no       | `60`          | Per-agent rate limit                            |
| `RELAY_DB_POOL_SIZE`         | no       | `20`          |                                                 |
| `OTEL_EXPORTER_OTLP_ENDPOINT`| no       | —             | If set, traces go here                          |

### 12.2 MCP server

The MCP server reads from `~/.agentrelay/config.json` (see §6).
Env overrides for testing only:

| Var                        | Description                                |
| -------------------------- | ------------------------------------------ |
| `AGENTRELAY_CONFIG_PATH`| Override config file path                  |
| `AGENTRELAY_DEBUG`      | If `1`, log MCP traffic to stderr          |

---

## 13. Deployment

### 13.1 Docker

`relay/Dockerfile` (multi-stage; pnpm in the builder, slim runtime):

```dockerfile
# ── builder ───────────────────────────────────────────────
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY relay/package.json relay/tsconfig.json ./relay/
RUN pnpm install --frozen-lockfile --filter @agentrelay/relay...
COPY relay/ ./relay/
RUN pnpm --filter @agentrelay/relay build

# ── runtime ───────────────────────────────────────────────
FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/relay/package.json /app/relay/dist /app/relay/drizzle ./relay/
RUN pnpm install --frozen-lockfile --prod --filter @agentrelay/relay...
EXPOSE 8080
CMD ["node", "relay/dist/main.js"]
```

### 13.2 Migrations

Drizzle (`drizzle-kit migrate`). Migrations are generated locally with
`drizzle-kit generate`, committed under `relay/drizzle/migrations/`, and
applied at container startup via a small entrypoint that runs
`drizzle-kit migrate` before binding the server. Migrations are
forward-only; each release tags the latest migration directory in the
changelog.

### 13.3 Hosting

Recommended for v0.1: **Fly.io** with a 256MB shared-cpu VM + Fly Postgres
(or external Neon/Supabase). Cost ≈ $5–15/mo for a small team.

### 13.4 Backups

Postgres point-in-time recovery enabled (managed by the host) + daily
logical backups via `pg_dump` to S3-compatible storage.

---

## 14. Testing strategy

### 14.1 Relay

- **Unit:** services (handoff state machine, message append) with mocked DB.
- **Integration:** real Postgres in a container, fastapi TestClient.
  Coverage target: every state transition + every error branch.
- **Contract:** the A2A test compatibility kit
  ([github.com/a2aproject](https://github.com/a2aproject)) run against
  our `/a2a` endpoint to verify protocol conformance.
- **Load:** k6 script, 50 concurrent senders, 10k handoffs, p99 latency
  assertion.

### 14.2 MCP server

- **Unit:** tool input validation (zod schemas), result mapping.
- **Integration:** spin up a real relay in Docker, run the MCP server
  against it, call each tool end-to-end.
- **Contract:** the MCP inspector tool to verify tool schemas are
  agent-readable.

### 14.3 End-to-end

A scripted "two laptops" test using two MCP processes pointed at the
same relay:
1. Bob registers, sends a handoff to Frank.
2. Frank registers, lists inbox, accepts, sends a clarification.
3. Bob replies.
4. Frank completes.
5. Assert: every Slack webhook fired, audit log shows expected actions,
   final state is `completed`.

---

## 15. Migration path to v0.2

Anticipating v0.2 (auto mode) without paying for it now:

- DB schema for `pairs`, `presence`, `live_messages` is already designed
  but not migrated. Migrations will be additive (no breaking changes).
- The notification dispatcher interface is pluggable; v0.2 adds an SSE
  channel without touching the Slack adapter.
- The MCP tool list is append-only; v0.2 adds `pair`, `unpair`,
  `wait_for_teammate_message`, `reply_to_teammate`, `ask_teammate` as
  new tools. Existing tools' signatures don't change.
- The relay's A2A endpoint already supports streaming via the spec's
  `message/stream` method; we just don't wire it in v0.1.

This means a v0.1 relay running in production can be upgraded to v0.2
in-place with a forward-only Drizzle migration and a rolling deploy.

---

## 16. Threat model summary

The four-layer trust model lives in `architecture.md` §5. This section
maps specific threats to which layer mitigates them — load-bearing for
incident response and code review.

| Threat                                              | Mitigated by                                                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Prompt injection in summary / artifact content      | **L1** wraps inbound content as untrusted data. **L2** denies external-effect tools and prompts on writes regardless of what the agent "decided." **L4** logs everything. |
| Bob's agent asks Frank's agent to push to git       | **L2** `deny` rule on `Bash(git push*)` blocks at the harness — the tool call doesn't execute even if approved by the agent. |
| Bob's agent asks Frank's agent to edit `apps/web/`  | **L2** `ask` rule on `Edit`/`Write` prompts Frank. **L3** can pre-authorize specific paths if Frank wants less friction for a trusted teammate. |
| Compromised teammate (e.g., Bob's account hijacked) | **L4** `agentrelay block bob@acme` revokes instantly. **L4** `agentrelay audit` shows what happened. Bob can rotate his key via §5.3. |
| Stolen API key                                      | Per-key `last_used_at` surfaces anomalies. Rotation is `agentrelay rotate-key`. Old keys revoked atomically.            |
| Compromised relay host                              | DB encrypted at rest; webhook URLs encrypted with separate key (`RELAY_ENCRYPTION_KEY`); secrets in env, not on disk.    |
| Compromised developer laptop                        | **Out of scope.** A rooted laptop can do anything Frank can do. Same as if Frank's machine was compromised without AgentRelay. |
| Cross-agent privilege escalation in the relay       | Authorization checked per request, not per session. Caller's API key resolves to one agent; can only operate on that agent's resources. |
| Webhook replay attack                               | Slack webhook URLs are unique per workspace; rotating one webhook compromises one channel.                              |
| DoS (handoff flood)                                 | Per-agent rate limit (`RELAY_RATE_LIMIT_PER_MIN`). Recipient inbox bounded at 10k pending; oldest dropped with audit entry. |
| Audit log tampering                                 | Append-only via DB role permissions; offsite backups. Out of scope: cryptographic chain (Merkle / blockchain stuff).    |
| Trust config tampering on receiver                  | `~/.agentrelay/trust.yaml` is mode 0600. If a malicious process can write to Frank's home dir, Frank's machine is already lost (out of scope, same as laptop compromise). |

---

## 17. Acceptance criteria for v0.1 ship

The v0.1 release is "done" when all of the following hold:

1. Two developers, on separate laptops, can register and send handoffs
   bidirectionally using either Claude Code or Codex CLI.
2. All six v0.1 MCP tools work and return expected shapes (`intent` field
   is wired for `inform` and `ask_question`; `propose_action` is the
   v0.1.5 deliverable).
3. Slack notifications fire reliably (≥99% delivery on healthy network).
4. The full state machine — pending → accepted → completed, plus cancel —
   has been exercised in CI integration tests.
5. The A2A test compatibility kit passes against the relay.
6. Idempotency replay test passes (same key, same payload, returns 200
   with original result; same key, different payload, returns 409).
7. p99 latency on `/a2a` is under 500ms in load test.
8. **Trust model layers 1–4 are demonstrably wired:**
   - L1: integration test verifies inbound text is provenance-wrapped.
   - L2: `agentrelay install` writes the recommended permission overlay
     to `~/.claude/settings.json` and `~/.codex/config.toml`.
   - L3: `~/.agentrelay/trust.yaml` is created on register; per-teammate
     overlay applied during `accept_handoff`.
   - L4: `agentrelay audit` and `agentrelay block` work end-to-end,
     blocked sender's `message/send` returns `-32013`.
9. The clarification-dance demo script (roadmap Phase 1) runs end-to-end
   on two real laptops without manual hand-holding. Captured as a 90-second
   demo video for the launch.
10. Docs (this LLD, the HLD, architecture, roadmap) are accurate to the
    shipped code.
11. A 5-minute "from zero" onboarding works end-to-end (register, install,
    send first handoff) with no manual editing of config files.
