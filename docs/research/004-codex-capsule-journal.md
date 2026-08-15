# Guarded Codex client and durable Capsule journal

- **Date:** 2026-08-03
- **Status:** Client and journal implemented; the unactivated runner continuation is
  recorded in [`005-codex-capsule-runner.md`](005-codex-capsule-runner.md).
- **Runtime:** Codex app-server `0.146.0`, read-only policy only.
- **Scope:** Provider protocol validation, process ownership, durable local correlation,
  structured-output normalization, and crash-window design. No real Mission activation.

## Decision

Separate the first real-runtime work into three boundaries:

1. a small version-pinned app-server client that owns only provider protocol and local
   read-only policy;
2. a pure Mission-scoped journal that owns durable session/turn correlation and
   normalized `HostEvent` replay; and
3. a Capsule runner that owns provider calls, reconciliation, event consumption, and
   restart behavior.

All three now exist as unactivated libraries. The provider-neutral server and runner
checkpoint is detailed in research 005. The Node and `agentrelay-capsule` commands
still select the deterministic fake runtime. No descriptor, config, or CLI path can
start Codex. The separate, also-unactivated Linux process boundary is detailed in
[`006-mission-workspace-containment.md`](006-mission-workspace-containment.md).

## Guarded client boundary

The client:

- probes and pins Codex CLI `0.146.0` before spawning app-server;
- derives `codex-home` locally beneath the Capsule and requires both directories to be
  real, canonical, current-user-owned, and exactly mode `0700`;
- supplies only a small child-environment allowlist, with `HOME` and `CODEX_HOME`
  replaced by that derived directory;
- starts/resumes one persistent read-only thread with approvals disabled and network
  disabled;
- validates the thread ID, working directory, CLI version, sandbox, and policy returned
  by the provider;
- accepts one bounded notification consumer and correlated bounded JSONL responses;
- rejects malformed lifecycle data and every unsupported provider request;
- kills the owned process group on failure or close; and
- performs one raw `turn/start` wire attempt. It does not claim provider idempotency.

The client does not decide whether a delivery may run or whether an uncertain start may
be retried. Those are Capsule/Node durability decisions.

## Durable journal boundary

`CodexCapsuleStore` is intentionally provider-process-free. It does not import or call
the app-server client. It persists only locally derived intent, opaque correlation, and
validated provider-neutral events.

Session phases:

| Phase | Meaning | Safe next action |
| --- | --- | --- |
| `prepared` | Stable local session ID exists; no provider-start barrier crossed | Atomically claim one send |
| `start_maybe_sent` | Provider thread start may have been attempted | Reconcile or stop; never blind resend |
| `ready` | Private provider thread ID is durably bound | Resume and verify exact scope |

Turn phases:

| Phase | Durable facts |
| --- | --- |
| `prepared` | Exact `StartTurnInput`, canonical digest, stable local turn ID and `accepted` event, exact prompt/schema, hashes, and deterministic `clientUserMessageId` |
| `start_maybe_sent` | The at-most-once barrier was persisted before a future provider call |
| `accepted` | Provider turn ID is durably bound to the already accepted logical turn |
| `cancelling` | Local cancellation and interrupt-send barriers are durable |
| `terminal` | Usage or explicit unavailability precedes one bounded terminal event |

Every open and mutation revalidates the complete event stream through the shared
`acceptHostEvent` reducer. It also enforces immutable execution correlation, exact
duplicate input, one nonterminal turn, a 200-turn cap, and a bounded private state file.
AgentRelay-local session and turn IDs are portable within the Node journal; Codex IDs
remain private mapping details. Schema v2 deliberately exposes the logical turn before
provider binding. It does not migrate schema-v1 development state.

## Structured result boundary

The read-only checkpoint permits only:

- `reply` without artifacts; or
- `blocked` with an optional requested input.

`ready`, contract proposals, reply artifacts, verification evidence, and model-selected
failure classification remain disabled until the corresponding Node handlers and local
evidence paths exist.

Normalization requires one exact JSON final-answer item. It does not strip Markdown
fences or repair malformed output. Reasoning and deltas are ignored. Provider errors,
commands, paths, output, MCP payloads, and passthrough metadata are never copied into
durable state or returned events. Per-turn usage uses `tokenUsage.last`, not the
thread-wide total. An interrupted provider turn becomes `cancelled` only when a durable
local cancellation intent exists.

## Implemented crash rule

`clientUserMessageId` is correlation, not idempotency. The injected runner now:

1. requires a fresh provider generation and an injected assertion that the previous
   generation is quiescent before creating the client;
2. persists `start_maybe_sent` before invoking `turn/start`;
3. after an uncertain result, reads the bound thread with full turns;
4. finds exactly one user message with the persisted client ID and exact text;
5. binds that provider turn, fails on multiple/conflicting matches, or durably records
   a bounded zero match as `failed` or already-requested `cancelled`; and
6. never sends a second start merely because no match is visible.

The stable local turn remains discoverable and cancellable before provider binding.
Pre-binding cancellation survives reconciliation and produces one interrupt after an
exact provider match. The quiescence authority is only an injected seam: there is no
production guardian that owns proof and process spawn as one lifecycle. If a fresh
generation inherits `interrupt_maybe_sent`, the runner does not send it again. It
reads the exact intent once, persists an exact terminal provider outcome when present,
or records a redacted transient failure and releases the active-turn slot. A rejection
of the first interrupt RPC retires that provider generation before this recovery.

## Evidence

Focused tests prove:

- session and turn at-most-once barriers survive close/reopen;
- an uncertain turn returns `reconcile`, never `send`;
- exact duplicate intent replays while changed input and a second active turn fail;
- turn preparation atomically creates one stable local reference and acceptance event
  before provider binding;
- usage-before-terminal ordering and exact terminal replay survive reopen;
- cancellation is not invented before an authoritative provider terminal state;
- failed durable writes do not advance in-memory state;
- private mode/owner/canonical-path and aggregate file-size checks apply;
- exact client-ID/text reconciliation rejects zero ambiguity, duplicates, and conflicts;
- malformed structured output is not repaired; and
- secret canaries in disallowed items and provider errors do not reach normalized output.

Runner tests additionally traverse the real Capsule Unix wire with fake app-server
clients and prove a fresh turn, duplicate coalescing, lost-start-response recovery,
bounded zero match, pre-binding cancellation, session resume, and failure before client
creation when quiescence is not asserted. Separate executor tests prove one exact read
for an inherited uncertain interrupt, authoritative terminal normalization when found,
and transient failure otherwise, without another interrupt. They do not execute a
model turn.

The full Node suite remains the regression gate. An opt-in isolated live test proves the
installed `0.146.0` app-server handshake; it does not execute a Mission turn.

## Activation blockers

Do not wire this checkpoint to a real delivery until all of these are true:

- a production guardian owns provider-generation identity, quiescence proof, and
  spawn, with heartbeat and owner-death evidence;
- revocation, deadline, and process-death races have fault tests and closed recovery
  rules against a real provider;
- the Linux containment library is composed into the selected descriptor/CLI path,
  and the Mission lifecycle durably stores its exact recovery handle before provider
  start;
- a locally selected descriptor/runtime factory activates Codex without exposing Relay
  or Node credentials;
- the missing contract-acknowledgement and registered verification delivery handlers
  exist for dispositions that depend on them;
- bounded Mission artifacts, local capability enforcement, structured dispositions,
  and execution evidence are implemented; and
- Guarded Real Mission 0 passes before the two-machine Mission proof begins.

The Linux containment process gate now passes. The remaining dependency order,
through contract/artifact carriage, guardian/descriptor composition, and Guarded Real
Mission 0, lives in the [roadmap](../roadmap.md). Research 005 records what the
current injected runner proves; research 006 records containment and its lifecycle
gates.
