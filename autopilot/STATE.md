# Autopilot state

Working memory. The agent rewrites this file at the end of every session. It must
describe where the work stands well enough for a fresh session to continue.

## Goal as understood

No goal has been worked on yet.

## Plan

- [ ] Read `autopilot/GOALS.md` and break the goal into small, verifiable steps.

## Next step

Start from the first unchecked plan item.

## Waiting on owner

None.

## Learned about this repository

- Relay integration tests need Postgres. The autopilot job provides it at
  `localhost:5433` and exports `RELAY_TEST_DATABASE_URL`.
