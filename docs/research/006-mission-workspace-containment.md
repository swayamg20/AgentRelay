# Mission workspace containment: implemented Linux library

- **Date:** 2026-08-16
- **Status:** Implemented and tested as an unactivated Node library.
- **Runtime tested:** Codex app-server `0.146.0`.
- **Supported boundary:** Linux with Bubblewrap and unprivileged user namespaces.
- **Retention behavior:** `retain_for_review`; AgentRelay performs no reset or
  recursive deletion.

The dedicated Linux process proof passed in
[CI run 31910163416](https://github.com/swayamg20/AgentRelay/actions/runs/31910163416).
This record describes that implemented library and its current integration boundary.
It is not an activation plan.

## Outcome

The Node package contains a fail-closed, Node-owned process boundary for the pinned
Codex version probe and app-server. The owner, not a remote peer or the provider,
selects the workspace and policy.

The library constructs:

- a default-denied filesystem view;
- one validated standalone checkout as the repository-shaped writable root;
- private Capsule home and temporary directories;
- explicit read-only system and executable roots;
- denied owner-home, sibling-repository, SSH, cloud-credential, Relay, Node, and
  shared-temporary roots;
- a disabled network namespace; and
- an exact recovery identity stored in an owner-private manifest.

If the pinned helper cannot be selected, user namespaces are unavailable, policy
setup fails, or the process canary contradicts the policy, creation fails. There is no
Landlock or uncontained fallback.

## Workspace admission

`prepareMissionWorkspace` accepts only an owner-controlled standalone checkout at
the configured repository, frozen commit, and allowed base ref.

Admission checks:

- the root and checkout-local `.git` directory are canonical, current-user-owned,
  and not group/world writable;
- the Git directory and common directory remain beneath the approved root;
- repository URL, frozen commit, and allowed base ref match local configuration;
- the initial index and working tree are clean;
- linked worktrees, Git alternates, symlinked metadata, nested mounts, special files,
  extra hard links, ignored entries, and storage aliases across access boundaries are
  rejected; and
- path traversal, case folding, Unicode normalization, and symlink resolution cannot
  map an approved spelling to another filesystem object.

A Git linked worktree is rejected because its administrative and common directories
normally point into another checkout, widening the provider's required read surface.

## Process boundary

`prepareCodexSandboxContainment` creates private launcher and runtime directories,
a private permissions profile, and an exact process plan.

The implementation:

- selects the pinned package's bundled `codex-resources/bwrap` helper instead of an
  ambient system `bwrap`;
- binds launcher, helper, provider, canary, configuration, and approved roots to
  canonical filesystem identities and caller-approved SHA-256 digests;
- rejects the exact ambient `/etc/codex` configuration layers;
- provides allowlisted environment variables plus private `HOME`, `CODEX_HOME`,
  and `TMPDIR`;
- makes the working tree writable and Git metadata read-only;
- recursively rejects unsafe ownership, modes, hard links, special files, nested
  mounts, and symlink aliases in approved trees; and
- disables legacy Landlock so a weaker fallback cannot be mistaken for the selected
  boundary.

The pinned runtime has to be an independent package copy rather than a hard-linked
pnpm-store tree. The Linux proof job therefore installs with
`pnpm install --package-import-method=copy`.

## Runtime canary

Creation and recovery run an actual child process inside the effective boundary. The
canary verifies:

- approved workspace read and write;
- read-only Git metadata;
- private temporary-directory writes;
- denied Node control state, owner home, and shared temporary paths;
- stripped ambient environment;
- a distinct network namespace; and
- failed outbound network access.

The canary publishes through an exclusive, owner-private, token-bound result file.
Unexpected access or a missing result fails the boundary before it is returned.

## Recovery and retention

The exclusive private `containment.json` manifest binds:

- schema and containment instance;
- backend, runtime, launcher, and helper identity;
- repository URL, frozen commit, and filesystem object identity;
- configuration and local-policy-grant digests;
- approved read, write, and deny roots;
- private runtime paths; and
- the `retain_for_review` decision.

The recovery handle is exactly `{ manifestPath, instanceId, bindingSha256 }`.
Recovery requires that handle, rechecks every durable identity, reruns the process
canary, allows expected dirty Mission edits, and performs no reset or deletion. A
moved, replaced, relinked, newly symlinked, or differently based checkout fails closed
and remains available for owner inspection.

## Evidence boundary

Relay-visible evidence contains only the containment instance, backend/runtime
version, base commit, binding digest, and retention decision. It excludes raw paths,
environment values, canary content, provider diagnostics, and credential locations.

The private manifest and recovery handle remain local because exact recovery requires
their path-bearing data. No public HTTP, JSON-RPC, MCP, or Mission schema is changed by
this library.

## Verified evidence

Focused tests cover:

- workspace identity, ownership, storage provenance, and cleanliness failures;
- private manifest creation, exact recovery, and dirty-checkout retention;
- helper, runtime, configuration, root, and policy digest binding;
- required-boundary failure before version probe or app-server spawn;
- filesystem, environment, and network canaries in a real descendant;
- path-redacted evidence; and
- the pinned Codex version and app-server handshake through the guardian and
  containment boundaries.

## Current integration state

The public Capsule descriptor and Node CLI do not construct this containment boundary.
No Mission lifecycle stores its recovery handle, and no real model turn uses it. The
provider guardian is also an unactivated library boundary. macOS and every other
platform fail closed as unsupported.

The inherited non-stdio descriptor canary, a complete forced-failure matrix,
provider-service endpoint mediation, durable probe/rejection evidence, and an
owner-facing recovery-aware disposal command are absent.

## Security findings and sources

| Finding | Current implication | Primary source |
| --- | --- | --- |
| Codex `0.146.0` uses Bubblewrap for its Linux filesystem sandbox and may otherwise select ambient `bwrap` | AgentRelay selects and verifies the packaged helper instead of trusting ambient `PATH` | [Codex Linux sandbox README](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/linux-sandbox/README.md), [launcher source](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/linux-sandbox/src/launcher.rs), [Bubblewrap policy](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/linux-sandbox/src/bwrap.rs) |
| Bubblewrap constructs a mount view but leaves policy to its caller | AgentRelay owns the roots, arguments, canary, and failure behavior | [Bubblewrap README](https://github.com/containers/bubblewrap/blob/main/README.md) |
| Ubuntu can gate unprivileged user namespaces through AppArmor | Missing namespace authority is a hard unsupported-host result | [Ubuntu AppArmor security documentation](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/) |
| Landlock cannot revoke access through already-open file descriptors | Landlock is disabled as a silent substitute for the selected boundary | [Linux Landlock documentation](https://cdn.kernel.org/doc/html/latest/userspace-api/landlock.html) |
| Codex configuration loads in layers | Exact ambient system configuration paths are rejected; private `CODEX_HOME` alone is insufficient | [Codex config loader](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/config/src/loader/README.md) |
| The pinned macOS profile grants shared temporary paths and depends on deprecated `sandbox-exec` | This library makes no macOS containment claim | [Codex Seatbelt source](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/sandboxing/src/seatbelt.rs), [restricted defaults](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/sandboxing/src/restricted_read_only_platform_defaults.sbpl) |
| Git linked worktrees place administrative state outside the visible working root | Admission requires a self-contained standalone checkout | [Git worktree details](https://git-scm.com/docs/git-worktree#_details) |

## Current risk summary

| Risk | Current treatment |
| --- | --- |
| Ambient helper or configuration widens authority | Exact paths, identities, digests, and ambient-layer rejection |
| Host cannot provide the selected namespace boundary | Fail before provider creation |
| Approved tree changes identity after validation | Recheck before creation and recovery; fail on mismatch |
| Pre-opened descriptors bypass path containment | No production activation claim; complete descriptor proof is absent |
| Provider network becomes an exfiltration path | Network is disabled in the tested boundary; provider-service endpoint mediation is absent |
| Retained workspaces preserve generated data | `retain_for_review` is explicit and deletion is owner-controlled |
| Unsupported platforms provide weaker isolation | Explicit unsupported error; no fallback |
