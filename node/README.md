# AgentRelay Node

`agentrelay-node` is the owner-controlled local execution boundary for AgentRelay
Missions. This package is private and experimental. Its current purpose is to prove
durable delivery, local authority checks, and runtime recovery with the deterministic
fake adapter before a real coding-agent adapter is introduced.

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

The real Relay/Postgres E2E test reconstructs a Node runner after host acceptance and
proves that the surviving fake host produces one turn and one Mission result.

## Current boundary

The foreground command uses only `FakeAgentHostAdapter`. The delivery processor can
publish `reply`, `propose_contract`, or `ready` turn results, while the current CLI
only generates deterministic `ready` or `reply` outcomes. It deliberately fails
closed for contract acknowledgement and verification deliveries because the required
artifact-payload and command-result paths are not complete.

Git submodules are intentionally unsupported at this checkpoint. Supporting them
requires a separate, explicit preflight for every nested repository and its local Git
configuration.

The current fake host lives in the Node process. Reusing it across a runner
reconstruction proves the journal/reducer boundary, not recovery after an OS-level
process kill. A persistent host capsule and the pinned Codex adapter are later gates.

## Configuration

The default path is `~/.agentrelay/node/config.json`. Override it with
`AGENTRELAY_NODE_CONFIG_PATH`. The file must be a regular non-symlink file with mode
`0600`. A remote Relay URL must use HTTPS; plaintext HTTP is accepted only for an
explicit loopback host during local development.

```json
{
  "schema_version": 1,
  "relay_url": "http://localhost:3000",
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

At this checkpoint, `max_reported_tokens` feeds the host-event reducer. The other
policy fields are validated and included in the acceptance grant hash, but turn
deadlines, network sandboxing, and registered verification-command execution are not
implemented yet.

Enrollment currently uses the agent-authenticated Relay route
`POST /agents/me/nodes`; its one-time returned Node credential is copied into this
separate config. The Node CLI does not yet own enrollment or credential rotation.
The current CLI always launches the fake adapter and therefore refuses
`ar_node_live_*` credentials; it runs only with an `ar_node_test_*` credential.

## Run

```bash
chmod 600 ~/.agentrelay/node/config.json
pnpm --filter agentrelay-node build
pnpm --filter agentrelay-node start --fake-outcome ready
```

Use `--once` for one recovery/poll/processing cycle. `SIGINT` and `SIGTERM` stop new
work, request cancellation of an in-flight fake-host turn, and release the singleton
process lock after the cycle returns. Adapter cancellation is bounded to five
seconds; an already-running Relay request still has its own bounded client timeout.

The local state is stored beside the config under `state/journal.json`. Do not run two
Node processes against the same directory; `run.lock` enforces the single-writer
assumption. A hard kill can leave a stale lock. The Node refuses to remove it
automatically, so confirm that no Node process is alive before deleting that exact
`run.lock` file and restarting.
