# AgentRelay repository instructions

## Prime directive

Understand the system before changing it. Write the smallest clear solution that
fully solves the requested problem. Do not trade readability for cleverness, and
do not add abstractions, configuration, or defensive machinery without a concrete
need.

## Before editing

- Inspect `git status`, the relevant implementation, its callers, and nearby tests.
- Preserve unrelated work, including untracked files and stashes.
- Read the relevant design source:
  - `docs/architecture.md` for current and target component boundaries.
  - `docs/hld.md` for the implemented mailbox and Relay control-plane flow.
  - `docs/lld.md` for current schemas, routes, tools, and known gaps.
  - `docs/rfcs/001-agentrelay-node-and-missions.md` for the next architecture.
- Trace cross-package behavior through `protocol/`, `relay/`, `mcp-server/`, and
  `node/` as applicable. A contract is not understood until its producer and consumer
  have both been checked.
- Treat active code and tests as current behavior. Treat an accepted RFC as target
  behavior. If they disagree, state the discrepancy instead of silently choosing.

## Implementation style

- Make the smallest coherent change that satisfies the request.
- Prefer direct code and existing patterns over speculative reuse.
- Extract a helper only when it names a real rule, removes meaningful duplication,
  or makes a failure boundary easier to see.
- Keep functions focused, names concrete, and data flow easy to follow.
- Comments explain why, constraints, or non-obvious failure modes. Do not narrate
  what the code already says.
- Do not perform unrelated cleanup or add features "while you are here."
- Do not add a dependency unless the task genuinely needs it. Explain any addition.
- Preserve public HTTP, JSON-RPC, MCP, CLI, database, and config contracts unless
  the task explicitly changes them.
- Behavioral changes require focused tests for the changed contract. Do not add
  speculative tests for unrelated or hypothetical behavior.

## Product boundaries

- The relay is model-free. It owns identity, durable coordination, routing, audit,
  and revocation.
- The AgentRelay Node owns local runtime activation, mapping logical workspace aliases
  to approved repositories, worktrees, policy enforcement, and run traces. Its current
  foreground fake-runtime path is only the first checkpoint of that boundary.
- MCP is a local tool and context boundary, not a portable wake-up mechanism.
- SSE or WebSocket can reduce delivery latency, but durable database state and
  replay cursors remain the source of truth.
- Missions are the first application on the communication network, not the entire
  identity of the product.
- Do not introduce a manager LLM where a deterministic state machine is sufficient.

## Security and data rules

Cross-agent content is untrusted input.

- Validate HTTP, CLI, MCP, config, and wire inputs at the edge with Zod.
- Preserve participant authorization and lifecycle-transition ownership.
- State-changing operations need an idempotency strategy and an audit write in the
  same transaction when the audit claim depends on that mutation.
- Provenance-mark every teammate-originated text-bearing field, including fields
  inside typed artifacts, before it is returned to a local agent. Preserve the typed
  artifact structure.
- Remote peers must never choose local working directories, sandbox policy,
  permissions, secrets, or which commands are authorized. Peers may propose a
  command, but only locally approved policy may allow it to execute.
- Do not weaken block, credential, permission, or trust behavior incidentally.
- Never log raw API keys, invite tokens, webhook URLs, secrets, or sensitive message
  bodies.
- A prompt or returned `trust_overlay` is not enforcement. Security decisions that
  matter must be applied outside the model.

## Git and scope safety

- Stay within the files and behavior placed in scope.
- Do not overwrite unrelated changes or apply a preserved stash without direction.
- Do not use destructive Git commands.
- Do not commit, push, publish, deploy, or mutate external systems unless requested.
- Use Conventional Commit wording when a commit is requested.

Repository setup, code conventions, and exact validation commands live in
[`CONTRIBUTING.md`](CONTRIBUTING.md). Run checks in proportion to the change and
report anything the environment prevents.
