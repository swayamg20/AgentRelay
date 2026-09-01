# Mailbox pilot log

Use one copy of this template for the 30-day AgentRelay mailbox validation. Record
operational facts and user behavior, not message bodies, credentials, invite URLs, or
private repository content.

The hypothesis and stop conditions live in [`roadmap.md`](roadmap.md). This log is
evidence for that decision, not a success narrative.

## Pilot metadata

| Field | Value |
| --- | --- |
| Start date | |
| Decision date | |
| Coordinator | |
| Relay version / commit | |
| MCP package version | |
| Relay deployment | |
| Number of invited pairs | |

## Pair setup

Complete one row per independently owned pair.

| Pair | Owners | Machines | Agent hosts | Setup minutes | Prompts/help required | First round trip | Consent or trust concern | Recruited by founder? |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- |
| P1 | | | | | | pass / fail | | yes / no |
| P2 | | | | | | pass / fail | | yes / no |
| P3 | | | | | | pass / fail | | yes / no |
| P4 | | | | | | pass / fail | | yes / no |
| P5 | | | | | | pass / fail | | yes / no |

## Thread log

Use Relay timestamps where available. Do not infer that a recipient read a message
from a notification or open connection.

| Thread | Pair | Real job | Relay stored | Receiver fetched | Receiver replied / sender cancelled | Pickup hint used | Fallback channel | Founder intervention | Useful outcome? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T01 | | | | | | none / manual / Slack | | none / describe | yes / no |

For any failure, classify the first broken step:

- Installation or identity
- Recipient discovery
- Request composition
- Relay storage
- Notification or pickup
- Agent understanding
- Reply or lifecycle semantics
- Trust or privacy
- Product was not preferable to the existing workflow

## Repeat-use check

Review each pair seven days after its first successful thread.

| Pair | Another useful thread? | Initiated without founder reminder? | Preferred over copying context? | Why or why not? |
| --- | --- | --- | --- | --- |
| P1 | yes / no | yes / no | yes / no | |
| P2 | yes / no | yes / no | yes / no | |
| P3 | yes / no | yes / no | yes / no | |
| P4 | yes / no | yes / no | yes / no | |
| P5 | yes / no | yes / no | yes / no | |

## Decision scorecard

These thresholds are hypotheses committed before results are interpreted.

| Gate | Threshold | Result |
| --- | --- | --- |
| First round trip | At least 4 of 5 pairs | |
| Unprompted repeat use | At least 3 pairs within seven days | |
| Setup | Median under 15 minutes | |
| Retrieval | At least 90% of stored messages retrievable during the pilot | |
| Safety and durability | No known committed-message loss or tested authorization, block, revocation, or provenance failure | |
| Workflow value | At least one recurring job preferred over manual context copying | |
| State honesty | No observed confusion between stored, fetched, and answered after explanation | |

## Dominant friction and next action

Select only from observed evidence:

- Pickup dominates: test the smallest local watch or notification improvement.
- Attachments dominate: specify bounded mailbox attachments or references.
- Host setup dominates: improve the requested installer or adapter.
- Commitment semantics dominate: first test refusal and timeout language in messages;
  propose new declined or expired wire states only if that evidence justifies a
  contract change.
- Cross-domain trust dominates: research addressing, consent, encryption, abuse, and
  tenancy before implementation.
- Repeat use is weak: stop feature work and conduct problem interviews.

## Final decision

**Decision:** continue / narrow / stop

**Evidence:**

**Smallest next change:**

**What remains parked:**
