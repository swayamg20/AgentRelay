# @agentrelay/protocol

Executable contracts for AgentRelay's bounded two-participant Mission loop.

The package contains:

- strict Zod schemas for Node enrollment, workspace registration, relay-visible
  Node/workspace descriptors, Mission manifests, participant acceptance receipts,
  contract revisions, typed messages, artifact references, delivery/cursor
  envelopes, delivery operations and receipts, runs, and evidence;
- pure Mission, fenced-delivery, and deterministic coordinator reducers that reject
  invalid transitions;
- a runtime-neutral host adapter contract, with a deterministic fake under
  `@agentrelay/protocol/testing`; and
- a packaged backend-Android fixture with reproducible Git commits, an accepted
  contract revision, duplicate/recovery replay, executable verification, and a
  post-completion hidden evaluator.

Wire schemas use `snake_case`. Adapter lifecycle fields use local TypeScript naming;
embedded relay payloads such as `TurnDisposition` and `ArtifactRef` deliberately keep
their exact wire shape so the Node validates what it publishes without an implicit
translation.

```typescript
import {
	missionManifestSchema,
	transitionMissionStatus,
} from "@agentrelay/protocol";

const manifest = missionManifestSchema.parse(untrustedInput);
const next = transitionMissionStatus("awaiting_acceptance", {
	type: "participants_accepted",
});
```

`missionCoordinatorEventSchema` and `reduceMissionCoordinatorEvent` join the
individually valid wire objects into one replayable Mission projection. The current
coordinator slice allows one scheduled participant at a time. A contract proposal
pauses turns, neither participant is implicitly acknowledged, both participant
identities require explicit events for the exact revision artifact, and the next turn
then belongs to the participant opposite the proposer. Each readiness cycle receives
a new verification round, so delayed evidence from an older cycle is rejected.
Required verification command IDs come from local coordinator configuration, never
peer text. Every participant result carries its source delivery ID, and verification
deliveries/results carry one exact coordinator round. Authenticated event ingestion,
source-work ownership, settlement, and lease fencing are Relay responsibilities; the
`relay/` workspace implements those responsibilities over Postgres and authenticated
Node routes.

`storedMissionDeliveryCursorPageSchema` carries each stored delivery together with
its immutable Mission event and trusted actor/source/causal provenance. Empty pages
may retain the caller's cursor checkpoint. `missionParticipantAcceptanceInputSchema`
records the exact shared contract and an opaque hash for the matching local-policy
grant without putting local policy details on the relay wire.

Node credential rotation is a generation compare-and-swap: owners read
`active_credential_id` from `ownedNodeSummarySchema` and submit that exact value with
`nodeCredentialRotationInputSchema`. Credential identity is deliberately absent from
the relay-visible `nodeDescriptorSchema`.

The adapter contract makes replay semantics explicit: every event has a stable
turn-local sequence, available usage is a monotonic cumulative turn snapshot, and
artifact input retains its version, source actor, exact hashed UTF-8 text, and a
validated typed value derived from that text. `acceptHostEvent` enforces
acceptance-first sequencing, one terminal event, and aggregate event/output/artifact
and reported-token limits across live delivery and full replay. A terminal event
requires a usage snapshot or explicit unavailability first. Initialize its state with
the requested host-turn correlation so the first acceptance cannot bind a different
delivery. Mission prompt fields should be built with `deriveHostMissionInputs` from
the relay-authenticated Mission context.

Delivery lease IDs, deadlines, and monotonically increasing fencing tokens are
Relay-issued authority. A Node presents the current lease ID and fence on start,
renew, completion, and release; it never selects the lease duration or server time.
The foreground Node now durably compares that authority with its processing journal
before fake-runtime start, recovery, or result publication. After shutdown or
authority loss, it uses the journaled turn mapping to request bounded cancellation.
Real runtime adapters must preserve the same boundary. Lease fields are not copied
into host turn references.

Every state-changing delivery input carries an idempotency key. An exact replay
returns the stored result with `replayed: true`; reusing the key for different input
is rejected. Claim, start, and renew replays still require current Mission trust and
routing authority because they expose or prolong execution authority. Exact complete
and release replays are historical responses and may survive a later teammate block,
but revocation or cancelled routing prevents any delivery receipt from being used as
authority. A replay response proves what previously committed; a Node must inspect
the current durable delivery state before causing a new host effect.

This package defines data, state transitions, and an in-memory deterministic proof.
It does not itself persist Missions or idempotency receipts; the sibling `relay/`
workspace now does. The repository still does not execute production local policy,
start a real model runtime, prove OS-process host-capsule recovery, or claim A2A
conformance.

Version 0.1 is the TypeScript/Zod binding used to prove the first Node. Committed
JSON Schema and OpenAPI bindings remain required before a non-TypeScript Node or
public A2A gateway treats this package as a language-neutral wire specification.
