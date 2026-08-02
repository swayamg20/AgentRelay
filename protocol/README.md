# @agentrelay/protocol

Executable contracts for AgentRelay's bounded two-participant Mission loop.

The package contains:

- strict Zod schemas for Mission manifests, contract revisions, typed messages,
  artifact references, policy requests, delivery leases, runs, and evidence;
- pure Mission and fenced-delivery reducers that reject invalid transitions; and
- a runtime-neutral host adapter contract, with a deterministic fake under
  `@agentrelay/protocol/testing`.

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

Delivery lease IDs and fencing tokens are intentionally Node-owned. They are checked
with the lease deadline against durable delivery state before runtime
start/recovery/cancellation and result publication; they are not copied into host turn
references.

This package defines data and state transitions. It does not persist Missions,
execute policy, start a model runtime, or claim A2A conformance.

Version 0.1 is the TypeScript/Zod binding used to prove the first Node. Committed
JSON Schema and OpenAPI bindings remain required before a non-TypeScript Node or
public A2A gateway treats this package as a language-neutral wire specification.
