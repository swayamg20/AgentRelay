# Guarded Codex client and durable Capsule journal

- **Date:** 2026-08-03
- **Status:** Implemented and tested as an unactivated Node library checkpoint.
- **Runtime:** Codex app-server `0.146.0`, read-only policy only.
- **Scope:** Provider protocol validation, process ownership, durable local correlation,
  structured-output normalization, and crash-window design. No real Mission activation.

## Decision

Separate the first real-runtime work into three boundaries:

1. a small version-pinned app-server client that owns only provider protocol and local
   read-only policy;
2. a pure Mission-scoped journal that owns durable session/turn correlation and
   normalized `HostEvent` replay; and
3. a later Capsule runner that owns provider calls, reconciliation, event consumption,
   and restart behavior.

Only the first two exist. The Node and `agentrelay-capsule` commands still select the
deterministic fake runtime. No descriptor, config, or CLI path can start Codex.

## Guarded client boundary

The client:

- probes and pins Codex CLI `0.146.0` before spawning app-server;
- requires a canonical owner-controlled mode-`0700` Codex home;
- forces `HOME` and `CODEX_HOME` to that directory;
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
| `prepared` | Exact `StartTurnInput`, canonical digest, stable local turn ID, exact prompt/schema, hashes, and deterministic `clientUserMessageId` |
| `start_maybe_sent` | The at-most-once barrier was persisted before a future provider call |
| `accepted` | Provider turn ID and local `accepted` event were persisted atomically |
| `cancelling` | Local cancellation and interrupt-send barriers are durable |
| `terminal` | Usage or explicit unavailability precedes one bounded terminal event |

Every open and mutation revalidates the complete event stream through the shared
`acceptHostEvent` reducer. It also enforces immutable execution correlation, exact
duplicate input, one nonterminal turn, a 200-turn cap, and a bounded private state file.
AgentRelay-local session and turn IDs are portable within the Node journal; Codex IDs
remain private mapping details.

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

## Crash rule

`clientUserMessageId` is correlation, not idempotency. The future runner must:

1. persist `start_maybe_sent` before invoking `turn/start`;
2. after an uncertain result, read the bound thread with full turns;
3. find exactly one user message with the persisted client ID and exact text;
4. bind that provider turn, or fail on multiple/conflicting matches; and
5. never send a second start merely because no match is currently visible.

The journal contains the correlation primitive and deterministic reconciliation helper.
It deliberately does not yet solve the full zero-match window. Before activation, a
stable local turn reference must remain cancellable/discoverable before provider-ID
binding, and a zero match after proven provider-process quiescence must durably abandon
or fail the execution so the one-active-turn slot is released without resending.

## Evidence

Focused tests prove:

- session and turn at-most-once barriers survive close/reopen;
- an uncertain turn returns `reconcile`, never `send`;
- exact duplicate intent replays while changed input and a second active turn fail;
- provider acceptance atomically creates one local acceptance event;
- usage-before-terminal ordering and exact terminal replay survive reopen;
- cancellation is not invented before an authoritative provider terminal state;
- failed durable writes do not advance in-memory state;
- private mode/owner/canonical-path and aggregate file-size checks apply;
- exact client-ID/text reconciliation rejects zero ambiguity, duplicates, and conflicts;
- malformed structured output is not repaired; and
- secret canaries in disallowed items and provider errors do not reach normalized output.

The full Node suite remains the regression gate. An opt-in isolated live test proves the
installed `0.146.0` app-server handshake; it does not execute a Mission turn.

## Activation blockers

Do not wire this checkpoint to a real delivery until all of these are true:

- the Capsule runner implements exact restart reconciliation and the zero-match rule;
- cancellation before provider binding, revocation, deadline, and process-death races
  have fault tests;
- the runtime has OS-enforced read-root and secret isolation, not only output redaction;
- the child receives an allowlisted environment and an audited private Codex home;
- the generic Capsule server chooses the runtime locally without exposing Relay or Node
  credentials; and
- the missing contract-acknowledgement and registered verification delivery handlers
  exist for dispositions that depend on them.

The next checkpoint is the runtime-neutral Capsule store/server seam plus an injected
Codex runner tested entirely against a fake client. CLI activation comes only after that
runner passes crash, cancellation, and containment review.
