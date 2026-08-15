# Mission workspace containment: Linux first

- **Date:** 2026-08-16
- **Status:** Decision for issue
  [#95](https://github.com/swayamg20/AgentRelay/issues/95); implementation and
  process evidence still required.
- **First supported platform:** Linux.
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
- **Current gap:** Environment filtering, a private Capsule home, clean-checkout
  preflight, and output redaction exist, but none prevents a same-user provider
  process from reading other paths. See
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

Support enforcement on Linux first. Add a provider-neutral containment boundary owned
by the Node, with a Linux implementation that launches both the Codex version probe
and app-server through the exact pinned Codex `0.146.0` `sandbox` path and its
bubblewrap backend.

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

The Linux backend must use the pinned package's bundled bubblewrap rather than
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

The initial lifecycle supports only `retain_for_review`. The owner creates the
checkout, AgentRelay validates and retains it after success, failure, cancellation,
or crash, and only the owner removes it. Unknown retention values are rejected.
Automatic disposal remains deferred so runtime failure cannot destroy reviewable
changes.

## Why this is the lowest-regret first step

- It reuses the already pinned provider's maintained Linux sandbox pipeline without
  exposing that provider choice to the rest of the Node.
- Bubblewrap supplies a mount namespace and an explicit filesystem view, which fits
  workspace/read-root containment better than path-access control alone.
- A provider-neutral boundary preserves a later direct-bubblewrap, rootless-OCI, or
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
| Pinned Codex `sandbox` with bundled bubblewrap on Linux | Incremental fit with the existing pinned runtime; mount, user, PID, and optional network namespaces; narrow policies | Provider-version coupling; system `bwrap` selection must be prevented; still needs AgentRelay-owned policy and tests | **Use first behind a provider-neutral boundary** |
| Direct AgentRelay-owned bubblewrap policy | Maximum policy control and runtime independence | Bubblewrap is deliberately low-level; AgentRelay would immediately own loader, mount, Git-metadata, seccomp, and compatibility policy | Keep as the fallback if the pinned wrapper cannot meet the process tests |
| Landlock alone | Unprivileged, stackable Linux path restrictions inherited by children | It does not construct a minimal filesystem view; already-open file descriptors remain usable; ABI/filesystem coverage varies | Do not use as the first or silent fallback |
| Rootless OCI container | Strong image and mount boundary with mature tooling | Adds image lifecycle, daemon/runtime setup, auth mounting, and container operations outside this slice | Defer unless deployment constraints make it the simpler operational primitive |
| macOS `sandbox-exec`/Seatbelt | Available to the pinned Codex CLI and inherited by descendants | Dynamic interface is deprecated; pinned minimal defaults expose shared host temp; private policy grammar is a maintenance risk | Unsupported; fail closed |
| macOS App Sandbox | Supported Apple capability with signed entitlements and app container | Requires a packaged, signed app plus inheriting embedded helper; cannot wrap the current arbitrary CLI topology | Reconsider with a native Node distribution |

## Evidence

| Claim | Evidence and implication | Primary source |
| --- | --- | --- |
| Codex `0.146.0` uses bubblewrap as its default Linux filesystem sandbox | It prefers system `bwrap`, otherwise uses a bundled helper; applies a read-only base, layers writable and denied paths, isolates user/PID namespaces, and does not automatically fall back to Landlock when bubblewrap fails. AgentRelay must force or attest the bundled path because ambient-system preference is otherwise wider than an exact pin. | [Pinned Codex Linux sandbox README](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/linux-sandbox/README.md), [pinned launcher source](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/linux-sandbox/src/launcher.rs), [bundled-helper verification](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/linux-sandbox/src/bundled_bwrap.rs) |
| Bubblewrap can build the required filesystem view, but is not a complete policy by itself | It starts with an empty tmpfs root in a new mount namespace and exposes only caller-selected mounts. Its maintainers explicitly assign the security model and arguments to the caller. AgentRelay therefore owns the policy and the acceptance tests. | [bubblewrap README](https://github.com/containers/bubblewrap/blob/main/README.md) |
| Landlock is useful defense in depth, not an equivalent first boundary | Landlock can restrict the calling thread and future children without privilege, but access through file descriptors opened before restriction is unaffected. It does not replace mount-view construction and explicit descriptor hygiene. | [Linux kernel Landlock documentation](https://cdn.kernel.org/doc/html/latest/userspace-api/landlock.html) |
| The pinned macOS backend depends on `sandbox-exec` | Codex hardcodes `/usr/bin/sandbox-exec`. On the research host, the macOS 26.3 `sandbox-exec(1)` manual labels the command deprecated and directs developers to App Sandbox. | [Pinned Codex Seatbelt source](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/sandboxing/src/seatbelt.rs); local `man sandbox-exec` on Darwin 25.3.0 |
| The pinned macOS `:minimal` profile is not an explicit-private-temp boundary | The profile grants read/write access to four shared host temporary trees. Replacing `TMPDIR` does not revoke those grants. | [Pinned restricted platform defaults](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/sandboxing/src/restricted_read_only_platform_defaults.sbpl) |
| App Sandbox is an application packaging model | Apple describes enabling an entitlement on a macOS app; an embedded command-line tool must be signed, embedded, and inherit the containing app's sandbox. | [Protecting user data with App Sandbox](https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox), [Embedding a command-line tool in a sandboxed app](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app) |
| Git linked worktrees are not self-contained under their visible root | A linked worktree points its Git directory and common directory into the main repository and shares refs/config. Exposing those paths would violate sibling-repository containment. | [Git worktree details](https://git-scm.com/docs/git-worktree#_details) |

## Architecture implications

### Components and ownership

Add one small Node-owned containment interface between runtime selection and process
spawn. It accepts already validated local authority and returns a spawn plan plus
non-sensitive evidence. It must not accept Relay text, peer paths, or provider-authored
permissions.

The first implementation has four focused responsibilities:

1. **Workspace validator:** resolves the configured alias to one canonical standalone
   checkout and proves repository URL, exact frozen commit, allowed base ref, initial
   cleanliness, owner, mode, and Git-directory containment.
2. **Containment policy builder:** turns the validated workspace, private Capsule
   home, private temp, pinned runtime, and local profile into one immutable policy and
   digest.
3. **Linux Codex provider:** starts the version probe and app-server under the exact
   bubblewrap-backed `codex sandbox` boundary and rejects every unsupported or
   ambiguous backend state.
4. **Durable containment descriptor:** binds recovery to the same workspace identity,
   backend/runtime/helper identity, policy digest, and `retain_for_review` decision.

The generic Capsule runner and Mission state machine should not learn bubblewrap
arguments or Codex profile syntax.

### Workspace admission

Before first execution, admission must establish all of these facts with argument-array
Git calls and a minimal environment:

- the configured root is absolute, normalized, canonical, current-user-owned, and not
  a symlink alias;
- `git rev-parse --show-toplevel` resolves exactly to that root;
- both the Git directory and common Git directory are directories beneath that root;
  a top-level `.git` indirection file, linked worktree, external object store,
  submodule, or alternate Git directory is rejected;
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

Persist the containment descriptor before provider start. It should include a schema
version, backend and runtime versions, executable/helper digests, repository URL,
frozen commit, canonical-root identity retained only locally, filesystem object
identity where supported, policy digest, and retention policy.

On recovery, re-resolve and compare every identity field before opening the provider.
The working tree may now be dirty because Mission edits are expected; recovery must
not replace the initial clean-state rule with a destructive reset. A moved, replaced,
relinked, newly symlinked, or differently based workspace fails closed and remains
retained for owner inspection.

`retain_for_review` means AgentRelay performs no recursive deletion and no Git
cleanup. Later disposal support requires a separate, exact-target, recovery-aware
design and is not implied by this descriptor.

### Evidence and external contract

Local evidence may record the canonical root for owner diagnostics. Relay-visible or
peer-visible evidence may contain only the logical workspace alias, repository/base
identity already present in the Mission, backend/runtime versions, a policy digest,
the retention decision, and pass/fail reason codes. It must not contain raw paths,
environment values, canary contents, provider diagnostics, or credential locations.

This decision changes no public HTTP, JSON-RPC, MCP, or Mission schema by itself.

## Implementation plan

1. Extend the existing workspace preflight to require a self-contained standalone
   checkout and return the local identity needed by containment and recovery.
2. Add the provider-neutral containment request, descriptor, evidence, and spawn-plan
   types without importing Codex-specific types into the generic Capsule runtime.
3. Implement the Linux Codex `0.146.0` backend, generated private permissions
   profile, exact bundled-helper selection, private temp, and fail-closed capability
   probe.
4. Route both the configured executable version probe and app-server start through
   that backend; make uncontained production construction impossible.
5. Persist the descriptor before provider start and compare it during fresh-generation
   recovery.
6. Emit redacted local evidence and expose no new raw-path field on Relay-visible
   surfaces.
7. Keep macOS and every unimplemented platform on one explicit unsupported error.

The smallest falsifying experiment is a Linux process test that launches a trivial
descendant through the proposed boundary. If it can read one sibling, home, shared
temp, credential, or symlink-target canary, or if the exact bundled helper cannot be
selected independently from the child's tool `PATH`, stop and use a direct
AgentRelay-owned bubblewrap backend instead.

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
- **Observability:** record backend/runtime/helper versions, policy digest, probe
  outcome, rejection reason code, and retention decision locally.
- **Human review:** inspect the retained checkout after success, cancellation,
  containment denial, and crash recovery.

A real model turn is a later activation gate. Containment tests should not spend model
tokens or depend on model behavior.

## Risk register

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Ambient `PATH` causes pinned Codex to prefer an unpinned system `bwrap` | High | Force and attest the bundled helper; if the wrapper cannot do this while preserving an explicit child tool path, use direct bubblewrap |
| Linux disables unprivileged user namespaces | High | Capability probe at startup; fail before provider creation; document the host prerequisite |
| A Codex update changes permission-profile or helper behavior | High | Exact version and digest pin, process regression suite, explicit reviewed upgrade |
| Policy merge or owner config expands roots | High | Generate policy in a private exact-mode Capsule home; do not load ambient/managed profiles; compare the durable policy digest |
| Symlink or path-replacement race changes an admitted root | High | Canonical and object-identity checks before spawn and recovery; reject indirection; process tests; fail on mismatch |
| A pre-opened descriptor bypasses path containment | High | Close all non-stdio descriptors and include descriptor-leak tests; do not rely on Landlock to revoke existing descriptors |
| Linked Git metadata exposes or mutates the main repository | High | Require both Git and common directories beneath the admitted standalone checkout; keep Git metadata read-only in the runtime |
| Provider network becomes an exfiltration path | High | Expose no secrets or unrelated files; keep network posture explicit; complete separate command/network mediation before autonomous write claims |
| Retained workspaces consume disk or preserve sensitive generated data | Medium | Surface local retained-state evidence and owner cleanup instructions; add bounded disposal only in a later explicit lifecycle design |
| Linux-only support slows a macOS-first pilot | Medium | Keep the interface provider-neutral; run the safe pilot on Linux; reconsider a packaged App Sandbox Node rather than weakening the boundary |

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

## Open questions

- Can the packaged `0.146.0` CLI force its bundled, digest-verified helper while the
  sandboxed app-server receives a separate explicit tool `PATH`? This is the first
  implementation falsifier.
- What is the smallest Linux system/executable read set that passes the app-server
  handshake without making `/`, `/home`, or shared temp broadly readable?
- Which local filesystem identity fields are stable across supported Linux filesystems
  and sufficient to detect root replacement during recovery?
- How will provider authentication reach the private Codex home without copying any
  Relay or Node credential and without widening readable roots?
- What provider-service network access is necessary for the outer app-server, and
  which separate issue owns endpoint mediation for its descendants?
- What owner-facing command will eventually dispose a retained checkout safely, and
  what durable state must prove it is no longer recoverable first?

## Reading trail

1. [Pinned Codex Linux sandbox README](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/linux-sandbox/README.md)
   — exact backend selection and mount/namespace behavior this decision depends on.
2. [bubblewrap README](https://github.com/containers/bubblewrap/blob/main/README.md)
   — primitive capabilities and the caller's responsibility for the security model.
3. [Linux kernel Landlock documentation](https://cdn.kernel.org/doc/html/latest/userspace-api/landlock.html)
   — descendant enforcement, ABI behavior, and open-file-descriptor limitation.
4. [Pinned Codex macOS restricted defaults](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/sandboxing/src/restricted_read_only_platform_defaults.sbpl)
   — concrete shared-temp grants that block a macOS claim in this checkpoint.
5. [Apple App Sandbox guidance](https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox)
   and [embedded helper guidance](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app)
   — the supported macOS packaging model.
6. [Git worktree details](https://git-scm.com/docs/git-worktree#_details)
   — why linked worktrees cannot fit inside one approved standalone root.
7. [RFC 001](../rfcs/001-agentrelay-node-and-missions.md) and
   [research 005](005-codex-capsule-runner.md) — AgentRelay's lifecycle limit and the
   exact current containment gap.
