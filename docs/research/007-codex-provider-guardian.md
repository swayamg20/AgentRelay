# Codex provider guardian and teardown-witness ownership

- **Date:** 2026-08-17
- **Status:** Implemented and tested as an unactivated Node library boundary.
- **Runtime under test:** Codex app-server `0.146.0`, read-only policy.
- **Scope:** Provider-generation ownership, liveness, deadline and revocation teardown,
  detached witness survival, durable quiescence evidence, and process-group cleanup.

## Outcome

`SupervisedCodexProviderGuardian` replaces the runner's injected quiescence assertion
with one fail-closed generation boundary for provider spawn and termination. The runner
receives a generation, not a free-standing client, and cannot construct a second
client while that generation is active.

This is still an unactivated composition. The current Capsule descriptor and Node CLI
select deterministic fake runtimes. No Mission lifecycle supplies verified authority,
stores the Linux containment recovery handle, or executes a real model turn through
this guardian.

## Process boundary

```text
Node -> detached Mission Capsule (holds provider lock)
                   |
                   `-> detached Codex guardian process group
                         |-- guardian -> provider process tree
                         `-- spawns detached teardown witness outside the group
                                      `-- holds the same lock + private state access
```

The Capsule acquires a stable, private kernel lock and duplicates that descriptor into
the trusted guardian. Before any durable start barrier or provider spawn, the guardian
prearms an independent teardown witness outside its process group and passes it the
same descriptor. The raw provider never receives the lock. This three-part ownership
keeps a cleanup owner alive across the required failures:

- Capsule death leaves the guardian and witness holding the lock; owner-channel loss
  starts teardown.
- Guardian death leaves the Capsule and witness holding the lock; both independently
  drive or verify process-group removal.
- Capsule and guardian death together leaves the witness outside their process group,
  still holding the lock and able to finish teardown.
- Provider death is observed by the guardian, which asks the witness to clean any
  remaining descendants.

The lock file and inode remain in place. Ownership is the live kernel lock, not its
diagnostic PID metadata.

## Generation invariant

One generation follows this order:

1. The Capsule acquires `provider.lock` and prepares the contained version and
   app-server commands.
2. The detached guardian inherits and validates the exact lock descriptor, owner PID,
   IPC channel, Capsule identity, and private state directory.
3. The guardian starts the detached witness outside its own process group. The witness
   validates the lock, opens the private generation store, arms the absolute deadline
   and heartbeat watchdog, and acknowledges readiness.
4. Only after that acknowledgement does the guardian durably write
   `spawn_maybe_started` with a random generation ID, kernel boot-session ID, and
   absolute deadline.
5. The guardian arms its matching watchdogs, verifies Codex `0.146.0`, spawns the
   provider, and records `running` before publishing `ready`.
6. The witness latches its first stop cause and sends `SIGTERM` to the complete
   guardian/provider process group, waits the bounded grace, escalates to group
   `SIGKILL`, and polls until the group is absent.
7. Within the same boot, only the surviving witness may authoritatively record
   matching `quiescent` state; it does so after absence proof, then closes its
   inherited lock. The Capsule independently proves group absence, waits for that
   durable state, releases its own lock, and settles generation termination.

Prearming the witness before writing the start barrier closes both the old pre-spawn
crash window and the joint Capsule/guardian-death window. Owner death during command
preparation or witness startup leaves no barrier and cannot admit the provider. Owner
death after the barrier is handled by the guardian or witness under the same bounded
generation identity.

A same-boot non-quiescent predecessor always fails closed. After a host reboot, the
kernel has terminated every old process and released every descriptor; a changed
kernel boot-session ID is therefore sufficient to reconcile the old generation before
creating a new one. PID age, heartbeat age, and missing files are never treated as
quiescence proof.

## Liveness and authority

The guardian/reaper boundary distinguishes these local outcomes:

| Evidence | Stop cause | Observation |
| --- | --- | --- |
| Explicit Capsule shutdown | `capsule_shutdown` | `stopped` |
| Local authority signal aborts | `authority_revoked` | `stopped` |
| Absolute generation deadline expires | `deadline_exceeded` | `unresponsive` |
| Capsule heartbeats stop | `heartbeat_timeout` | `unresponsive` |
| A provider request exceeds its response bound | `provider_unresponsive` | `unresponsive` |
| Provider or guardian fails unexpectedly | `provider_failure` | `crashed` |

The absolute deadline is part of initialization, so `ready` also acknowledges that
both the guardian and surviving witness watchdogs are armed. Capsule heartbeats are
forwarded to the witness; the witness therefore retains deadline and heartbeat
authority if the guardian or Capsule disappears. A local `AbortSignal` can revoke a
generation without a runner calling `terminate` directly. Issue #97 must still prove
that Mission lease, fence, expiry, and revocation state are the verified sources for
these local inputs.

## Recovery behavior

The guardian supplies the fresh-generation boundary used by the schema-v2 Codex
runner:

- an ambiguous `turn/start` is reconciled by exact client ID and text without resend;
- an inherited `interrupt_maybe_sent` intent is read once and never reissued; and
- unexpected provider termination retires the owning Capsule generation.

The private `provider-generation.json` file contains only bounded lifecycle fields. It
does not contain a PID, process path, prompt, provider turn ID, stderr, or credential.
Provider and supervisor failures become fixed local error categories, while the
Capsule wire exposes only its existing generic runtime failure.

## Failure matrix

| Failure | Result |
| --- | --- |
| Capsule dies before guardian spawn | No start barrier exists; the kernel releases the lock and replacement can start. |
| Witness cannot arm | No start barrier or provider exists; startup fails and the Capsule releases ownership after proving guardian-group absence. |
| Capsule dies during version probe or provider life | Guardian or witness observes owner loss; the witness cleans the group and records quiescence. |
| Guardian dies while Capsule lives | Witness cleans and finalizes the group; Capsule independently proves absence before releasing ownership. |
| Capsule and guardian die together | The out-of-group witness retains the lock, cleans the group, records quiescence, and closes ownership. |
| Provider dies | Guardian requests teardown; the witness records a provider crash after cleaning descendants. |
| Provider ignores revocation or deadline | Witness grace expires and process-group `SIGKILL` removes provider authority and descendants. |
| Witness fails after the start barrier | Guardian and Capsule remove the group, but no process invents quiescence; ownership remains fail-closed until reboot or OS-owned recovery. |
| Generation state disappears or changes identity after the start barrier | Witness removes the process group but retains its kernel lock because matching-generation quiescence cannot be recorded. |
| Host reboots | Changed boot-session identity reconciles the now-dead prior generation. |
| Witness or every local lifecycle owner is lost | Replacement fails closed unless host reboot or an OS-owned containment boundary proves cleanup. |

If Capsule heartbeats stall because the Capsule itself is stopped, the witness removes
provider authority and descendants, but it does not record quiescence while the stopped
Capsule has not reaped its guardian zombie. State remains `stop_requested` and the lock
remains held until complete process-group absence becomes provable.

For the POSIX group probe, only `ESRCH` proves absence. Darwin can return `EPERM` for
a zombie-only group; the witness treats that as present but unsignalable, retains its
lock, and keeps polling instead of either inventing quiescence or failing permanently.

The final row is intentionally not inferred from PIDs. Installed service/cgroup
containment, restart/upgrade/rollback behavior, and descendants that escape the
supervised process group remain issue #120.

## Evidence

The database-free test suite covers:

- simultaneous guardian contenders and same-instance duplicate opens;
- preparation-time revocation and witness-arm failure without a start barrier or
  provider spawn;
- owner death before guardian spawn, during the version probe, and after provider
  readiness, including continuous-output pipe failure;
- owner heartbeat stall, guardian death, joint Capsule/guardian death on Linux,
  provider crash, and request timeout;
- missing or replaced durable generation state after provider startup, with the
  witness retaining ownership instead of admitting a replacement;
- authoritative same-generation reaper finalization without rewriting another
  generation;
- local revocation and absolute deadline against a provider that ignores `SIGTERM`;
- Darwin `EPERM` handling that keeps zombie-only process groups fail-closed until a
  later probe proves absence;
- descendant cleanup, durable authoritative-cause state, reboot-gated recovery,
  startup-error redaction, and provider environment filtering;
- fresh-generation uncertain-start and inherited-interrupt recovery through the real
  private Capsule wire; and
- pinned Codex startup through both the guardian and the real Linux containment
  boundary in the dedicated process job.

The process tests run on supported Node versions on Linux and macOS. The Linux-only
guardian-death, joint-owner-death, and Bubblewrap proofs run in the containment job.

## Remaining activation gates

- **#97:** continuously validate Relay lease/fence/expiry/revocation authority and
  translate it into the local deadline and revocation signal.
- **#98:** select the Codex descriptor in the Capsule/Node CLI, persist the exact
  containment recovery handle before provider start, and run Guarded Real Mission 0.
- **#120:** install the Node as an OS-supervised service, add cgroup/process containment,
  and close witness/all-owner loss, escaped-descendant, restart, upgrade, and rollback
  behavior.

Until those gates pass, describe this as a guardian library and process proof, not an
autonomous Mission runtime.
