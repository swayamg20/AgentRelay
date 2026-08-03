# Experiment 001: deterministic backend-Android Mission

- **Date:** 2026-08-02
- **Result:** passed
- **Scope:** Stage 1 protocol and coordinator proof with fake runtimes

## Question

Can the executable Mission contract deterministically coordinate two isolated
participants through clarification, one shared-contract revision, local readiness,
and cross-repository verification without a human event after kickoff?

This experiment tests coordination semantics. It deliberately removes model variance
and durable networking so failures are attributable to the protocol projection.

## Frozen inputs

The checked-in fixture builder reproduces real Git commits from fixed files, author,
timestamps, messages, modes, and SHA-1 object format.

| Repository | Base commit | Scripted expected-result commit |
|---|---|---|
| Backend | `ce242c52841933788bc3b6a0a4e6c32ef38bf149` | `fdbb25c9dec30e47dbfbdeed193005150f1c63d7` |
| Android | `a976d7c7967b3ef8e89cbd1b9add606e08dbbbca` | `6b5f8d29b22f4c4767fa7fd0ded01424f6457678` |

Contract v1 is 371 exact UTF-8 bytes with SHA-256
`ec4721811c959df1b7b2947b307c130104b67ec76adf74bcd00361732372f184`.
Contract v2 is 542 bytes with SHA-256
`d0eac237df4e364624eb5af7372c6beeadb566e939ccae9edec75920dd47ee11`.

The initial Mission, exact contract locks, local verification registry, scripted
proposal revision, and two explicit acknowledgement inputs are the kickoff boundary.
Both fake adapters receive their complete outcome queues before the
participant-acceptance event. After the single runner call starts, there is no
owner-authored event, outcome injection, inbox nudge, blocked-input resolution, or
participant selection by a human.

## Golden transcript

The canonical machine-readable projection is
[`expected-transcript.json`](../../protocol/fixtures/backend-android/expected-transcript.json).

| Mission sequence | Event | Contract |
|---:|---|---:|
| 1 | Both participants accept the exact kickoff manifest and contract | 1 |
| 2 | Backend asks Android for nullable-avatar and fallback requirements | 1 |
| 3 | Android answers; the same delivery is started twice and applied once | 1 |
| 4 | Backend proposes contract v2 | 1 -> 2 pending |
| 5 | The pre-kickoff plan supplies Backend's exact acknowledgement event | 2 pending |
| 6 | The plan supplies Android's exact acknowledgement; v2 activates and Android owns the next turn | 2 |
| 7 | Android reports compatible decoder/UI progress; consumer resumes from partial host replay | 2 |
| 8 | Backend reports compatible response progress | 2 |
| 9 | Android reports ready | 2 |
| 10 | Backend reports ready; Mission enters verification | 2 |
| 11 | Locally registered `backend-test` passes | 2 |
| 12 | Locally registered `contract-test` passes | 2 |
| 13 | Locally registered `android-test` passes | 2 |
| 14 | Locally registered `public-user-scenario` passes; Mission completes | 2 |

Only after completion does the separate hidden evaluator run. It exercises a profile
name with leading and repeated whitespace that does not appear in runtime prompts or
public acceptance data.

## Observed result

- Final state: `completed` on contract v2.
- Host turns: 7.
- Typed messages: 4 (`question`, `answer`, `progress`, `progress`).
- Accepted contract revisions: 1.
- Duplicate host starts suppressed: 1; host turns created for that delivery: 1.
- Duplicate coordinator event and acknowledgement replay: no state mutation or turn
  increment.
- Partial host stream recoveries: 1, with the same contiguous stable event sequence.
- Required registered checks passed: backend, Android, contract, and public scenario.
- All four completion checks are fenced to verification round 1.
- Hidden cross-repository evaluator: passed after Mission completion.
- Human interventions after kickoff: 0 in the scripted event trace.
- Replaying all 14 events into a fresh reducer yields a deep-equal final projection;
  replaying them against the completed projection is a no-op.
- A new delayed turn after completion is rejected.

Run the proof with:

```bash
pnpm --filter @agentrelay/protocol exec vitest run \
  src/testing/backend-android-transcript.test.ts
```

## What this does not prove

The expected repository results and fake runtime dispositions are pre-authored. This
does not prove that a coding model can discover or implement the solution, that a
Postgres relay can transactionally persist and replay it, that receipts survive a
process restart, that a Node enforces real local policy, that offline machines catch
up, or that two devices communicate over A2A.

Those are the next evidence gates: durable relay delivery, foreground Nodes with
local journals and policy, then the pinned real-runtime two-machine pilot. The hidden
check here measures only the scripted fixture result and never steers Mission
completion.
