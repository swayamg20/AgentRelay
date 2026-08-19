<p align="center">
  <img
    src="assets/brand/agentrelay-mark.svg"
    alt="AgentRelay logo: two independent agents exchanging a mission capsule"
    width="144"
  />
</p>

<h1 align="center">AgentRelay</h1>

<p align="center"><strong>Your agent should be able to call theirs.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/agentrelay-mcp"><img src="https://img.shields.io/npm/v/agentrelay-mcp.svg" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license" /></a>
  <a href="https://swayamg20.github.io/AgentRelay/"><img src="https://img.shields.io/badge/site-AgentRelay-111827.svg" alt="AgentRelay landing page" /></a>
</p>

<p align="center">
  <a href="https://swayamg20.github.io/AgentRelay/">Live site</a> ·
  <a href="https://discord.gg/r2R9v3cret">Discord community</a> ·
  <a href="#use-agentrelay-today">Use it today</a> ·
  <a href="#the-product-shape">Product shape</a> ·
  <a href="docs/roadmap.md">Roadmap</a>
</p>

> [!IMPORTANT]
> **Usable today:** the published `agentrelay-mcp` 0.2.1 mailbox lets
> already-running Claude Code and Codex agents exchange authenticated handoffs and
> messages through a team-operated Relay.
>
> **Not usable today:** autonomous Missions. Their durable Relay control plane exists,
> but the local Node still selects deterministic fake runtimes. The guarded Codex path
> has not been activated for a real model turn. A strict Codex descriptor, durable
> containment recovery handle, authority-gated Node/Capsule composition, and a
> non-claiming `doctor-codex` preflight now exist as internal checkpoints. There is no
> polling `run-codex` command, owner authentication, provider egress, workspace-write
> authority, registered verification execution, durable local evidence, installed
> service supervision, or two-machine proof. macOS also fails closed.

AgentRelay gives independently owned AI agents a durable collaboration line across
machines, repositories, and runtimes. They can exchange questions, contracts, and
evidence while repositories, credentials, and local authority stay with their
owners.

A backend developer's agent understands the backend repository. An Android
developer's agent understands the client repository. AgentRelay is intended to let
those agents negotiate a shared contract, implement their local work, and exchange
test evidence without either owner copying context through Slack or giving one
central agent access to both private repositories.

The long-term product is the network and local runtime bridge. Coding across two
repositories is the first proof, not the final product boundary.

## Honest status

| Status | Layer | Current boundary |
| --- | --- | --- |
| **Shipped** | Authenticated MCP mailbox | `agentrelay-mcp` 0.2.1: identities, invites, typed handoffs, messages, blocks, trust, and audit |
| **Shipped** | Durable Mission control plane | Relay + Postgres: Mission state, delivery leases, fencing, retries, recovery, and revocation |
| **Experimental** | Node, persistent Capsule, authority monitor, guardian, and containment | A guarded read-only Codex composition exists behind internal APIs; polling commands still select deterministic fake runtimes |
| **Next gate** | Guarded real Codex activation | Guarded Real Mission 0 through the public pipeline, then the two-machine backend ↔ Android proof |

The repository does not yet ship the full autonomous runtime described above. The
Node CLI still consumes one turn at a time through either its in-process deterministic
fake or a detached fake Capsule. The provider-neutral Capsule server and injected
Codex runner now have a strict v2 descriptor, passive persistent adapter, durable
read-only containment recovery, and private-authority composition, but no polling CLI
selects them. `doctor-codex` verifies only the pinned Linux/x64 artifact and version; it
does not open runtime state or claim Relay work. No path has executed a real model turn.

### Implemented today

- Postgres-backed identities, API keys, signed invite URLs, blocks, handoffs, and
  messages, with audit records for invite, handoff/message, and block mutations.
- A Hono relay with REST onboarding and an A2A-shaped JSON-RPC mailbox surface.
- Seven stdio MCP tools for Claude Code and Codex.
- Typed engineering artifacts, preserved message/completion payloads, and provenance
  markers on teammate-authored inbox, thread, payload, proposal, and artifact data.
- An executable `@agentrelay/protocol` workspace with bounded Mission contracts,
  strict lifecycle and coordinator reducers, a deterministic fake runtime adapter,
  and a reproducible backend-Android transcript fixture.
- Relay-visible Node/workspace contracts and Postgres persistence for Nodes,
  workspace bindings, Missions, append-only Mission events, per-Node deliveries, and
  append-only delivery-operation receipts. Public agent and Node routes create,
  list, inspect, and accept Missions; poll new work or scan recovery work; and claim,
  start, renew, complete, or release a delivery.
- Relay-issued 60-second leases bounded by Mission expiry, monotonic attempt fencing,
  exact operation replay, transactional result completion, retries, cancellation,
  dead-lettering, and audit evidence. Delivery discovery lazily reconciles eligible
  `active` or `verifying` Missions before reading work. The database deadline produces
  `expired`; otherwise the earliest unsettled dead letter produces `failed`. One
  system event, remaining-work cancellations, exact receipts, and audit evidence
  commit transactionally; current block and routing state fence later Mission work.
- Separately revocable Node credentials plus authenticated enrollment, credential
  rotation, Node revocation, and logical workspace registration routes. Agent and
  Node credentials are different key types; rotation is generation-fenced, and
  revoking a Node also revokes its active credential and workspace bindings, cancels
  active deliveries across affected Missions, and retains immutable Mission history.
- A private `agentrelay-node` workspace with strict mode-0600 device configuration,
  local alias-to-checkout mapping, canonical policy grants, repository URL/base/clean
  preflight, durable bounded Mission-assignment pagination, atomic cursor and
  operation journaling, recovery-first polling, fenced lease renewal, exact host-event
  replay, and foreground fake-adapter CLIs. Its `run-capsule` path launches one
  detached, Mission-scoped fake Capsule behind a private capability-authenticated
  Unix-socket protocol. The Capsule durably binds the exact start input before
  exposing acceptance. A stable private `run.lock` inode is held with a nonblocking
  kernel advisory lock, so a second live Node fails closed while normal exit,
  `SIGKILL`, and host reboot release ownership without deleting the file. Real
  Relay/Postgres E2E coverage kills the Node after host acceptance, proves the
  Capsule remains reachable, then restarts directly, recovers the same turn, and
  commits exactly one Mission result.
- A provider-neutral persistent Capsule server behind the existing versioned,
  capability-authenticated Unix wire. The fake Capsule CLI and Node path retain their
  existing descriptor and wire contract through a compatibility wrapper. Unexpected
  internal runtime failures return a redacted error and retire that running server
  generation. Runtime close begins while admitted handlers drain so the runtime can
  release and fence them; detached background work can request retirement directly.
- A private local-authority checkpoint on the persistent fake-Capsule path. After
  Relay authorization and repository preflight, the Node compiles one grant bound to
  the Agent, Node, workspace resource, Mission, delivery, execution attempt, lease,
  fence, accepted local-policy digest, and hard expiry. Journal schema 4 stores that
  exact grant before Capsule activation and preserves an older-fence predecessor until
  its Capsule retirement is proven. The Node and Capsule independently enforce the
  same product/local/Mission/runtime intersection; product policy always denies push,
  merge, package publish, deploy, arbitrary network access, secret access, and
  privilege expansion. A private install/renew/revoke channel gates Capsule session,
  start, recovery, cancellation, streamed output, usage, and artifacts. The Node
  separately gates final Relay completion and passes a continuous abort signal into
  the request. Bounded, redacted decisions can be emitted to injected evidence sinks,
  but no durable local evidence store is wired by default.
- A guarded Codex runtime checkpoint: the pinned client, schema-v2
  Capsule journal, and injected runner implement session start/resume, stable logical
  turn publication before provider binding, exact fresh-generation start
  reconciliation, event replay, and cancellation. Wire-level tests use fake
  app-server clients. A strict v2 descriptor and passive Capsule controller select this
  runner only through internal composition; no polling CLI selects it. The Codex
  child receives an allowlisted environment and a locally derived, canonical,
  current-user-owned mode-0700 home. For an inherited uncertain interrupt, a fresh
  generation reads the exact intent once, persists an authoritative terminal outcome
  when present, or records a transient failure; it never repeats the interrupt.
- A Linux containment checkpoint for pinned Codex `0.146.0`. It binds one
  owner-controlled standalone checkout to an explicit Bubblewrap filesystem policy,
  mandatory runtime canary, and exact retained recovery manifest. Its dedicated Linux
  process gate passes; the internal Codex provisioner durably binds it read-only before
  Capsule launch, while current polling commands still do not select it. See
  [research 006](docs/research/006-mission-workspace-containment.md).
- A guarded provider guardian that atomically owns one Codex generation behind a
  stable kernel lock. Before the durable start barrier or provider spawn, its detached
  guardian prearms an out-of-group teardown witness that retains the same lock. The
  witness independently enforces heartbeat and deadline loss, removes the complete
  guardian/provider process group, and is the only same-boot teardown writer of
  durable quiescence after proving group absence. Ambiguous same-boot ownership fails
  closed; changed kernel boot identity permits safe reboot recovery. Linux CI also
  starts pinned Codex
  through this guardian and the containment boundary. See
  [research 007](docs/research/007-codex-provider-guardian.md).
- CLI setup, invite/join, install, doctor/fix, key rotation, audit, relay-synchronized
  block/unblock, and local trust management.
- An in-process Slack dispatcher with encrypted-at-rest webhook configuration.

### Next architecture, not shipped yet

- Production CLI activation for persistent real-runtime sessions. The strict
  descriptor, passive Capsule server, provisioner, and adapter are composed internally,
  but the current persistent command still selects only the deterministic fake runtime.
- Owner-provisioned ephemeral authentication, provider-only egress, workspace-write
  authority, and Guarded Real Mission 0 through the public pipeline.
- Registered verification execution (#93), bounded Mission artifact carriage (#94),
  durable local authority and execution evidence (#99), and adversarial evaluation
  (#104). The current grant deliberately does not authorize verification execution.
- Completion of the guarded Codex path (#98), complete command/network effect
  mediation, an installed OS service boundary, and a supported containment boundary
  beyond Linux; then a Claude runtime adapter.
- A real two-machine, two-repository proof using the public control plane.

The design is in
[`RFC 001: AgentRelay Node and Missions`](docs/rfcs/001-agentrelay-node-and-missions.md).
The implemented lease and recovery decisions are recorded in
[`Delivery lease control plane`](docs/research/001-delivery-lease-control-plane.md).
The initial local checkpoint is recorded in
[`Foreground Node runtime`](docs/research/002-foreground-node-runtime.md).
The detached-process recovery checkpoint is recorded in
[`Persistent Mission Capsule`](docs/research/003-persistent-mission-capsule.md).
The guarded client and journal checkpoint is recorded in
[`Guarded Codex client and durable Capsule journal`](docs/research/004-codex-capsule-journal.md).
The provider-neutral server and injected-runner checkpoint is recorded in
[`Injected Codex Capsule runner`](docs/research/005-codex-capsule-runner.md).
The Linux-first workspace boundary and its remaining activation gates are recorded in
[`Mission workspace containment`](docs/research/006-mission-workspace-containment.md).
The provider-generation ownership and teardown checkpoint is recorded in
[`Codex provider guardian`](docs/research/007-codex-provider-guardian.md).
The private, fenced capability checkpoint and its remaining nonclaims are recorded in
[`Local runtime authority`](docs/research/008-local-runtime-authority.md).
The implementation sequence and stop/go gates are in
[`docs/roadmap.md`](docs/roadmap.md).

## The product shape

```text
Machine A                                              Machine B

Backend repository                                     Android repository
       |                                                       |
coding-agent runtime                                   coding-agent runtime
       |                                                       |
AgentRelay Node A  <---------- AgentRelay relay --------> AgentRelay Node B
                     durable, model-free coordination
```

- The **relay** owns identity, Mission truth, ordered messages, store-and-forward
  delivery, claims, acknowledgements, audit, and revocation.
- The **Node** owns local repository mappings, worktrees, runtime lifecycle, policy,
  budgets, and execution evidence.
- **MCP** exposes local AgentRelay tools to an already-running model host.
- **A2A** supplies public agent/task/message/artifact semantics at the network edge.
- **SSE** can signal new work, but durable database replay is the source of truth.

The relay does not run a manager model. Agents remain specialists in repositories
their owners control; a deterministic coordinator handles delivery, budgets,
termination, and verification.

## First proof

One human creates a bounded Mission for a backend feature and its Android client:

1. Both owners approve a repository binding, base commit, allowed paths and commands,
   denied external effects, and turn/time/token budget.
2. Both agents acknowledge the same objective and acceptance-contract revision.
3. Each Node validates an owner-prepared clean checkout or isolated worktree and
   starts a dedicated runtime session.
4. Agents exchange typed questions, answers, proposals, decisions, contracts,
   artifacts, progress, and verification evidence.
5. The coordinator completes only after both agents report ready and deterministic
   backend, Android, contract, and user-scenario checks pass.
6. Humans return for final review.

For the first slice, "done autonomously" means review-ready participant workspaces with a
replayable trace. Push, merge, publish, deploy, secrets, arbitrary network access,
and production credentials remain denied.

## Use AgentRelay today

Start with the published `agentrelay-mcp` mailbox. This is the only currently usable
end-user path; autonomous Missions are not yet available. The package connects
already-running Claude Code and Codex hosts to a Relay your team configures; no public
hosted Relay is bundled yet. Each developer needs Node 20.18.1+ and an AgentRelay
identity. Package-specific details live in
[`mcp-server/README.md`](mcp-server/README.md).

Pickup is explicit today: a human or an already-running agent checks the inbox.
Automatic wake-up and real coding-agent turns belong to the experimental Node path.

### Join with an invite

A registered team member with the relay admin token mints a single-use URL:

```bash
AGENTRELAY_ADMIN_TOKEN=<admin-token> \
  npx -y -p agentrelay-mcp agentrelay invite frank@acme \
  --role android \
  --expires 24h
```

The recipient runs:

```bash
npx -y -p agentrelay-mcp agentrelay join 'https://relay.example.com/join#v1.…'
npx -y -p agentrelay-mcp agentrelay doctor
```

`join` redeems the invite, writes mode-0600 local credentials and trust files, and
installs AgentRelay for supported clients.

### Manual registration

For CI or administrator-controlled onboarding:

```bash
npx -y -p agentrelay-mcp agentrelay register \
  --relay https://relay.example.com \
  --admin-token <admin-token> \
  --handle bob@acme \
  --email bob@acme.com \
  --name "Bob" \
  --role backend

npx -y -p agentrelay-mcp agentrelay install --client all
npx -y -p agentrelay-mcp agentrelay doctor --fix
```

Then ask the host agent to list teammates, send a handoff, or check the inbox. The
seven current tools are:

- `handoff_to_teammate`
- `check_inbox`
- `accept_handoff`
- `view_thread`
- `send_message`
- `complete_handoff`
- `list_teammates`

### Make the first round trip

Ask the sender's running agent:

```text
Use AgentRelay to list my teammates, then send an ask_question handoff to
frank@acme with the summary "Confirm the API contract."
```

Ask the receiver's running agent:

```text
Check my AgentRelay inbox, accept the handoff, and reply with the contract status.
```

Then ask the sender:

```text
View the AgentRelay thread <thread_id> and show me the latest reply.
```

Full setup and current limitations are in [`docs/onboarding.md`](docs/onboarding.md).
For a first shared team deployment on Azure, use the review-first
[`docs/deploy-azure.md`](docs/deploy-azure.md) pilot guide.

## Run the repository locally

Requires Node 20.18.1+, pnpm 9+, Docker, and Postgres 16 through Compose.

```bash
pnpm install
cp .env.example .env
pnpm db:up

RELAY_DATABASE_URL=postgres://agentrelay:agentrelay-dev@localhost:5433/agentrelay \
  pnpm --filter relay db:migrate
```

Load the server values from `.env` into your shell, then run:

```bash
set -a
. ./.env
set +a
pnpm --filter relay dev
```

Use [`CONTRIBUTING.md`](CONTRIBUTING.md) for exact test tiers. The database-free CI
unit command is:

```bash
pnpm --filter @agentrelay/protocol --filter relay --filter agentrelay-mcp \
  --filter agentrelay-node test
```

`pnpm -r test` also includes the Postgres-backed E2E workspace.

## Security posture

Cross-agent messages and artifacts are untrusted input. Current safeguards include
bearer authentication, participant authorization, block checks on new and existing
handoff messages and content-bearing transitions, a shared transaction lock that makes
a successful block response a commit fence for those mutations, Mission trust and
routing revalidation before activation or delivery work, revocation-driven delivery
cancellation, audit and durable receipts for delivery mutations, provenance
wrappers or markers on every teammate-originated mailbox field returned by MCP,
recommended host settings, and local trust parsing.

They are not yet a complete autonomous security boundary:

- The returned `trust_overlay` is advisory; no runtime consumer applies it
  dynamically.
- Relay audit omits several relay mutations and all local commands, edits, tests, and
  permission decisions.
- Notification pickup is best effort and does not acknowledge model processing.
- Successful CLI block/unblock updates both relay and local state, but those two writes
  are not one atomic transaction across the network and filesystem.
- Block is local-first and unblock is relay-first; a reported partial failure keeps
  local denial active and can be repaired by retrying the command.

The current Node enforces repository preflight, accepted local-policy identity, and
reported host-event bounds outside the model. On `run-capsule`, it also installs one
fenced, crash-safe authority grant into independent Node and Capsule reference
monitors. Those monitors continuously gate fake-runtime lifecycle, streamed output,
usage, artifacts, and final Relay completion, including expiry and revocation. Their
redacted decisions are emitted only when an evidence sink is injected; they are not
durably persisted by default. The guarded Codex checkpoint also allowlists the child
environment, derives a private exact-mode-0700 home locally, retires a failed Capsule
generation, and composes a strict read-only Linux descriptor with the same private
authority boundary. No polling CLI selects it, and owner authentication, provider
egress, workspace-write authority, the registered verification executor, durable
evidence, and adversarial real-turn proof remain open. Real autonomous writes are
therefore not safe to claim. See
[`docs/architecture.md`](docs/architecture.md) for the boundary and the RFC for the
acceptance tests.

## Protocol position

AgentRelay does not need to invent a replacement for A2A or MCP:

- [A2A](https://a2a-protocol.org/) is the public agent collaboration plane.
- [MCP](https://modelcontextprotocol.io/) is the local host/tool boundary.
- AgentRelay adds durable cross-device delivery and host-specific local activation.

The current relay uses custom A2A-shaped JSON-RPC methods. It does not yet expose a
current well-known Agent Card route or carry a current compatibility-suite result, so
this README does not claim full A2A conformance.

## Repository map

```text
.
├── AGENTS.md             coding-agent instructions: understand first, keep code clear
├── CLAUDE.md             Claude-specific entry point; delegates to AGENTS.md
├── protocol/             Mission schemas, coordinator, fixtures, and adapter contract
├── relay/                current Hono + Drizzle + Postgres relay
├── mcp-server/           current MCP server and agentrelay CLI
├── node/                 Node, Capsule wire, fake runtime, and guarded Codex checkpoints
├── tests/e2e/            relay + MCP and Node/Capsule process test harnesses
├── infra/azure/          reviewable Azure team-pilot infrastructure and smoke checks
├── landing/              GitHub Pages landing page
└── docs/
    ├── architecture.md   current truth and target boundaries
    ├── hld.md            current Relay high-level design
    ├── lld.md            current routes, tables, tools, and gaps
    ├── roadmap.md        evidence-gated implementation order
    ├── next-steps.md     near-term engineering queue
    ├── onboarding.md     current mailbox setup
    ├── hosting.md        relay hosting survey
    ├── deploy-azure.md   Azure Container Apps + private PostgreSQL pilot
    ├── deploy-fly.md     relay-only Fly.io example
    ├── auto-mode.md      superseded design decision record
    ├── ambient-agent.md  superseded design decision record
    ├── research/
    │   ├── 001-delivery-lease-control-plane.md
    │   ├── 002-foreground-node-runtime.md
    │   ├── 003-persistent-mission-capsule.md
    │   ├── 004-codex-capsule-journal.md
    │   ├── 005-codex-capsule-runner.md
    │   ├── 006-mission-workspace-containment.md
    │   ├── 007-codex-provider-guardian.md
    │   └── 008-local-runtime-authority.md
    └── rfcs/
        └── 001-agentrelay-node-and-missions.md
```

## Documentation rules

- Code and tests define what is shipped.
- [`docs/architecture.md`](docs/architecture.md) defines the current/target boundary.
- [`protocol/README.md`](protocol/README.md) describes the executable protocol package.
- [`node/README.md`](node/README.md) documents the private experimental Node, its
  fake-runtime commands, and guarded Codex checkpoints.
- [`protocol/fixtures/backend-android/README.md`](protocol/fixtures/backend-android/README.md)
  documents the deterministic cross-repository fixture.
- [`docs/next-steps.md`](docs/next-steps.md) tracks the near-term engineering queue.
- Accepted RFCs define intended behavior until code lands.
- Docs must label target behavior instead of presenting it as implemented.

## Contributing

Read [`AGENTS.md`](AGENTS.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md). The core rule is
simple: understand the complete contract before editing, write the smallest clear
solution, preserve security and public boundaries, and do not add speculative bloat.

Questions and early design discussions are welcome in the
[AgentRelay Discord community](https://discord.gg/r2R9v3cret). GitHub issues remain the
source of truth for scoped and claimed contribution work.

## License

[MIT](LICENSE) © 2026 Swayam Gupta and AgentRelay contributors.
