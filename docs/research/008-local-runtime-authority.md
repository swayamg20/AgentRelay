# Local runtime authority and reference-monitor checkpoint

- **Date:** 2026-08-17
- **Status:** Implemented and tested on the persistent fake-Capsule path.
- **Scope:** Private bound grants, crash-safe lease renewal, Node and Capsule reference
  monitors, continuous revocation, cumulative stream limits, and final Relay
  publication.
- **Nonclaim:** This does not activate Codex, execute a model turn, provide a
  verification-command handler, or durably store local decision evidence.

## Outcome

The persistent `run-capsule` path now converts trusted Relay and local inputs into one
strict runtime grant. The Node checkpoints the exact grant before runtime activation,
installs it over the private Capsule socket with the latest verified lease, renews it
while the Relay lease remains authoritative, and revokes it when authority is lost.

Independent reference monitors run on both sides of the socket. The Capsule monitor
guards runtime lifecycle and streamed events. The Node monitor guards the final Relay
completion request and supplies a continuous abort signal to that effect. A peer or
model cannot create, widen, renew, or override either monitor.

This closes issue #97 only as an unactivated reference-monitor checkpoint. The
currently selected runtime is still deterministic fake code. Issue #98 owns the
descriptor and CLI composition that must carry the same authority into the guarded
Codex and Linux containment path before a real model turn can run.

## Private boundary

```text
Relay delivery + lease/fence          trusted local Node inputs
              \                        /
               `-> compile exact grant
                         |
                   journal schema 3
                         |
             Node reference monitor
                         |
         private capability-authenticated socket
                         |
           Capsule reference monitor -> selected fake runtime
                         |
              bounded normalized events
                         |
             Node final-publish monitor -> Relay
```

The grant and its install/renew/assert/revoke methods are a private Node-to-Capsule
control plane. They are not exposed through peer messages, MCP tools, the public
Relay API, or the future A2A surface. A2A remains the public interoperability boundary
for agent, task, message, and artifact semantics. Mission leases, fencing, local
workspace identity, policy digests, and effect authority remain AgentRelay-private.

## Grant derivation

`createRuntimeAuthorityGrant` runs after all of these have succeeded:

1. The Relay delivery is authorized for the configured Node and remains `executing`
   under a current lease.
2. The Mission assignment and participant route match the delivery.
3. The locally selected policy profile matches the exact grant digest accepted for
   that Mission.
4. Repository URL, base commit, allowed ref, root, and worktree state pass local
   preflight.
5. The selected adapter reports its actual lifecycle capabilities.

The resulting schema binds:

- grant, Agent, Node, workspace binding, workspace alias, and a digest of the
  canonical local workspace resource;
- Mission, delivery, positive local execution attempt, Relay lease ID, and positive
  fencing token;
- local policy profile and grant digest;
- initial lease deadline and a hard deadline bounded by Mission expiry and maximum
  wall time; and
- exact action/resource capabilities plus product, local, Mission, and runtime limit
  sources.

Every action has one canonical resource type. Duplicate or mismatched capability
pairs fail validation. Unknown fields also fail validation, so remote content cannot
smuggle a path, working directory, argv, environment, sandbox, permission, credential,
or network destination into the authority contract.

## Intersection and product denials

The effective limit is computed rather than accepted from a caller:

```text
effective authority = product policy
                    intersection local policy
                    intersection Mission bounds
                    intersection runtime bounds
```

Numeric time, token, output, artifact-count, and artifact-byte limits take the minimum
of the four sources. Artifact types are the set intersection. Parsing an already
compiled grant recomputes this result and rejects a mismatch.

Product policy always denies these actions before capability lookup:

- repository push;
- repository merge;
- package publish;
- deploy;
- arbitrary network access;
- secret access; and
- privilege expansion.

The fake-Capsule grant currently permits runtime start, optional recovery and
cancellation according to adapter support, workspace read, usage reporting, artifact
publication, and final Relay publication. It deliberately does not permit workspace
write or verification execution.

The local policy module can resolve a registered verification command ID to a frozen,
shell-free executable/argv/cwd/timeout/environment descriptor. That resolver does not
execute the command and no delivery handler calls it yet. Issue #93 owns the handler
and the process boundary that must consume the authority signal and terminate the
whole command process group on loss. Before activation, that work must also resolve a
canonical absolute executable, reject unsafe or relative `PATH` entries, and bind the
resolved executable identity into the accepted local authority rather than trusting a
bare command name across restarts.

## Crash-safe grant and renewal

Node journal schema 3 stores the exact compiled grant in the delivery entry before
Capsule installation. Its journal validation correlates the grant with the current
delivery, Mission, execution attempt, lease ID, and fence. A second checkpoint for the
same execution attempt must be byte-for-byte equivalent. A new execution attempt
clears the old grant before a replacement can be compiled. The hard deadline is the
minimum of Mission lifetime and the effective per-turn limit, anchored to durable
Relay execution state, so renewal or process restart cannot reset the turn budget.

Schema 2 entries migrate with `runtime_authority: null`; the grant is then created from
current trusted inputs. A persisted grant is reused only when recompilation yields the
same body. This prevents a restart from silently widening scope because configuration,
workspace identity, or accepted policy changed.

A renewal keeps the grant ID, lease ID, and fence fixed and may only move the current
lease expiry forward. Exact replay is idempotent; expiry rollback, a different lease,
or a stale fence fails closed. On restart, installation sends both the original grant
and latest verified renewal in one request. Therefore an initial lease deadline that
passed while the Node was away does not discard a valid later renewal, while an
actually expired current lease still cannot activate the runtime. A renewal that
arrives while Capsule installation is in flight is buffered and forwarded immediately
after installation rather than being lost in the handoff.

## Capsule monitor

`CapsuleAuthority` accepts exactly one grant per running Capsule generation. An exact
replay renews the existing monitor without restarting its one-shot turn timer. A
different grant body or fence revokes the current monitor and fails closed rather than
changing authority in place.

The Capsule monitor guards:

- session creation;
- turn start;
- turn recovery, including both expected input and retained turn scope;
- turn cancellation; and
- every output-, usage-, or artifact-bearing streamed event.

Output bytes, reported tokens, artifact count, and artifact bytes use the normalized
cumulative stream state. This prevents a runtime from staying below the limit in each
frame while exceeding it across the turn. Artifact type must remain in the effective
intersection. Each admitted turn starts a one-shot turn-duration timer; grant
replay cannot reset it.

The monitor exposes an `AbortSignal` composed with the socket lifetime. Lease expiry,
hard expiry, explicit revocation, or a budget denial aborts the stream and schedules
retirement of that Capsule generation. Output observed after authority loss cannot be
forwarded as an authorized event.

## Node monitor and final effect

`NodeRuntimeAuthoritySession` installs its own monitor before asking the Capsule to
install the same grant. Every guarded Node effect follows this order:

1. Validate locally and record the local decision.
2. Ask the Capsule monitor to validate and record the exact same request.
3. Recheck locally after the remote round trip.
4. Start the effect with the local monitor's continuous abort signal.

This closes the local check-then-act window for final publication: the Relay client
composes the authority signal with Node shutdown and applies it to fetch, retry, and
backoff. Expiry or revocation after the last preflight stops the local request, but an
HTTP abort cannot prove that the Relay did not already commit. The Node therefore
retains the exact completion intent after an ambiguous abort. It may replay that intent
only while the exact authority remains valid; otherwise it stays pending instead of
guessing. An independent Relay receipt/status read does not exist yet.

The same local authority signal is raced through session setup, turn lookup, and every
host-stream wait. Expiry invokes one bounded cancellation/revocation path and prevents
later host output from being journaled or completed as authorized work.

Renewal succeeds remotely before it updates the local deadline. If either side fails,
the local monitor revokes and the runtime is not treated as authorized. Cancellation
first revokes local publication, then calls the still-authorized Capsule cancellation
operation, and finally revokes the Capsule grant.

## Evidence boundary

Each monitor can emit one strict record with:

- decision ID and timestamp;
- grant ID and grant hash;
- Agent, Node, workspace alias, Mission, delivery, execution attempt, and fence;
- action and resource; and
- allow/deny plus a bounded denial code.

The record contains no checkout path, prompt, artifact body, command, argv,
environment, output, provider ID, credential, or secret. Invalid request bodies are
reduced to an `unknown` action/resource instead of being copied into evidence.

Evidence emission is a fail-closed pre-effect boundary: an injected sink must accept
an allow record before the effect starts. Denial-record failures do not replace the
original denial. The selected Node and Capsule use no-op sinks today, so the
implementation does not claim durable local authority evidence. Issue #99 owns that
store and its retention/export contract.

## Failure matrix

| Failure | Result |
| --- | --- |
| Wrong Agent, Node, workspace, Mission, delivery, attempt, lease, fence, or policy digest | Exact request is denied before the effect. |
| Peer includes local cwd, argv, environment, sandbox, permission, credential, or network fields | Strict wire parsing rejects the request. |
| Mission asks for a product-denied effect | Product denial wins even if a capability was supplied. |
| Output, token, or artifact measurement exceeds the effective limit | Event is denied, authority is revoked, and the Capsule retires. |
| Initial grant lease is old but a retained renewal is current | Atomic install admits only the exact verified renewal. |
| Renewal replays exactly | Both monitors retain the existing deadline and turn timer. |
| Renewal rolls back expiry or changes lease/fence | Renewal fails closed and local authority is revoked. |
| Node restarts after grant checkpoint | Trusted inputs must reproduce the exact stored grant before Capsule recovery. |
| Authority expires during final Relay completion | The continuous signal aborts local fetch/retry/backoff. Because the Relay may already have committed, the exact completion intent remains durable; it is never erased or blindly republished. |
| Authority expires while the host stream is stalled | The Node races the signal with the host wait, runs bounded cancellation/revocation once, and records no completion. |
| Relay renews while Capsule installation is in flight | The latest verified renewal is buffered, then serialized into the installed monitor before host activation continues. |
| Evidence sink fails on an allow record | The guarded effect does not start. |

## Evidence exercised

Database-free tests cover:

- grant compilation, four-source intersection, strict action/resource pairs, product
  denials, wrong-scope requests, expiry, renewal replay/rollback, and bounded evidence;
- journal schema-2 migration, schema-3 checkpoint/reopen, exact-input correlation,
  and rejection of changed persisted authority;
- delivery grant installation after authorization and preflight, in-flight-install
  renewal buffering, cancellation/revocation, local-expiry host cancellation, crash
  recovery with the latest lease, and ambiguous final-completion retention;
- Node-local effect ordering and Relay-client cancellation across request, retry, and
  backoff; and
- the real private Capsule socket for install/assert/renew/revoke, lifecycle gating,
  cumulative event limits, conflict retirement, and stale-adapter recovery.

The Linux process job starts pinned Codex through the guardian and containment
boundaries, rejects every product-denied action plus a wrong-workspace request while
that process is live, then revokes authority and proves a delayed outbound effect does
not run. It still executes no model turn: this is process-boundary evidence, not proof
of a model generating an attack or a production descriptor carrying authority into a
real turn.

## Remaining gates

- **#93:** registered verification delivery/handler, canonical grant-bound executable
  identity, and signal-aware process-group execution.
- **#94:** bounded, provenance-preserving Mission artifact carriage.
- **#98:** explicit Codex descriptor/CLI activation plus durable exact containment
  recovery-handle storage.
- **#99:** durable local authority, command, edit, test, and permission evidence.
- **#104:** adversarial evaluation of the activated runtime, including attempts to
  widen path, command, sandbox, permission, credential, and network authority.
- **#120:** installed service/cgroup supervision and recovery when all local lifecycle
  owners are lost.

Until #98 and the later gates pass, describe #97 as a private reference-monitor
checkpoint on the persistent fake-Capsule path, not an autonomous Mission runtime or
an official A2A enforcement mechanism.
