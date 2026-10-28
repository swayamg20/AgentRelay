# Nightshift goals

status: running

<!--
Owner-controlled. Edit this file on the default branch (the GitHub web editor or
mobile app is fine). Every run reads the latest version from the default branch
before it starts; the agent cannot change the copy it reads.

- `status: running` lets runs work. `status: paused` makes them exit immediately.
  Keep the line exactly in the form `status: <value>`.
- Changing the goal takes effect on the next run. The agent rewrites its plan in
  `.nightshift/STATE.md` when the goal changes.
- Close the Nightshift draft PR without merging to discard its work. The next run
  starts fresh from the default branch.
- Runs start on the schedule in `.github/workflows/nightshift.yml` (skipped while a
  question waits on the owner, unless the PR has review findings or failing
  checks), and immediately when the owner replies on an open `nightshift:needs-you`
  issue.
- Reply `merge` to a run-report email (or comment `merge` on the Nightshift PR) to
  merge the exact commit that report names, once the default branch's required
  checks pass. A reply can merge only paths that `merge.allow` in
  `.nightshift/config.yml` permits and `merge.deny` does not; anything else must be
  reviewed and merged on GitHub.
- Reactions on your comment show progress: a thumbs-up when a reply or `merge` is
  picked up, then a rocket when the merge lands or a confused face when it does not
  (a reply explains why).

The goal below is a starting point. Replace it with your own before setting
`status: running`.
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
- Each chosen issue lands on the Nightshift PR with passing checks and tests.

## Priorities and constraints

- Keep changes small and reviewable. Prefer one concern per commit.

## Off-limits

- Release, publish, and deploy workflows (`.github/workflows/deploy*.yml`,
  `publish-image.yml`) and `infra/azure/`.
- Package version bumps and changelog release entries.
- Anything under `.nightshift/` except `STATE.md` and `JOURNAL.md`.
