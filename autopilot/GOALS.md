# Autopilot goals

status: running

<!--
Owner-controlled. Edit this file on `main` (the GitHub web editor or mobile app is
fine). Every scheduled run reads the latest version from `main` before it starts.

- `status: running` lets scheduled runs work. `status: paused` makes them exit
  immediately. Keep the line exactly in the form `status: <value>`.
- Changing the goal takes effect on the next run. The agent rewrites its plan in
  `autopilot/STATE.md` when the goal changes.
- Close the autopilot draft PR without merging to discard its work. The next run
  starts fresh from `main`.
- Runs start at 09:00, 14:00, and 20:00 IST, and immediately when the owner replies
  on an open `autopilot:needs-you` issue.
-->

## Current goal

Pick the first implementation goal. Read the open issues labelled `core-mailbox`
(skip `labs`, `demand-gated`, and epics) together with the code they touch, and
propose the three best candidates that one run can finish and verify. Do not
implement anything until the owner chooses. After the owner replies, implement the
chosen issue.

## Done when

- A question issue lists three candidates, each with a short plan, the files it
  touches, how it will be verified, and a recommendation.
- After the owner picks one, it is implemented with passing checks and tests.

## Priorities and constraints

- Keep changes small and reviewable. Prefer one concern per commit.

## Off-limits

- Release, publish, and deploy workflows (`.github/workflows/deploy*.yml`,
  `publish-image.yml`) and `infra/azure/`.
- Package version bumps and changelog release entries.
- Anything under `autopilot/` except `STATE.md` and `JOURNAL.md`.
