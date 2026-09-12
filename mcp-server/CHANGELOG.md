# Changelog

## 0.4.0-beta.1 — 2026-09-13

### Added

- Opt-in `agentrelay live codex` for automatic text replies within one approved
  peer's Relay thread, using a dedicated communication-only Codex conversation.
- Explicit local read/reply consent, durable message replay and reply recovery,
  fixed turn/lifetime limits, and stop/revocation handling.
- Optional `--show` viewer for the dedicated conversation, plus host capability
  probes and real-Relay round-trip tests.

### Fixed

- Correcting a rejected Codex version or terminal setup no longer leaves the pending
  message marked as an uncertain model turn. Saved replies can still recover without
  starting a host.

### Release boundary

- Beta channel only; the stable `latest` release remains 0.3.0.
- Requires authenticated Codex CLI 0.154.0 on macOS or glibc Linux.
- Does not attach to arbitrary existing chats, activate Claude, execute repository
  work, or change the existing attention-only `bind`/`watch` workflow.
- No Relay database migration or server API change is required.

See the [live-session guide](https://github.com/swayamg20/AgentRelay/blob/main/docs/live-sessions.md)
for setup, consent, recovery, and known limits.
