# Auto Mode: superseded design exploration

> **Status:** Superseded by
> [`RFC 001: AgentRelay Node and Missions`](rfcs/001-agentrelay-node-and-missions.md).
> This file remains as a short decision record so the old listener-mode design is
> not rediscovered later.

## What the old design proposed

Auto Mode treated live collaboration as a separate product mode. Two developers
would explicitly pair, dedicate an agent session to a long-polling MCP tool, and use
Stop hooks to pick up messages between turns.

The useful ideas were:

- Mutual opt-in with a bounded lease.
- Presence as a hint, never a reason to lose queued work.
- Fast online delivery with automatic fallback to an asynchronous mailbox.
- One active turn per local session.
- Immediate cancellation by either owner.

## Why we are not building it as a separate mode

MCP tools are invoked by a host; a generic MCP server cannot require the host to
start a model turn. Stop hooks can continue work at a turn boundary but do not wake
an idle process or sleeping laptop. A dedicated listener session also makes the
developer keep an expensive runtime open merely to receive work.

The missing primitive is a long-running local AgentRelay Node. The Node consumes a
durable event stream, starts or resumes the appropriate host session through an
explicit adapter, applies local policy, and records whether the message was actually
processed. SSE or WebSocket remains only a low-latency signal to replay durable work.

## Where the surviving ideas live

- Pair or collaboration leases become Mission acceptance and expiry.
- Presence becomes advisory Node status.
- Async fallback becomes the normal durable delivery path.
- Live delivery becomes SSE notification over the same event ledger.
- Turn serialization and cancellation become Node/runtime-adapter responsibilities.

There is therefore no planned `/pair`, `/listen`, or
`wait_for_teammate_message` milestone. If a future user experience needs pairing, it
will be a view over the Mission and Node primitives rather than a second transport.
