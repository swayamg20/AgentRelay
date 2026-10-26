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
- Reply `merge` to a run-report email (or comment `merge` on the autopilot PR) to
  merge the exact commit that report names, once main's required checks pass.
  A reply can merge only source, test, and documentation changes; anything else
  (CI, `autopilot/` control files, `AGENTS.md`, infrastructure, deploy or runtime
  config, dependencies, migrations) must be reviewed and merged on GitHub.
-->

## Current goal

Ship `core-mailbox` issues one at a time. When no owner-chosen issue is in progress,
read the open issues labelled `core-mailbox` (skip `labs`, `demand-gated`, epics,
and anything already done on `main`) together with the code they touch, and ask the
owner to choose among the three best candidates that one run can finish and verify.
Implement only the chosen issue. When it is complete and verified, say so in the PR
description with `Closes #N`, then propose the next three candidates.

## Done when

- Each candidate question lists three issues, each with a short plan, the files it
  touches, how it will be verified, and a recommendation.
- Each chosen issue lands on the autopilot PR with passing checks and tests.

## Priorities and constraints

- Keep changes small and reviewable. Prefer one concern per commit.

## Off-limits

- Release, publish, and deploy workflows (`.github/workflows/deploy*.yml`,
  `publish-image.yml`) and `infra/azure/`.
- Package version bumps and changelog release entries.
- Anything under `autopilot/` except `STATE.md` and `JOURNAL.md`.
