# AgentRelay Node

`agentrelay-node` is the owner-controlled local execution boundary for AgentRelay
Missions. This package is private and experimental. Its current purpose is to prove
durable delivery, local authority checks, and runtime recovery. The public polling
commands remain deterministic fake paths; guarded Codex activation exists only behind
internal, non-production composition.

## What works

- A separate Node-scoped bearer credential in a mode-0600 config file.
- Relay-visible workspace registration without sending the local checkout path.
- Pending-Mission acceptance under a canonical hash of an owner-local policy profile,
  with a durable Node-scoped keyset cursor, one bounded page per completed delivery
  cycle, Relay-time expiry filtering, and definitive Mission-specific rejections
  quarantined so poison assignments cannot starve later work.
- Canonical checkout, origin URL, exact base commit, allowed-ref, and clean-state
  checks before each turn. Repository-configured content filters and Git submodules
  fail closed before `git status` can invoke nested or external behavior.
- Recovery scan and one delivery-processing attempt before Mission-assignment scanning
  and new-cycle sleep.
- Atomic local persistence of cursor, delivery, operation intent, lease/fence,
  Mission session, execution-attempt history, normalized host events, and terminal
  result.
- Exact idempotent replay after ambiguous Relay responses.
- Relay-time retry eligibility, `(deliveryId, executionAttempt)` host idempotency,
  `lookupTurn` before `startTurn`, one host-event reducer for live and recovered
  streams, and lease renewal while the host turn runs. Lease-only reclaims preserve
  the execution attempt; a Relay-backed transient retry archives it and advances to a
  fresh host turn.
- An optional `run-capsule` path that launches one detached fake-runtime process per
  Mission and communicates through a private, versioned Unix-socket protocol.
- Durable Capsule descriptors, exact start inputs and hashes, host-session/turn
  references, stable event history, completion deadlines, and a Node-side execution
  registry. Recovery must present both the original turn reference and the exact
  `StartTurnInput`.
- Capability authentication on every Capsule request, strict request/response
  correlation, separately bounded 128 MiB request and 4 MiB response frames,
  mode-0700 directories, mode-0600 files and sockets, and an allowlisted child
  environment that excludes Relay, Node, and coding-runtime credentials.
- On `run-capsule`, one private grant bound to the Agent, Node, workspace, Mission,
  delivery, execution attempt, lease, fence, local-policy digest, and hard expiry.
  Journal schema 4 preserves that grant and any older-fence predecessor awaiting
  proven Capsule retirement. Independent Node and Capsule monitors enforce lifetime,
  cumulative output/usage/artifact limits, and final Relay publication outside the
  model. An optional owner-local `workspace_access: "write"` adds the exact
  workspace-write capability; omission or explicit `read` preserves the legacy
  read-only grant and accepted policy hash. This is a partial issue #97 checkpoint on
  the deterministic fake path, not completion of the issue or real-runtime activation.
  See
  [`Local runtime authority`](../docs/research/008-local-runtime-authority.md).
- A guarded Codex client, injected Capsule runner, provider guardian, strict v2 launch
  descriptor, persistent adapter, and Linux-only Codex `0.146.0` containment boundary.
  The Node provisioner durably binds an exact policy-selected read or write
  containment recovery handle before remote authority installation. The Capsule
  remains provider-passive through session establishment; starting, recovering, or
  cancelling an existing durable read-only turn may activate the guardian after the
  exact start input is journaled. Write-mode activation instead validates the retained
  containment and fails before the credential is claimed or the guardian, provider, or
  runner is opened. The guardian owns one kernel-locked provider generation, absolute
  deadline, local revocation signal,
  and liveness classification. It prearms a detached out-of-group witness before the
  start barrier; that witness retains the lock, removes the guardian/provider process
  group, and alone records same-boot teardown quiescence after proving the group absent.
  The dedicated Linux process job starts pinned Codex through both boundaries. An
  internal factory pairs the provisioner and adapter after a pinned-runtime doctor,
  but no polling CLI selects it and no test executes a real model turn.
- An internal one-shot Codex authentication boundary. The Codex-only detached launcher
  claims a fresh opaque owner credential for each actual Capsule start and transfers it
  only through fixed inherited fd 3, never argv, environment, or durable state. A
  validated schema-v2 Capsule owns that channel under one non-resettable 30-second
  activation deadline; schema v1 leaves it untouched. Authority-gated provider
  activation consumes the credential once in `account/login/start`, then verifies
  `account/read` with refresh-token loading disabled. Codex is forced to
  `cli_auth_credentials_store="ephemeral"`, and the live handshake leaves no
  `auth.json`. No owner-facing credential source exists, and no polling command selects
  this path.
- An internal provider-only egress boundary. Only the exact pinned app-server command
  selects the retained runtime profile, whose Codex-managed CONNECT proxy allows
  `api.openai.com`; version checks and containment probes select an offline profile,
  and nested read-only workspace sandboxes use `networkAccess: false`. This path is not
  selected by a polling command and has not executed a real model turn.

The real Relay/Postgres E2E coverage includes both in-process runner reconstruction
and an OS-process boundary: it kills the Node after Capsule acceptance, probes the
same live Capsule while the Node is absent, restarts the Node directly after the
kernel releases ownership, and proves one turn reference, one result message, and one
completion audit.

## Current boundary

Both foreground commands remain fake-runtime paths. `run` uses
`FakeAgentHostAdapter` in the Node process; `run-capsule` uses an independently
persistent fake Capsule. The delivery processor can publish `reply`,
`propose_contract`, or `ready` turn results, while the current CLIs only generate
deterministic `ready` or `reply` outcomes. They deliberately fail closed for contract
acknowledgement and verification deliveries because the required artifact-payload and
command-result paths are not complete.

Only `run-capsule` installs the private runtime-authority grant. The in-process `run`
command keeps the older fake-adapter boundary without an independent Capsule monitor.
The separate `doctor-codex` command verifies only the pinned Linux/x64 Codex and
Bubblewrap artifacts plus `codex --version`; it opens no Node/Capsule state and claims
no Relay work. No `run-codex` command exists. None of these commands executes a Codex
model turn or exposes an official A2A gateway.

Git submodules are intentionally unsupported at this checkpoint. Supporting them
requires a separate, explicit preflight for every nested repository and its local Git
configuration.

The Capsule checkpoint is experimental and Unix-only because its transport is a Unix
domain socket. It is not a general local daemon manager: there is no installer, OS
service supervisor, automatic process respawn, or production Codex/Claude activation.
The guarded Codex client, injected runner, guardian, descriptor, provisioner, adapter,
and Linux containment boundary form an internal read-only activation path plus a
fail-closed write-authority/containment checkpoint; see
[`Codex provider guardian`](../docs/research/007-codex-provider-guardian.md) and
[`Mission workspace containment`](../docs/research/006-mission-workspace-containment.md).
`agentrelay-codex-guardian` is the guardian's internal child-process entry point, not
a supported operator command or an activation path. Its internal `--reaper` mode is
the persistent teardown witness, not another public command.
The foreground Node's singleton ownership is crash-releasable, but an external
service manager must still start a replacement process.

## Configuration

The default path is `~/.agentrelay/node/config.json`. Override it with
`AGENTRELAY_NODE_CONFIG_PATH`. The file must be a regular non-symlink file with mode
`0600`. A remote Relay URL must use HTTPS; plaintext HTTP is accepted only for an
explicit loopback host during local development.

```json
{
  "schema_version": 1,
  "relay_url": "http://localhost:8080",
  "node": {
    "node_id": "00000000-0000-4000-8000-000000000001",
    "agent_id": "00000000-0000-4000-8000-000000000002",
    "credential_id": "00000000-0000-4000-8000-000000000003",
    "token": "ar_node_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "workspaces": {
    "backend": {
      "path": "/absolute/canonical/path/to/backend",
      "repository_url": "https://github.com/acme/backend.git",
      "allowed_base_refs": ["refs/heads/main"],
      "policy_profile": "bounded-code"
    }
  },
  "policy_profiles": {
    "bounded-code": {
      "max_turn_seconds": 900,
      "max_reported_tokens": 100000,
      "network_access": "denied",
      "verification_commands": {
        "test": {
          "argv": ["pnpm", "test"],
          "timeout_seconds": 300,
          "environment": ["PATH"]
        }
      }
    }
  }
}
```

The in-process `run` command uses `max_reported_tokens` in the host-event reducer but
has no independent Capsule reference monitor. On `run-capsule`, the Node derives the
private grant from current Relay authority and trusted local inputs; it enforces the
local turn limit, reported-token bound, product hard denials, lease/hard expiry,
renewal, revocation, cumulative stream limits, and final Relay publication. The fake
runtime exposes no command or network handler, and registered verification-command
execution remains unimplemented. `workspace_access` is optional and owner-local.
Omitted or explicit `read` produces the legacy read-only authority and canonical policy
hash; explicit `write` changes the accepted policy grant, adds workspace-write
authority, and selects exact write-mode containment. For read mode, the internal Codex
path composes the guardian and containment boundary with this grant and now includes the
one-shot owner API-key handoff, ephemeral-login boundary, and fixed provider-only
managed CONNECT egress for the exact app-server command. Write-mode activation stops
before the credential is claimed or those runtime components are opened. No polling
command selects either path. An owner-facing credential source, guarded
workspace-write model activation, patch mediation, durable write evidence, and real
model-turn evidence remain absent.

Enrollment currently uses the agent-authenticated Relay route
`POST /agents/me/nodes`; its one-time returned Node credential is copied into this
separate config. The Node CLI does not yet own enrollment or credential rotation.
The polling commands always launch fake adapters and therefore refuse
`ar_node_live_*` credentials; they run only with an `ar_node_test_*` credential.
`doctor-codex` does not load a Node credential.

## Run

```bash
chmod 600 ~/.agentrelay/node/config.json
pnpm --filter agentrelay-node build
pnpm --filter agentrelay-node start --fake-outcome ready
```

The built persistent-Capsule path is:

```bash
node node/dist/bin/agentrelay-node.js run-capsule \
  --config ~/.agentrelay/node/config.json \
  --fake-outcome ready
```

On a supported Linux/x64 host, the non-claiming Codex preflight is:

```bash
node node/dist/bin/agentrelay-node.js doctor-codex
```

It verifies the exact pinned package artifacts and bounded version probe before any
Node/Capsule runtime state is opened. Passing it does not enable Codex execution, select
the internal provider-egress profile, or load an owner credential: an owner-facing
credential source, guarded workspace-write model activation, and a polling `run-codex`
command are still absent.

Use `--capsule-root <absolute-path>` to override the default
`state/capsules` directory beside the Node config, and
`--completion-delay-ms <milliseconds>` to delay the deterministic fake result.

Use `--once` for one recovery/poll/processing cycle. `SIGINT` and `SIGTERM` stop new
work, request cancellation of an in-flight fake-host turn, and release the singleton
process lock after the cycle returns. A normal Node exit does not terminate detached
Capsule processes. Adapter cancellation is bounded to five seconds; an already-running
Relay request still has its own bounded client timeout.

The Node journal is stored beside the config under `state/journal.json`; Capsule state
defaults to `state/capsules/<mission-id>/`. Do not run two Node processes against the
same directory. A stable, mode-0600 `run.lock` is held with a nonblocking kernel
advisory lock, through exact-pinned `fs-native-extensions@1.5.0`, before the journal or
Capsule registry is opened. The lock file and inode remain permanently in place;
ownership is the live kernel lock, not the PID and timestamps written to the
separate sibling `run.owner.json` diagnostic file beside it. A second live Node
therefore fails before local state access, while normal exit, `SIGKILL`, and host
reboot release ownership automatically. A stopped or event-loop-stalled live Node
keeps ownership: there is no heartbeat or timeout-based stealing. Missing or
malformed diagnostics never grant or deny ownership.

Keep Node state on a local filesystem with supported advisory-lock semantics. This
checkpoint validates macOS and glibc Linux; Alpine/musl and network filesystems are
not established ownership boundaries and are unsupported here.

The Node closes the ownership handle last during graceful shutdown, and detached
Capsules do not inherit it. Symlinks, insecure or replaced lock paths, unsupported
lock behavior, and every legacy schema-1 PID lock fail closed with an operator-facing
error. PID-only evidence cannot exclude a live old Node in another PID namespace. For
the one-time upgrade, stop every Node that can access this state, verify the state is
offline, remove only the legacy `run.lock`, and start the new Node. Once schema 2 is
established, do not delete or replace `run.lock` as part of normal recovery. This
provides safe direct restart after process death; it does not install or run an OS
service supervisor.

The current Node journal uses schema 4. It retains the active attempt's exact validated
start input plus either its active runtime-authority grant or one older-fence
predecessor awaiting proven Capsule retirement. Schema-2 and schema-3 journals migrate
without inventing authority. Empty schema-1 journals migrate automatically; a
schema-1 journal with deliveries is rejected because its missing start inputs cannot
be reconstructed safely. Preserve and reconcile that state before replacing it.

Once any retained delivery for a Mission has a start input or host-attempt history,
Codex provisioning for later work in that same Mission is recovery-only. It must reopen
the exact retained containment instance and may accept expected dirty Mission edits; it
never creates a fresh boundary over that dirty checkout.

Each `launch.json` retains its original short private socket path, even if the
restarted Node has a different `TMPDIR`. A direct Capsule server start refuses any
existing socket path. The Node adapter can recover a crashed Capsule automatically,
but only after repeated failed authenticated probes and device/inode-checked removal
of the unchanged stale socket. An old server closes through a private bind alias and
therefore cannot unlink a replacement pathname.
