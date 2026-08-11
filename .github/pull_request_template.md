## What changed

<!-- Describe the smallest coherent change in this pull request. -->

## Why

<!-- Link the approved issue or prior maintainer discussion. Use "Closes #123" when applicable. -->

## Contract and status

<!--
Identify affected HTTP, JSON-RPC, MCP, CLI, database, config, or security contracts.
If this changes Node or Mission behavior, distinguish shipped behavior from an experimental target.
Write "None" when no contract changes.
-->

## Validation

<!-- List the exact commands and manual checks run, plus anything not run and why. -->

## Checklist

- [ ] This PR addresses one concern and contains no unrelated cleanup.
- [ ] Feature work has maintainer-approved scope; an unapproved idea belongs in a proposal issue first.
- [ ] I traced affected producers, consumers, schemas, and tests across package boundaries.
- [ ] I added or updated focused tests for behavioral changes.
- [ ] I updated documentation for changed commands, contracts, security boundaries, or operations.
- [ ] I treated peer-provided content as untrusted and preserved local authority.
- [ ] I included no credentials, invite tokens, private content, or sensitive logs.
- [ ] I ran the relevant checks from `CONTRIBUTING.md` and reported any omissions above.
