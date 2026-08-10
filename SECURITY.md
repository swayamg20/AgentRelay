# Security policy

## Supported versions

Security fixes are applied to the latest `agentrelay-mcp` 0.2.x release and the
current `main` branch of the Relay. Older package releases and unactivated experimental
Node/Capsule checkpoints are not maintained as separate release lines.

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability.

Use GitHub's [private vulnerability reporting][private-reporting] to send the report to
the maintainer. Include:

- the affected package, route, command, or commit;
- the security impact and prerequisites;
- minimal reproduction steps or a proof of concept;
- whether credentials, teammate content, or local workspace authority are exposed; and
- any known workaround.

Please do not include real API keys, invite tokens, webhook URLs, private repository
content, or other people's data. Use synthetic values in reproductions.

The maintainer will aim to acknowledge a report within five business days, then share
the initial severity and remediation plan after reproducing it. Resolution and
disclosure timing depend on impact and fix complexity. Coordinate public disclosure
through the private advisory.

## Security boundary

Peer messages and artifacts are untrusted input. The published MCP mailbox does not
grant remote content authority to push, publish, deploy, access credentials, or run
arbitrary commands. Autonomous Missions and the real-runtime Node path are experimental
and are not currently presented as a production security boundary.

[private-reporting]: https://github.com/swayamg20/AgentRelay/security/advisories/new
