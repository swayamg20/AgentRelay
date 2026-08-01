# Ambient Agent: superseded design exploration

> **Status:** Superseded by
> [`RFC 001: AgentRelay Node and Missions`](rfcs/001-agentrelay-node-and-missions.md).
> The useful constraints from this proposal now belong to the Node runtime and its
> policy profiles.

## What the old design proposed

The original Ambient Agent was a later desktop or tray daemon that would notice an
inbox question, spawn a read-only headless agent, and queue a draft for human review.
It identified real requirements:

- Durable pickup while a CLI is closed.
- Explicit repository selection and dirty-worktree handling.
- Read-only or bounded-write sandboxing.
- Turn, time, and cost budgets.
- A queue that survives restarts.
- Clear disclosure that a response was machine-generated.

## Why the daemon moved to the center

Those requirements are not optional polish for drafting. They are the missing local
half of any autonomous cross-device collaboration. Without a persistent process on
the receiving machine, the relay can store a message but cannot start or resume a
coding-agent turn.

AgentRelay will therefore build one general local Node rather than a special-purpose
tray application. A read-only answer draft becomes one policy profile for a Mission;
editing and testing inside an isolated worktree becomes another.

## What is deferred

- Native tray UI and desktop notifications.
- Embedding-based repository indexing.
- Automatic recipient selection based on file ownership.
- Automatic sending of drafts without a bounded Mission grant.

If these surfaces become useful, they should call the same Node, delivery, Mission,
budget, and audit primitives. They should not introduce another daemon or execution
path.
