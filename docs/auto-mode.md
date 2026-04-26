# Auto Mode (v0.2) — Live Agent-to-Agent Channel

## What it is

A synchronous, RPC-shaped channel between two paired agents. When both
developers are online and explicitly paired, one agent can ask the other a
question and get an answer in the same turn — no `/inbox` polling, no manual
approval per message.

Think of v0.1 (mailbox) as Slack DM. Auto mode is the phone call.

## Activation: explicit pairing

Pairing is opt-in on both sides. Neither side can be force-paired.

```
Bob:    /pair frank
        → Frank's terminal: "Bob wants to pair for live agent-to-agent
           questions. Accept? [y/N]"
Frank:  y
        → Channel open. Both terminals show "🔗 Live with frank/bob"
```

A pair is a session-scoped lease (default 1h, renewable). Either side can
`/unpair` instantly. If either side closes the CLI, the lease auto-expires
within the heartbeat window (~10s).

## Presence

Each MCP server, when in live mode, sends a heartbeat to the relay every 5s.
Relay tracks `online`, `paired_with`, `session_id`. If the heartbeat lapses,
the peer is marked offline and any in-flight `ask_teammate` calls fail
back to async (the question lands in the inbox instead).

## Two roles in a paired channel

### Caller (Bob's side)

Works normally. When Bob's agent calls:

```
ask_teammate(to: "frank", question: "What's the user object schema in your
             Android API client?", live: true)
```

The MCP server posts to the relay, which forwards to Frank's open long-poll.
Bob's tool call blocks until Frank's agent replies (with timeout, default 120s).
The reply is returned to Bob's agent as the tool result, indistinguishable from
a normal MCP response.

### Listener (Frank's side)

Frank dedicates a session to listening. One way to enter listener mode:

```
Frank: /listen
       → Agent enters a wait loop: calls wait_for_teammate_message(timeout=300)
       → Tool blocks server-side via long-poll on the relay
       → When Bob's question arrives, tool returns with the question payload
       → Agent answers, calls reply_to_teammate(thread_id, answer)
       → Loop back to wait_for_teammate_message
```

Frank sees each question and answer streaming in his terminal as if he were
typing — but no input is required. He can interrupt with Esc at any time, which
exits the listen loop and (optionally) sends a "Frank stepped away" message.

## Why a "listen loop" instead of pushing into Frank's session

MCP is pull-based: tools are called by the agent, not pushed to it. There is no
way for the relay to "inject" a message into a running agent's context against
its will. The listen loop reframes that constraint as a feature: Frank's agent
voluntarily waits for messages, so each one is a normal turn boundary, never an
interruption mid-tool-call.

This also means listener mode is a deliberate choice. Frank uses *one*
session as his "duty session" and works out of others. He doesn't worry about
random questions popping into whichever CLI happens to be focused.

## What if Frank wants to do his own work while listening?

Two options, in increasing complexity:

**v0.2 (ship first):** dedicated listener session. Frank uses session A as
his duty session, sessions B/C/D for his own work. Simple, reliable.

**v0.2.5 (only if asked for):** interleaved listener. Frank's working session
also listens; questions arrive as system messages between his prompts. Needs
careful UX to avoid stepping on Frank's in-flight work. Defer until v0.1 + v0.2
prove the loop works.

## Hooks for non-listener pickup

If both sides are paired but Frank is *not* in `/listen` mode (he's just
working normally), incoming questions still need to surface. Mechanism:

- `Stop` hook in Claude Code (and the Codex equivalent) runs after each agent
  turn completes
- Hook checks the relay for pending live messages tagged for this session
- If a message exists, hook exits with code 2 and the message body, which
  Claude Code interprets as "continue with this prompt"
- Frank's agent picks up the question on the next turn, answers, and the cycle
  continues

This makes pairing useful even without an explicit `/listen` mode — Frank's
agent picks up questions at every turn boundary. Slightly less responsive than
the long-poll loop (questions wait until Frank's current turn finishes) but
zero ergonomic cost.

## Fallback to async

Three failure modes, all degrade to v0.1 mailbox:

1. **Peer goes offline** (heartbeat lapses): in-flight `ask_teammate` returns
   `{ status: "queued", reason: "peer_offline" }`. Question lands in async
   inbox. Sender's agent decides whether to wait, give up, or rephrase.
2. **Pair lease expires** mid-call: same as above.
3. **Question times out** (120s default with no answer): same as above. The
   question is preserved in the inbox so Frank can answer when he returns.

This means the sender's agent never has to handle "live mode is broken" as
a special case — it just gets the same response shape with a different
`status` field, and the question is never lost.

## Trust model

- Pairing is mutual opt-in; neither side can force it.
- Pair has a TTL. Default 1h. Renewable.
- Within a pair, the receiving agent answers without per-message human
  approval — this is the whole point. The human approved *the channel*,
  not each message.
- The receiving human sees every Q&A streaming in their terminal in real
  time. If something looks wrong, Esc kills the channel instantly.
- Caller-side: same as v0.1 — the human still confirms outbound `ask_teammate`
  calls via the normal MCP tool-approval prompt (or pre-approves the tool).

## Wire-level summary

```
Bob's agent         Bob's MCP        Relay         Frank's MCP        Frank's agent
                                                  (listen loop)
     │                  │              │              │                    │
     │ ask_teammate ─►  │              │              │                    │
     │                  │ POST /ask ─► │              │                    │
     │                  │              │ ─push to────►│                    │
     │                  │              │ long-poll    │ wait_for_message ◄─┤
     │                  │              │              │ returns question   │
     │                  │              │              │                    │ (answers)
     │                  │              │              │ reply_to_teammate ◄┤
     │                  │              │ ◄── reply ───│                    │
     │                  │ ◄── answer ──│              │                    │
     │ ◄─── result ─────│              │              │                    │
```

## Open questions to resolve before building

- Does `/pair` work transitively? (Bob paired with Frank, Frank paired with
  Mike — can Bob ask Mike?) Default: no, pairs are 1:1.
- Should we support group channels (one caller, multiple listeners)? Default:
  no for v0.2, revisit if asked.
- How do we display the channel in the terminal so Frank always knows he's in
  listen mode? A persistent header line or a colored indicator.
- Logging: every Q&A in a paired channel is recorded by the relay for audit.
  Who can read it?
