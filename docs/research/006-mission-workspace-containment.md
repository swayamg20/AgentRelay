# Mission workspace containment: Linux first

- **Date:** 2026-08-16
- **Status:** Implemented as an unactivated Node library for issue
  [#95](https://github.com/swayamg20/AgentRelay/issues/95); the dedicated Linux
  process gate passed in [CI run 31910163416](https://github.com/swayamg20/AgentRelay/actions/runs/31910163416).
- **First implementation target:** Linux.
- **Runtime under test:** Codex app-server `0.146.0`.
- **Initial retention policy:** `retain_for_review` only.

## Decision context

- **Question:** What operating-system boundary should contain the first real Mission
  runtime so it can edit one approved repository without reading or writing unrelated
  repositories, owner data, or AgentRelay credentials?
- **Goal:** Put the provider process and every descendant inside a fail-closed,
  owner-selected filesystem boundary before any model turn starts.
- **Constraints:** AgentRelay already pins Codex `0.146.0`; the Node owns local paths
  and policy; remote content is untrusted; recovery must reopen only the same local
  workspace; local paths must not enter Relay-visible evidence; the first RFC defers
  automatic worktree lifecycle and general container orchestration.
- **Decision-time gap:** Environment filtering, a private Capsule home,
  clean-checkout preflight, and output redaction did not prevent a same-user provider
  process from reading other paths. The new library constructs that filesystem
  boundary on Linux, but the current fake descriptor/CLI does not select it. See
  [research 005](005-codex-capsule-runner.md#child-environment-and-private-home).
- **Non-goals:** Cross-platform parity, automatic checkout creation or deletion,
  general-purpose containers, complete command/network mediation, push, merge,
  publish, deploy, or production credentials.
- **Success criteria:** An actual child-process test can modify the assigned checkout
  and cannot read or write sibling, home, credential, or shared-temporary canaries;
  setup failure starts no provider; recovery accepts only the durable workspace
  identity; evidence discloses no raw path.

The issue and RFC use “worktree” in the product sense of an isolated Mission working
tree. For this first boundary, that must be an owner-prepared **standalone checkout**
with its Git directory inside the approved root. It must not be a Git linked worktree.
Git documents that a linked worktree stores private administrative state under the
main repository's `$GIT_DIR/worktrees` directory and points `$GIT_COMMON_DIR` back to
the main repository. Allowing that layout would make an unrelated repository path
part of the runtime's required read surface.

## Recommendation

Support enforcement on Linux first. The implementation adds a backend-swappable Codex
process boundary owned by the Node. When supplied to the guarded client, that required
boundary launches both the Codex version probe and app-server through the exact pinned
Codex `0.146.0` `sandbox` path and its Bubblewrap backend.

The Node, not Codex and never a peer, constructs the effective policy:

- default-denied filesystem visibility;
- the validated standalone checkout as the only repository-shaped writable root;
- the private Capsule home and private temporary directory as separate writable
  roots;
- only the system and executable read roots required to start the pinned runtime;
- no owner home, sibling checkout, SSH, cloud, Relay, Node, or shared temporary
  roots; and
- an explicit locally selected network posture, without treating this filesystem
  decision as complete command/network mediation.

The Linux backend uses the pinned package's bundled Bubblewrap rather than
silently selecting an arbitrary `bwrap` from the ambient `PATH`, and must verify the
runtime version plus the selected helper identity before admitting a provider. If the
exact backend cannot be selected, user namespaces are unavailable, policy setup
fails, or a process probe contradicts the policy, startup fails before a model turn.
There is no Landlock fallback and no uncontained fallback.

macOS is unsupported for this checkpoint and must fail closed. The pinned Codex
implementation uses `/usr/bin/sandbox-exec`; the macOS 26.3 host manual marks that
dynamic interface deprecated. Its pinned `:minimal` Seatbelt defaults also grant
read/write access to host `/tmp`, `/private/tmp`, `/var/tmp`, and
`/private/var/tmp`, which violates this decision's explicit-root boundary. Apple's
supported App Sandbox requires a signed macOS app and an embedded helper that
inherits the app's sandbox, so it is not a drop-in wrapper for AgentRelay's arbitrary
CLI process today.

The library records only `retain_for_review`: it never resets or deletes the checkout,
and only the owner removes it. Future Mission lifecycle wiring must preserve that
decision across success, failure, cancellation, and crash. Automatic disposal remains
deferred so runtime failure cannot destroy reviewable changes.

## Implementation outcome

The Node now contains the first Linux implementation behind focused library
boundaries:

- `prepareMissionWorkspace` admits an owner-controlled standalone checkout at the
  configured repository, frozen commit, and allowed base ref. The root and real
  checkout-local `.git` directory are current-user-owned, not group/world writable,
  and bound by device/inode identity. Linked worktrees, Git alternates, nested mounts,
  special files, extra hard links, symlinked Git metadata, initial tracked/untracked
  changes, and ignored entries fail closed.
- `prepareCodexSandboxContainment` creates private launcher/runtime directories and a
  private permissions profile. The workspace is writable, `.git` is read-only,
  runtime home/temp are writable, owner home, Node control state, and configured
  forbidden roots are denied, and only explicit additional trees are readable.
  Network is disabled.
- The generated profile and launcher arguments both disable legacy Landlock. Exact
  system layers under `/etc/codex/` are rejected before setup and before every spawn
  so they cannot silently widen or replace the local policy.
- The launcher, bundled `codex-resources/bwrap` helper, and provider are bound to
  canonical paths, filesystem identities, approved read roots, and caller-approved
  SHA-256 digests. The canary runtime is copied into an owner-private staged tree and
  bound to its computed digest. Approved read trees are recursively checked for
  ownership, group/world-writable entries, hard links, special files, nested mounts,
  and symlink aliases into denied roots. Read, write, and deny roots are also compared
  by Linux storage provenance so disjoint bind-mount aliases cannot cross access
  boundaries; writable roots reject nested mounts. The pinned package must therefore
  be installed as an independent copy rather than hard-linked to pnpm's store; the
  Linux proof job uses `pnpm install --package-import-method=copy`.
- A mandatory actual-child canary must confirm workspace read/write, read-only Git
  metadata, private temp writes, denied control/home/shared-temp access, stripped
  ambient environment, a distinct network namespace, and no network connection. It
  publishes success through an exclusive, owner-private, token-bound result file and
  must pass before creation or recovery returns a process boundary.
- The exclusive private `containment.json` manifest records `retain_for_review` and
  binds the local workspace, executable/helper identities and hashes, config path and
  hash, approved roots, private paths, frozen base, and supplied local-policy-grant
  digest. The
  returned recovery handle is exactly `{ manifestPath, instanceId, bindingSha256 }`;
  recovery requires that handle and the same manifest/binding, permits expected dirty
  Mission edits, reruns validation and the canary, and performs no reset or deletion.
- Returned evidence is path-redacted. The manifest and recovery handle deliberately
  remain local and include the path data needed for exact recovery.

The guarded Codex client now requires an external process boundary for both its
version probe and app-server spawn, but the fake Capsule descriptor and Node CLI do
not construct this containment boundary. No Mission lifecycle durably stores the
returned recovery handle, no real model turn uses it, no production guardian owns the
provider lifecycle, and no macOS equivalent exists. The dedicated Linux process job
now proves the implemented filesystem/network canaries, dirty recovery, and pinned
Codex version/app-server handshake. That is evidence for the unactivated library
boundary, not an activated Mission runtime.

## Why this is the lowest-regret first step

- It reuses the already pinned provider's maintained Linux sandbox pipeline without
  exposing that provider choice to the rest of the Node.
- Bubblewrap supplies a mount namespace and an explicit filesystem view, which fits
  workspace/read-root containment better than path-access control alone.
- A backend-swappable Codex boundary preserves a later direct-bubblewrap, rootless-OCI, or
  packaged-macOS implementation without pretending the providers have identical
  mechanics.
- Linux support can be proven in process tests now. Shipping an unproven macOS claim
  would be worse than an explicit unsupported-platform error.
- Owner-prepared standalone checkouts satisfy the RFC's no-automatic-lifecycle limit
  and avoid linked-worktree metadata escaping the approved root.

## Research decomposition

- **Linux containment track:** Codex's pinned bubblewrap path, bubblewrap's security
  model, user-namespace requirements, and Landlock limitations.
- **macOS containment track:** the pinned Seatbelt implementation, the host's current
  `sandbox-exec` contract, App Sandbox packaging requirements, and shared-temporary
  exposure.
- **Local architecture track:** workspace preflight, Capsule/Codex process spawning,
  private-home rules, durable recovery identity, evidence, and RFC lifecycle limits.
- **Dissent track:** direct bubblewrap, Landlock, rootless OCI, and App Sandbox as
  alternatives to delegating the first backend to Codex.
- **Integration rule:** prefer primary platform documentation and the exact pinned
  source over generic sandbox claims; treat every provider claim as unproven until an
  AgentRelay-owned process test falsifies the relevant escape.

The academic paper pass was skipped. This is a current operating-system API and local
implementation decision, not an agent-planning or learning-method question; papers
would not supersede the pinned source, kernel documentation, or live platform
contract.

## Options considered

| Option | Strength | Weakness | Verdict |
| --- | --- | --- | --- |
| Pinned Codex `sandbox` with bundled bubblewrap on Linux | Incremental fit with the existing pinned runtime; mount, user, PID, and optional network namespaces; narrow policies | Provider-version coupling; system `bwrap` selection must be prevented; still needs AgentRelay-owned policy and tests | **Use first behind a backend-swappable Codex boundary** |
| Direct AgentRelay-owned bubblewrap policy | Maximum policy control and runtime independence | Bubblewrap is deliberately low-level; AgentRelay would immediately own loader, mount, Git-metadata, seccomp, and compatibility policy | Keep as the fallback if the pinned wrapper cannot meet the process tests |
| Landlock alone | Unprivileged, stackable Linux path restrictions inherited by children | It does not construct a minimal filesystem view; already-open file descriptors remain usable; ABI/filesystem coverage varies | Do not use as the first or silent fallback |
| Rootless OCI container | Strong image and mount boundary with mature tooling | Adds image lifecycle, daemon/runtime setup, auth mounting, and container operations outside this slice | Defer unless deployment constraints make it the simpler operational primitive |
| macOS `sandbox-exec`/Seatbelt | Available to the pinned Codex CLI and inherited by descendants | Dynamic interface is deprecated; pinned minimal defaults expose shared host temp; private policy grammar is a maintenance risk | Unsupported; fail closed |
| macOS App Sandbox | Supported Apple capability with signed entitlements and app container | Requires a packaged, signed app plus inheriting embedded helper; cannot wrap the current arbitrary CLI topology | Reconsider with a native Node distribution |

## Evidence

| Claim | Evidence and implication | Primary source |
| --- | --- | --- |
| Codex `0.146.0` uses Bubblewrap as its default Linux filesystem sandbox | It prefers system `bwrap`, otherwise discovers a bundled helper; applies a restricted root, layers writable and denied paths, isolates user/PID namespaces, and does not automatically fall back to Landlock when Bubblewrap fails. AgentRelay must force the packaged path and independently bind its locally approved digest because ambient-system preference is otherwise wider than an exact pin. | [Pinned Codex Linux sandbox README](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/linux-sandbox/README.md), [pinned launcher source](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/linux-sandbox/src/launcher.rs), [pinned Bubblewrap policy source](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/linux-sandbox/src/bwrap.rs), [bundled-helper discovery and optional embedded-digest verification](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/linux-sandbox/src/bundled_bwrap.rs) |
| Bubblewrap can build the required filesystem view, but is not a complete policy by itself | The pinned Codex builder starts from an empty tmpfs root in a new mount namespace and adds scoped mounts; Bubblewrap's maintainers assign the security model and arguments to the caller. AgentRelay therefore owns the policy and acceptance tests. | [Pinned Codex Bubblewrap policy source](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/linux-sandbox/src/bwrap.rs), [Bubblewrap README](https://github.com/containers/bubblewrap/blob/main/README.md) |
| Ubuntu may gate the required unprivileged user namespace through AppArmor | Ubuntu requires applications that need unprivileged user namespaces to be explicitly allowed. AgentRelay must treat this as a host prerequisite, not silently fall back. The disposable CI proof host enables it explicitly; production should use an owner-approved host policy. | [Ubuntu AppArmor security documentation](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/) |
| Landlock is useful defense in depth, not an equivalent first boundary | Landlock can restrict the calling thread and future children without privilege, but access through file descriptors opened before restriction is unaffected. It does not replace mount-view construction and explicit descriptor hygiene. | [Linux kernel Landlock documentation](https://cdn.kernel.org/doc/html/latest/userspace-api/landlock.html) |
| Codex configuration is layered rather than read from one file | System and managed layers can merge with or override user configuration. The first boundary therefore rejects the exact `/etc/codex` layer files instead of assuming a private `CODEX_HOME` is sufficient. | [Pinned config-loader overview](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/config/src/loader/README.md), [pinned loader implementation](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/config/src/loader/mod.rs), [pinned layer I/O](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/config/src/loader/layer_io.rs) |
| The pinned macOS backend depends on `sandbox-exec` | Codex hardcodes `/usr/bin/sandbox-exec`. On the research host, the macOS 26.3 `sandbox-exec(1)` manual labels the command deprecated and directs developers to App Sandbox. | [Pinned Codex Seatbelt source](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/sandboxing/src/seatbelt.rs); local `man sandbox-exec` on Darwin 25.3.0 |
| The pinned macOS `:minimal` profile is not an explicit-private-temp boundary | The profile grants read/write access to four shared host temporary trees. Replacing `TMPDIR` does not revoke those grants. | [Pinned restricted platform defaults](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/sandboxing/src/restricted_read_only_platform_defaults.sbpl) |
| App Sandbox is an application packaging model | Apple describes enabling an entitlement on a macOS app; an embedded command-line tool must be signed, embedded, and inherit the containing app's sandbox. | [Protecting user data with App Sandbox](https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox), [Embedding a command-line tool in a sandboxed app](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app) |
| Git linked worktrees are not self-contained under their visible root | A linked worktree points its Git directory and common directory into the main repository and shares refs/config. Exposing those paths would violate sibling-repository containment. | [Git worktree details](https://git-scm.com/docs/git-worktree#_details) |

## Architecture implications

### Components and ownership

The implementation adds one small Node-owned containment interface between runtime
selection and process spawn. It accepts already validated local authority and returns
a process plan plus non-sensitive evidence. It must not accept Relay text, peer paths,
or provider-authored permissions.

The first implementation has four focused responsibilities:

1. **Workspace validator:** resolves the configured alias to one canonical standalone
   checkout and proves repository URL, exact frozen commit, allowed base ref, initial
   cleanliness, owner, mode, and Git-directory containment.
2. **Containment policy builder:** turns the validated workspace, private Capsule
   home, private temp, pinned runtime, and local profile into one exact policy and
   digest.
3. **Linux Codex provider:** starts the version probe and app-server under the exact
   bubblewrap-backed `codex sandbox` boundary and rejects every unsupported or
   ambiguous backend state.
4. **Durable containment descriptor:** binds recovery to the same workspace identity,
   backend/runtime/helper identity, policy digest, and `retain_for_review` decision.

The generic Capsule runner and Mission state machine should not learn bubblewrap
arguments or Codex profile syntax.

### Workspace admission

Before first execution, admission establishes these facts with argument-array Git
calls and a minimal environment:

- the configured root is absolute, normalized, canonical, current-user-owned, and not
  a symlink alias;
- `git rev-parse --show-toplevel` resolves exactly to that root;
- both the Git directory and common Git directory are directories beneath that root;
  a top-level `.git` indirection file, linked worktree, external object store, or
  alternate Git directory is rejected;
- the canonical remote URL and `HEAD` equal the locally configured repository and
  frozen Mission base commit, and the commit is reachable from an allowed base ref;
- the initial index and working tree are clean; and
- case-folding, Unicode normalization, traversal, and symlink resolution cannot map
  an allowed spelling to a different object.

The existing preflight already proves part of this contract. The containment change
should extend that direct path rather than introduce a second competing repository
validator.

### Process and filesystem boundary

The containment wrapper must be the parent of the provider process so restrictions
are inherited by all provider commands. Spawn only the intentional stdio pipes; close
all other file descriptors. Provide an allowlisted environment, a private `HOME` and
`CODEX_HOME`, and a private `TMPDIR` beneath the Capsule. Protect Git metadata from
writes while allowing working-tree edits.

Do not infer success from a profile name or a successful spawn. A mandatory local
probe must perform an allowed workspace operation and forbidden canary operations
inside the same effective boundary. Any unexpected success is a hard setup failure.

### Recovery and retention

Containment creation persists the private manifest before returning the process
boundary that can start the provider. It includes a schema version, backend and
runtime versions, executable/helper digests, repository URL, frozen commit,
canonical-root and filesystem object identities, supplied local-policy-grant digest,
and retention policy. Future Mission lifecycle wiring must also persist the exact
recovery handle before starting the provider.

On recovery, re-resolve and compare every identity field before opening the provider.
The working tree may now be dirty because Mission edits are expected; recovery must
not replace the initial clean-state rule with a destructive reset. A moved, replaced,
relinked, newly symlinked, or differently based workspace fails closed and remains
retained for owner inspection.

`retain_for_review` means AgentRelay performs no recursive deletion and no Git
cleanup. Later disposal support requires a separate, exact-target, recovery-aware
design and is not implied by this descriptor.

### Evidence and external contract

The private manifest records canonical paths for exact local recovery. The returned
evidence exposes only the containment instance, backend/runtime version, base commit,
binding digest, and retention decision. It contains no raw path, environment value,
canary content, provider diagnostic, or credential location. Probe outcome and
rejection reason codes are not yet represented in that evidence, and no current
Relay-visible route carries it.

This decision changes no public HTTP, JSON-RPC, MCP, or Mission schema by itself.

## Implementation status

1. [x] Extend workspace preflight with standalone-checkout, storage-alias, ownership,
   object-identity, initial-cleanliness, and dirty-recovery checks.
2. [x] Add the Codex containment request, manifest, redacted evidence,
   recovery-handle, and process-boundary types without changing the Capsule wire.
3. [x] Implement the Linux Codex `0.146.0` Bubblewrap policy, exact bundled-helper
   selection, private home/temp, ambient-config rejection, disabled legacy Landlock,
   recursive read-tree inspection, and mandatory capability canary.
4. [x] Require an external process boundary for both the configured executable version
   probe and app-server start.
5. [x] Persist the exclusive private manifest before returning a new boundary and
   compare the exact handle, binding, and current identities during recovery.
6. [x] Return path-redacted local evidence and expose no new Relay, JSON-RPC, MCP, or
   Mission field.
7. [x] Keep macOS and every unimplemented platform on an explicit unsupported error.
8. [x] Pass the dedicated Linux process job, including the policy canaries, dirty
   recovery, and pinned app-server handshake, as library-boundary evidence.
9. [ ] Wire the boundary into a locally selected descriptor and Mission lifecycle,
   durably store its exact recovery handle, and execute one guardian-owned real turn.

The smallest falsifying experiment is the dedicated Linux process test. It launches a
trivial descendant and a pinned app-server handshake through the boundary. Any
read/write escape, helper-selection ambiguity, or setup failure blocks activation. At
this snapshot the job is green. A direct AgentRelay-owned Bubblewrap backend remains
the fallback if a future pinned wrapper can no longer satisfy the gate.

## Evaluation plan

### Process-level golden cases

- Create, read, modify, and delete a file inside the admitted working tree.
- Read required source and runtime files; write the private Capsule home and private
  temp directory.
- Deny read and write for an unapproved sibling repository, owner home, `.ssh`, cloud
  credential directories, Relay/Node secret canaries, and shared host temp canaries.
- Deny escapes through `..`, absolute paths, symlinks inside the workspace, symlinked
  roots, alternate case/normalization spellings, Git linked worktrees, alternate Git
  directories, and replacement of the admitted root after validation.
- Prove the same denials in a child and grandchild process.
- Prove that no inherited non-stdio descriptor can read a pre-opened forbidden file.
- Force missing user namespaces, missing/mismatched helper, malformed policy,
  unsupported platform, and failed canary probe; assert that no provider sentinel or
  model turn starts.
- Crash after edits, recover against the same descriptor, retain the dirty checkout,
  and reject a moved, replaced, or differently based checkout.
- Assert public evidence contains no raw path or canary value.

### Gates and metrics

- **Security threshold:** zero successful forbidden reads or writes and zero silent
  fallback paths.
- **Recovery threshold:** only the exact durable workspace reopens; no reset, cleanup,
  or second workspace is selected.
- **Compatibility threshold:** pinned Codex handshake and existing database-free Node
  suite remain green on the supported Linux CI host.
- **Observability:** current evidence records the instance, backend/runtime, base,
  binding digest, and retention decision without paths. Probe outcome and rejection
  reason codes remain follow-up work.
- **Human review:** inspect the retained checkout after success, cancellation,
  containment denial, and crash recovery.

A real model turn is a later activation gate. Containment tests should not spend model
tokens or depend on model behavior.

Focused tests cover workspace identity/storage failures, manifest exclusivity and
exact recovery, private configuration, required-boundary failure before version or
app-server spawn, and path-redacted evidence. The Linux process test contains the
workspace/read/deny/network/dirty-recovery and pinned app-server cases, and the job is
green. The inherited non-stdio descriptor canary and the full forced-failure matrix
above are still missing.

## Risk register

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Ambient `PATH` causes pinned Codex to prefer an unpinned system `bwrap` | High | Bind the exact packaged helper path and caller-approved digest, give the launcher a non-searchable outer `PATH`, and require the Linux process gate; use direct Bubblewrap if the wrapper still cannot satisfy it |
| Linux disables unprivileged user namespaces | High | Capability probe at startup; fail before provider creation; document the host prerequisite |
| A Codex update changes permission-profile or helper behavior | High | Exact version and digest pin, process regression suite, explicit reviewed upgrade |
| Policy merge or owner config expands roots | High | Generate policy in a private exact-mode launcher home, reject the exact ambient `/etc/codex` layers, and compare the durable config/binding digests before every spawn |
| Symlink or path-replacement race changes an admitted root | High | Canonical and object-identity checks before spawn and recovery; reject indirection; process tests; fail on mismatch |
| A pre-opened descriptor bypasses path containment | High | Close all non-stdio descriptors and include descriptor-leak tests; do not rely on Landlock to revoke existing descriptors |
| Linked Git metadata exposes or mutates the main repository | High | Require both Git and common directories beneath the admitted standalone checkout; keep Git metadata read-only in the runtime |
| Provider network becomes an exfiltration path | High | Expose no secrets or unrelated files; keep network posture explicit; complete separate command/network mediation before autonomous write claims |
| Retained workspaces consume disk or preserve sensitive generated data | Medium | Surface local retained-state evidence and owner cleanup instructions; add bounded disposal only in a later explicit lifecycle design |
| Linux-only support slows a macOS-first pilot | Medium | Keep the process boundary backend-swappable; run the safe pilot on Linux; reconsider a packaged App Sandbox Node rather than weakening the boundary |

## When this recommendation would be wrong

- The first production pilot must run on macOS and the team is ready to ship a signed
  native Node app with an inheriting helper. App Sandbox should then be evaluated
  before Linux-first activation.
- The pinned Codex wrapper cannot force or attest its bundled helper, cannot express a
  truly explicit Linux read set, or fails any process canary. A direct
  AgentRelay-owned bubblewrap policy becomes the smaller trustworthy boundary.
- Target Linux hosts consistently disable user namespaces. A pre-provisioned rootless
  OCI or stronger service-manager boundary may be operationally simpler than changing
  host kernel policy.
- Multiple runtime providers must ship immediately. Owning bubblewrap directly may
  reduce provider coupling enough to justify its larger policy surface.

## Resolved implementation choices

- The launcher binds the exact packaged `codex-resources/bwrap` path and the
  caller-approved helper SHA-256, uses a non-searchable outer `PATH`, and gives
  sandboxed children a separate explicit tool path.
- Durable path identity uses device and inode for the workspace, Git directory,
  executable/read roots, and private directories, with canonical-path, owner, mode,
  type, and digest checks where applicable before recovery and spawn.
- Linux mount metadata binds approved roots to underlying storage provenance, rejects
  access-boundary aliases, and rejects nested mounts under writable roots.
- [CI run 31910163416](https://github.com/swayamg20/AgentRelay/actions/runs/31910163416)
  passed the filesystem/network policy proof and pinned Codex version/app-server
  handshake on the supported Ubuntu host.

## Open questions

- How will provider authentication reach the private Codex home without copying any
  Relay or Node credential and without widening readable roots?
- What provider-service network access is necessary for the outer app-server, and
  which separate issue owns endpoint mediation for its descendants?
- What owner-facing command will eventually dispose a retained checkout safely, and
  what durable state must prove it is no longer recoverable first?
- Which follow-up owns inherited non-stdio descriptor proof, the remaining forced-
  failure matrix, and path-redacted probe/rejection evidence?

## Reading trail

1. [Pinned Codex Linux sandbox README](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/linux-sandbox/README.md)
   — exact backend selection and mount/namespace behavior this decision depends on.
2. [Pinned Codex Bubblewrap policy source](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/linux-sandbox/src/bwrap.rs)
   — the exact restricted root and scoped mounts used by the pinned wrapper.
3. [Bubblewrap README](https://github.com/containers/bubblewrap/blob/main/README.md)
   — primitive capabilities and the caller's responsibility for the security model.
4. [Ubuntu AppArmor security documentation](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/)
   — why the required unprivileged user namespace is an explicit host prerequisite.
5. [Pinned Codex config-loader overview](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/config/src/loader/README.md)
   and [implementation](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/config/src/loader/mod.rs)
   — why a private `CODEX_HOME` does not by itself remove system and managed layers.
6. [Linux kernel Landlock documentation](https://cdn.kernel.org/doc/html/latest/userspace-api/landlock.html)
   — descendant enforcement, ABI behavior, and open-file-descriptor limitation.
7. [Pinned Codex macOS restricted defaults](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/sandboxing/src/restricted_read_only_platform_defaults.sbpl)
   — concrete shared-temp grants that block a macOS claim in this checkpoint.
8. [Apple App Sandbox guidance](https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox)
   and [embedded helper guidance](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app)
   — the supported macOS packaging model.
9. [Git worktree details](https://git-scm.com/docs/git-worktree#_details)
   — why linked worktrees cannot fit inside one approved standalone root.
10. [RFC 001](../rfcs/001-agentrelay-node-and-missions.md) and
   [research 005](005-codex-capsule-runner.md) — AgentRelay's lifecycle limit and the
   exact current containment gap.
