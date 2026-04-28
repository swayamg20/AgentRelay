# Next steps

Living planning doc. Each item links to a GitHub issue with the proposed
solution sketched out. Strike through items as they ship.

## v0.1.2 — Onboarding fixes (this week)

Surfaced by the 2026-04-28 cross-machine integration test (~50 min for two
people; target was <15). All four are mechanical.

- [#1](https://github.com/swayamg20/AgentRelay/issues/1) — `agentrelay install` writes MCP entry to wrong settings file
- [#2](https://github.com/swayamg20/AgentRelay/issues/2) — `agentrelay-mcp` bin silently accepts CLI verbs as args
- [#3](https://github.com/swayamg20/AgentRelay/issues/3) — `doctor` MISSING entries should suggest the exact remediation command
- [#4](https://github.com/swayamg20/AgentRelay/issues/4) — `trust.yaml` example in docs uses wrong schema

Milestone: [v0.1.2](https://github.com/swayamg20/AgentRelay/milestone/1).

## v0.2.0 — 10-minute onboarding

The 50-minute number is the headline. Goal: a teammate goes from "got the
URL" to "first handoff received" in under 10 minutes on a clean machine.

- [#5](https://github.com/swayamg20/AgentRelay/issues/5) — Collapse `agentrelay-mcp` and `agentrelay` into a single bin (breaking)
- [#6](https://github.com/swayamg20/AgentRelay/issues/6) — One-command onboarding via signed invite URLs (`agentrelay invite` / `agentrelay join`)
- [#7](https://github.com/swayamg20/AgentRelay/issues/7) — `agentrelay doctor --fix` to auto-remediate MISSING entries

Milestone: [v0.2.0](https://github.com/swayamg20/AgentRelay/milestone/2).

## Beyond v0.2

- **v0.3 — auto mode**: live pairing channel between two agents. Design lives
  in [`docs/auto-mode.md`](auto-mode.md).
- **v0.4 — ambient agent**: headless drafting on the relay side. Design lives
  in [`docs/ambient-agent.md`](ambient-agent.md).
- **v1.0** — see [`docs/roadmap.md`](roadmap.md) for the phase-by-phase plan.

## Open questions

- **Invite URL signing key rotation.** `RELAY_INVITE_SECRET` rotation strategy
  needs spec'ing — invalidate all open invites or carry both keys for a
  grace window?
- **Relay hosting model.** Is a hosted "AgentRelay Cloud" the right v1.0
  story, or do we stay self-host-only? Affects the invite URL UX (custom
  domain vs `*.agentrelay.dev`).
- **Admin-token rotation UX.** Today rotation breaks every joiner who hasn't
  registered yet. Invite URLs (#6) sidestep the issue; should we deprecate
  raw admin-token onboarding for humans entirely?
- **Per-team relay vs multi-tenant.** Current design is one relay per team.
  Worth re-examining once we have >5 self-hosters.

## Process notes

- One issue per concern. Cross-cutting doc updates ride along with the
  feature issue, not as their own row.
- Probable solution lives in the issue body so the work is loadable
  without re-deriving context.
- Closed issues stay linked here (struck through) so future contributors
  can follow the through-line from "thing was painful" → "issue → PR →
  released".
