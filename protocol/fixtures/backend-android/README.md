# Backend and Android deterministic fixture

This fixture proves the Stage 1 Mission-coordination contract without using a real
coding-agent runtime.

- `repositories/*/base` is the owner-approved starting checkout.
- `repositories/*/expected` is the scripted fixture's review-ready result.
- `repository-lock.json` records reproducible Git commit IDs for both snapshots.
- `contract-lock.json` pins the exact artifact metadata, hashes, and byte sizes for
  both contract versions.
- `contracts/v1.json` is the kickoff contract; `v2.json` is the one accepted
  revision.
- `expected-transcript.json` is the golden coordinator projection and replay plan.
- The TypeScript fixture declares the proposal revision and both exact
  acknowledgement inputs before kickoff; the runner does not synthesize approval for
  an arbitrary proposal.
- `verification/public-user-scenario.mjs` is registered in local verification policy.
- `verification/hidden-user-scenario.mjs` runs only after the Mission completes and
  is never included in a host turn.

The protocol test materializes each snapshot as a real Git repository with fixed
author, timestamps, messages, file modes, and configuration, then checks the
resulting commits against the lock file. The scripted result is evidence about
deterministic coordination and replay, not evidence that a model wrote the changes
or that relay persistence and cross-device Nodes already exist.
