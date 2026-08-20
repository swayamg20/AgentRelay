import { describe, expect, it, vi } from "vitest";
import type { RuntimeAuthorityPort } from "./runtime-authority-port.js";
import {
	NodeRuntimeAuthoritySession,
	RuntimeAuthorityRetirementError,
} from "./runtime-authority-session.js";
import {
	RuntimeAuthorityDeniedError,
	type RuntimeAuthorityDenyCode,
	type RuntimeAuthorityGrant,
	type RuntimeAuthorityRenewal,
	type RuntimeAuthorityRequest,
} from "./runtime-authority.js";
import { AUTHORITY_NOW, authorityGrant, startRequest } from "./runtime-authority.test-support.js";

const noEvidence = { record: () => undefined };

describe("NodeRuntimeAuthoritySession", () => {
	it("allows local reads but denies ungranted writes before the first remote install", async () => {
		const port = new FakeAuthorityPort();
		const workspaceRead = vi.fn(() => "prepared");
		const workspaceWrite = vi.fn(() => "changed");
		const runtimeEffect = vi.fn();

		const session = await NodeRuntimeAuthoritySession.install({
			port,
			grant: authorityGrant(),
			currentLease: currentLease(authorityGrant()),
			evidenceSink: noEvidence,
			now: () => new Date(AUTHORITY_NOW),
			beforeRemoteInstall: async (installing) => {
				expect(port.installations).toBe(0);
				await expect(installing.performWorkspaceRead(workspaceRead)).resolves.toBe("prepared");
				await expect(installing.performWorkspaceWrite(workspaceWrite)).rejects.toMatchObject({
					code: "capability_missing",
				});
				await expect(installing.perform(startRequest(), runtimeEffect)).rejects.toThrow(
					"Runtime authority session is not active",
				);
				expect(port.assertions).toHaveLength(0);
			},
		});

		expect(port.installations).toBe(1);
		expect(workspaceRead).toHaveBeenCalledOnce();
		expect(workspaceWrite).not.toHaveBeenCalled();
		expect(runtimeEffect).not.toHaveBeenCalled();
		await expect(session.perform(startRequest(), () => "active")).resolves.toBe("active");
	});

	it("allows an explicitly granted local workspace write before remote install", async () => {
		const port = new FakeAuthorityPort();
		const base = authorityGrant();
		const grant = authorityGrant({
			capabilities: [...base.capabilities, { action: "workspace_write", resource: "workspace" }],
		});
		const workspaceWrite = vi.fn(() => "changed");

		await NodeRuntimeAuthoritySession.install({
			port,
			grant,
			currentLease: currentLease(grant),
			evidenceSink: noEvidence,
			now: () => new Date(AUTHORITY_NOW),
			beforeRemoteInstall: async (installing) => {
				expect(port.installations).toBe(0);
				await expect(installing.performWorkspaceWrite(workspaceWrite)).resolves.toBe("changed");
				expect(port.assertions).toHaveLength(0);
			},
		});

		expect(workspaceWrite).toHaveBeenCalledOnce();
		expect(port.installations).toBe(1);
	});

	it("installs the exact journaled renewal received during local preinstall", async () => {
		const port = new FakeAuthorityPort();
		const grant = authorityGrant();
		const initialLease = currentLease(grant);
		const renewedLease = {
			...initialLease,
			lease_expires_at: "2026-08-17T00:02:00.000Z",
		};
		let journaledLease = initialLease;

		await NodeRuntimeAuthoritySession.install({
			port,
			grant,
			currentLease: initialLease,
			readCurrentLease: () => journaledLease,
			evidenceSink: noEvidence,
			now: () => new Date(AUTHORITY_NOW),
			beforeRemoteInstall: async (installing) => {
				journaledLease = renewedLease;
				await installing.renew(renewedLease);
			},
		});

		expect(port.installationLeases).toEqual([renewedLease]);
		expect(port.renewals).toEqual([]);
	});

	it("converges a renewal received during the first remote install", async () => {
		const port = new FakeAuthorityPort();
		const grant = authorityGrant();
		const initialLease = currentLease(grant);
		const renewedLease = {
			...initialLease,
			lease_expires_at: "2026-08-17T00:02:00.000Z",
		};
		let journaledLease = initialLease;
		let installingSession: NodeRuntimeAuthoritySession | null = null;
		port.beforeInstall = (_lease, attempt) => {
			if (attempt !== 1 || installingSession === null) return;
			journaledLease = renewedLease;
			void installingSession.renew(renewedLease);
		};

		await NodeRuntimeAuthoritySession.install({
			port,
			grant,
			currentLease: initialLease,
			readCurrentLease: () => journaledLease,
			evidenceSink: noEvidence,
			now: () => new Date(AUTHORITY_NOW),
			beforeRemoteInstall: (installing) => {
				installingSession = installing;
			},
		});

		expect(port.installationLeases).toEqual([initialLease, renewedLease]);
		expect(port.renewals).toEqual([]);
	});

	it("keeps beforeReady after a proven remote install", async () => {
		const port = new FakeAuthorityPort();
		const phases: string[] = [];
		port.beforeInstall = () => phases.push("remote_install");

		const session = await NodeRuntimeAuthoritySession.install({
			port,
			grant: authorityGrant(),
			currentLease: currentLease(authorityGrant()),
			evidenceSink: noEvidence,
			now: () => new Date(AUTHORITY_NOW),
			beforeRemoteInstall: () => phases.push("local_preinstall"),
			beforeReady: () => {
				phases.push("before_ready");
			},
		});

		expect(phases).toEqual(["local_preinstall", "remote_install", "before_ready"]);
		await expect(session.perform(startRequest(), () => "allowed")).resolves.toBe("allowed");
	});

	it("rechecks the journal after beforeReady before activating", async () => {
		const port = new FakeAuthorityPort();
		const grant = authorityGrant();
		const initialLease = currentLease(grant);
		const renewedLease = {
			...initialLease,
			lease_expires_at: "2026-08-17T00:02:00.000Z",
		};
		let journaledLease = initialLease;

		await NodeRuntimeAuthoritySession.install({
			port,
			grant,
			currentLease: initialLease,
			readCurrentLease: () => journaledLease,
			evidenceSink: noEvidence,
			now: () => new Date(AUTHORITY_NOW),
			beforeReady: async (session) => {
				journaledLease = renewedLease;
				await session.renew(renewedLease);
			},
		});

		expect(port.installationLeases).toEqual([initialLease, renewedLease]);
		expect(port.renewals).toEqual([]);
	});

	it("does not contact the runtime when local preinstall fails", async () => {
		const failure = new Error("workspace preparation failed");
		const port = new FakeAuthorityPort();

		await expect(
			NodeRuntimeAuthoritySession.install({
				port,
				grant: authorityGrant(),
				currentLease: currentLease(authorityGrant()),
				evidenceSink: noEvidence,
				now: () => new Date(AUTHORITY_NOW),
				beforeRemoteInstall: () => {
					throw failure;
				},
			}),
		).rejects.toBe(failure);
		expect(port.installations).toBe(0);
		expect(port.revocations).toEqual([]);
	});

	it("skips local preinstall when Node shutdown was already requested", async () => {
		const shutdown = new AbortController();
		const shutdownError = new Error("Node shutdown requested");
		const beforeRemoteInstall = vi.fn();
		const port = new FakeAuthorityPort();
		shutdown.abort(shutdownError);

		await expect(
			NodeRuntimeAuthoritySession.install({
				port,
				grant: authorityGrant(),
				currentLease: currentLease(authorityGrant()),
				evidenceSink: noEvidence,
				now: () => new Date(AUTHORITY_NOW),
				abortSignal: shutdown.signal,
				beforeRemoteInstall,
			}),
		).rejects.toBe(shutdownError);

		expect(beforeRemoteInstall).not.toHaveBeenCalled();
		expect(port.installations).toBe(0);
		expect(port.revocations).toEqual([]);
	});

	it("waits for aborted local preinstall cleanup without contacting the runtime", async () => {
		const shutdown = new AbortController();
		const shutdownError = new Error("Node shutdown requested");
		const port = new FakeAuthorityPort();
		let releaseCleanup!: () => void;
		const cleanup = new Promise<void>((resolve) => {
			releaseCleanup = resolve;
		});
		let hookSignal: AbortSignal | null = null;
		const installing = NodeRuntimeAuthoritySession.install({
			port,
			grant: authorityGrant(),
			currentLease: currentLease(authorityGrant()),
			evidenceSink: noEvidence,
			now: () => new Date(AUTHORITY_NOW),
			abortSignal: shutdown.signal,
			beforeRemoteInstall: async (session) => {
				hookSignal = session.signal;
				if (!session.signal.aborted) {
					await new Promise<void>((resolve) =>
						session.signal.addEventListener("abort", () => resolve(), { once: true }),
					);
				}
				await cleanup;
				throw shutdownError;
			},
		});
		await vi.waitFor(() => expect(hookSignal).not.toBeNull());
		const settled = vi.fn();
		void installing.then(settled, settled);

		shutdown.abort(shutdownError);
		await vi.waitFor(() => expect(hookSignal?.aborted).toBe(true));
		expect(settled).not.toHaveBeenCalled();
		expect(port.installations).toBe(0);

		releaseCleanup();
		await expect(installing).rejects.toBe(shutdownError);
		expect(port.revocations).toEqual([]);
	});

	it("expires locally while preinstall is still running", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(AUTHORITY_NOW);
		try {
			const port = new FakeAuthorityPort();
			const grant = authorityGrant({ lease_expires_at: "2026-08-17T00:00:00.100Z" });
			let hookStarted = false;
			const installing = NodeRuntimeAuthoritySession.install({
				port,
				grant,
				currentLease: currentLease(grant),
				evidenceSink: noEvidence,
				beforeRemoteInstall: async (session) => {
					hookStarted = true;
					if (session.signal.aborted) return;
					await new Promise<void>((resolve) =>
						session.signal.addEventListener("abort", () => resolve(), { once: true }),
					);
				},
			});
			await vi.waitFor(() => expect(hookStarted).toBe(true));
			const rejection = expect(installing).rejects.toMatchObject({ code: "expired" });

			await vi.advanceTimersByTimeAsync(100);

			await rejection;
			expect(port.installations).toBe(0);
			expect(port.revocations).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("preserves a teardown-proof failure when authority expires during preinstall", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(AUTHORITY_NOW);
		try {
			const teardownFailure = new Error("containment teardown was not proven");
			const port = new FakeAuthorityPort();
			const grant = authorityGrant({ lease_expires_at: "2026-08-17T00:00:00.100Z" });
			let hookStarted = false;
			const installing = NodeRuntimeAuthoritySession.install({
				port,
				grant,
				currentLease: currentLease(grant),
				evidenceSink: noEvidence,
				beforeRemoteInstall: async (session) => {
					hookStarted = true;
					if (!session.signal.aborted) {
						await new Promise<void>((resolve) =>
							session.signal.addEventListener("abort", () => resolve(), { once: true }),
						);
					}
					throw teardownFailure;
				},
			});
			await vi.waitFor(() => expect(hookStarted).toBe(true));
			const rejection = expect(installing).rejects.toBe(teardownFailure);

			await vi.advanceTimersByTimeAsync(100);

			await rejection;
			expect(port.installations).toBe(0);
			expect(port.revocations).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a preinstall revoke entirely local", async () => {
		const port = new FakeAuthorityPort();

		await expect(
			NodeRuntimeAuthoritySession.install({
				port,
				grant: authorityGrant(),
				currentLease: currentLease(authorityGrant()),
				evidenceSink: noEvidence,
				now: () => new Date(AUTHORITY_NOW),
				beforeRemoteInstall: (session) => session.revoke("revoked"),
			}),
		).rejects.toMatchObject({ code: "revoked" });
		expect(port.installations).toBe(0);
		expect(port.revocations).toEqual([]);
	});

	it("retires an ambiguous install only after its remote call settles", async () => {
		let finishInstall!: () => void;
		const port = new FakeAuthorityPort();
		port.installResult = new Promise<void>((resolve) => {
			finishInstall = resolve;
		});
		let installingSession: NodeRuntimeAuthoritySession | null = null;
		const installing = NodeRuntimeAuthoritySession.install({
			port,
			grant: authorityGrant(),
			currentLease: currentLease(authorityGrant()),
			evidenceSink: noEvidence,
			now: () => new Date(AUTHORITY_NOW),
			beforeRemoteInstall: (session) => {
				installingSession = session;
			},
		});
		await vi.waitFor(() => expect(port.installations).toBe(1));
		if (installingSession === null) throw new Error("Preinstall session was not captured");

		const revoking = installingSession.revoke("revoked");
		expect(port.revocations).toEqual([]);
		finishInstall();

		await expect(installing).rejects.toMatchObject({ code: "revoked" });
		await revoking;
		expect(port.revocations).toEqual(["revoked"]);
	});

	it("waits for exact remote retirement before surfacing shutdown during install", async () => {
		const shutdown = new AbortController();
		const shutdownError = new Error("Node shutdown requested");
		let finishInstall!: () => void;
		let finishRetirement!: () => void;
		const port = new FakeAuthorityPort();
		port.installResult = new Promise<void>((resolve) => {
			finishInstall = resolve;
		});
		port.revokeResult = new Promise<void>((resolve) => {
			finishRetirement = resolve;
		});
		const installing = NodeRuntimeAuthoritySession.install({
			port,
			grant: authorityGrant(),
			currentLease: currentLease(authorityGrant()),
			evidenceSink: noEvidence,
			now: () => new Date(AUTHORITY_NOW),
			abortSignal: shutdown.signal,
		});
		await vi.waitFor(() => expect(port.installations).toBe(1));
		const settled = vi.fn();
		void installing.then(settled, settled);

		shutdown.abort(shutdownError);
		finishInstall();
		await vi.waitFor(() => expect(port.revocations).toEqual(["revoked"]));
		expect(settled).not.toHaveBeenCalled();

		finishRetirement();
		await expect(installing).rejects.toBe(shutdownError);
		expect(port.revokedGrants).toEqual([authorityGrant()]);
	});

	it("preserves an install cleanup failure when shutdown races its rejection", async () => {
		const shutdown = new AbortController();
		const shutdownError = new Error("Node shutdown requested");
		const cleanupFailure = new Error("provider cleanup could not be proven");
		let rejectInstall!: (error: Error) => void;
		const port = new FakeAuthorityPort();
		port.installResult = new Promise<void>((_resolve, reject) => {
			rejectInstall = reject;
		});
		const installing = NodeRuntimeAuthoritySession.install({
			port,
			grant: authorityGrant(),
			currentLease: currentLease(authorityGrant()),
			evidenceSink: noEvidence,
			now: () => new Date(AUTHORITY_NOW),
			abortSignal: shutdown.signal,
		});
		await vi.waitFor(() => expect(port.installations).toBe(1));

		shutdown.abort(shutdownError);
		rejectInstall(cleanupFailure);

		await expect(installing).rejects.toBe(cleanupFailure);
		expect(port.revocations).toEqual(["revoked"]);
		expect(port.revokedGrants).toEqual([authorityGrant()]);
	});

	it("publishes install settlement before a reentrant revoke", async () => {
		const port = new FakeAuthorityPort();
		let installingSession: NodeRuntimeAuthoritySession | null = null;
		let revoking = Promise.resolve();
		port.beforeInstall = () => {
			if (installingSession === null) throw new Error("Preinstall session was not captured");
			revoking = installingSession.revoke("revoked");
		};

		const installing = NodeRuntimeAuthoritySession.install({
			port,
			grant: authorityGrant(),
			currentLease: currentLease(authorityGrant()),
			evidenceSink: noEvidence,
			now: () => new Date(AUTHORITY_NOW),
			beforeRemoteInstall: (session) => {
				installingSession = session;
			},
		});

		await expect(installing).rejects.toMatchObject({ code: "revoked" });
		await revoking;
		expect(port.revocations).toEqual(["revoked"]);
	});

	it("does not enter an effect when the runtime denies the exact request", async () => {
		const denial = new RuntimeAuthorityDeniedError("revoked");
		const port = new FakeAuthorityPort();
		port.assertError = denial;
		const session = await installSession(port);
		const effect = vi.fn();

		await expect(session.perform(startRequest(), effect)).rejects.toBe(denial);
		expect(effect).not.toHaveBeenCalled();
		expect(session.signal.aborted).toBe(true);
	});

	it("rechecks local expiry after a delayed remote assertion", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(AUTHORITY_NOW);
		try {
			let finishAssertion!: () => void;
			const port = new FakeAuthorityPort();
			port.assertResult = new Promise<void>((resolve) => {
				finishAssertion = resolve;
			});
			const grant = authorityGrant({ lease_expires_at: "2026-08-17T00:00:00.100Z" });
			const session = await installSession(port, grant, currentLease(grant));
			const effect = vi.fn();
			const performing = session.perform(startRequest(grant), effect);
			await vi.waitFor(() => expect(port.assertions).toHaveLength(1));

			await vi.advanceTimersByTimeAsync(100);
			finishAssertion();

			await expect(performing).rejects.toMatchObject({ code: "expired" });
			expect(effect).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("aborts an in-flight effect locally before remote revocation completes", async () => {
		let finishRemoteRevoke: (() => void) | undefined;
		const port = new FakeAuthorityPort();
		port.revokeResult = new Promise<void>((resolve) => {
			finishRemoteRevoke = resolve;
		});
		const session = await installSession(port);
		let effectSignal: AbortSignal | undefined;
		const effect = session.perform(startRequest(), (signal) => {
			effectSignal = signal;
			return new Promise<string>((resolve) => {
				signal.addEventListener("abort", () => resolve("aborted"), { once: true });
			});
		});

		await vi.waitFor(() => expect(effectSignal).toBeDefined());
		const revocation = session.revoke("revoked");
		expect(effectSignal?.aborted).toBe(true);
		await expect(effect).resolves.toBe("aborted");
		finishRemoteRevoke?.();
		await revocation;
	});

	it("aborts an in-flight effect at the exact local lease expiry", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(AUTHORITY_NOW);
		try {
			const port = new FakeAuthorityPort();
			const grant = authorityGrant({ lease_expires_at: "2026-08-17T00:00:00.100Z" });
			const session = await installSession(port, grant, {
				grant_id: grant.grant_id,
				lease_id: grant.lease_id,
				fencing_token: grant.fencing_token,
				lease_expires_at: grant.lease_expires_at,
			});
			let effectSignal: AbortSignal | undefined;
			const effect = session.perform(startRequest(grant), (signal) => {
				effectSignal = signal;
				return new Promise<string>((resolve) => {
					signal.addEventListener("abort", () => resolve("expired"), { once: true });
				});
			});

			await vi.advanceTimersByTimeAsync(100);
			expect(effectSignal?.aborted).toBe(true);
			await expect(effect).resolves.toBe("expired");
		} finally {
			vi.useRealTimers();
		}
	});

	it("accepts an exact renewal replay in both monitors", async () => {
		const port = new FakeAuthorityPort();
		const session = await installSession(port);
		const renewal = currentLease(authorityGrant());

		await session.renew(renewal);
		await session.renew(renewal);

		expect(port.renewals).toEqual([renewal, renewal]);
		await expect(session.perform(startRequest(), () => "allowed")).resolves.toBe("allowed");
	});

	it("revokes locally and remotely when renewal confirmation fails", async () => {
		const port = new FakeAuthorityPort();
		port.renewError = new Error("renew response lost");
		const session = await installSession(port);
		const renewal = {
			...currentLease(authorityGrant()),
			lease_expires_at: "2026-08-17T00:02:00.000Z",
		};

		await expect(session.renew(renewal)).rejects.toThrow("renew response lost");

		expect(session.signal.aborted).toBe(true);
		expect(port.revocations).toEqual(["revoked"]);
	});

	it("keeps remote retirement failure ahead of a renewal confirmation failure", async () => {
		const renewalError = new Error("renew response lost");
		const retirementError = new Error("authority revoke response lost");
		const port = new FakeAuthorityPort();
		port.renewError = renewalError;
		const session = await installSession(port);
		port.revokeResult = Promise.reject(retirementError);
		const renewal = {
			...currentLease(authorityGrant()),
			lease_expires_at: "2026-08-17T00:02:00.000Z",
		};

		const failure = await session.renew(renewal).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(RuntimeAuthorityRetirementError);
		if (!(failure instanceof RuntimeAuthorityRetirementError)) return;
		expect(failure.errors).toEqual([retirementError, renewalError]);
		expect(failure.cause).toBe(retirementError);
		expect(session.signal.aborted).toBe(true);
		expect(port.revocations).toEqual(["revoked"]);
	});

	it("keeps remote retirement failure ahead of a local renewal denial", async () => {
		const retirementError = new Error("authority revoke response lost");
		const port = new FakeAuthorityPort();
		const session = await installSession(port);
		port.revokeResult = Promise.reject(retirementError);
		const renewal = {
			...currentLease(authorityGrant()),
			grant_id: "97000000-0000-4000-8000-000000000099",
		};

		const failure = await session.renew(renewal).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(RuntimeAuthorityRetirementError);
		if (!(failure instanceof RuntimeAuthorityRetirementError)) return;
		expect(failure.errors[0]).toBe(retirementError);
		expect(failure.errors[1]).toMatchObject({ code: "wrong_grant" });
		expect(port.renewals).toEqual([]);
		expect(port.revocations).toEqual(["wrong_grant"]);
	});

	it("rejects a changed scope locally without consulting the runtime", async () => {
		const port = new FakeAuthorityPort();
		const session = await installSession(port);
		const effect = vi.fn();

		await expect(
			session.perform(
				{ ...startRequest(), delivery_id: "97000000-0000-4000-8000-000000000099" },
				effect,
			),
		).rejects.toMatchObject({ code: "wrong_delivery" });
		expect(port.assertions).toHaveLength(0);
		expect(effect).not.toHaveBeenCalled();
	});

	it("retires a remote install that finishes after local authority expires", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(AUTHORITY_NOW);
		try {
			let finishInstall!: () => void;
			const port = new FakeAuthorityPort();
			port.installResult = new Promise<void>((resolve) => {
				finishInstall = resolve;
			});
			const grant = authorityGrant({ lease_expires_at: "2026-08-17T00:00:00.100Z" });
			const installing = installSession(port, grant, {
				grant_id: grant.grant_id,
				lease_id: grant.lease_id,
				fencing_token: grant.fencing_token,
				lease_expires_at: grant.lease_expires_at,
			});

			await vi.advanceTimersByTimeAsync(100);
			finishInstall();

			await expect(installing).rejects.toMatchObject({ code: "expired" });
			expect(port.revocations).toEqual(["expired"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("retries an expired install with the newer journaled lease", async () => {
		const port = new FakeAuthorityPort();
		const grant = authorityGrant();
		const initialLease = currentLease(grant);
		const renewedLease = {
			...initialLease,
			lease_expires_at: "2026-08-17T00:02:00.000Z",
		};
		let journaledLease = initialLease;
		port.beforeInstall = (_lease, attempt) => {
			if (attempt !== 1) return;
			journaledLease = renewedLease;
			throw Object.assign(new Error("Runtime authority denied: expired"), {
				code: "authority_denied",
			});
		};

		const session = await NodeRuntimeAuthoritySession.install({
			port,
			grant,
			currentLease: initialLease,
			readCurrentLease: () => journaledLease,
			evidenceSink: noEvidence,
			now: () => new Date(AUTHORITY_NOW),
		});

		expect(port.installationLeases).toEqual([initialLease, renewedLease]);
		expect(session.signal.aborted).toBe(false);
		expect(port.revocations).toEqual([]);
	});

	it("retires the exact grant after bounded expired install retries are exhausted", async () => {
		const port = new FakeAuthorityPort();
		const grant = authorityGrant();
		const lease = currentLease(grant);
		port.beforeInstall = () => {
			throw Object.assign(new Error("Runtime authority denied: expired"), {
				code: "authority_denied",
			});
		};

		await expect(
			NodeRuntimeAuthoritySession.install({
				port,
				grant,
				currentLease: lease,
				readCurrentLease: () => lease,
				evidenceSink: noEvidence,
				now: () => new Date(AUTHORITY_NOW),
			}),
		).rejects.toThrow("Runtime authority lease did not stabilize during installation");

		expect(port.installationLeases).toEqual(Array.from({ length: 8 }, () => lease));
		expect(port.revocations).toEqual(["revoked"]);
		expect(port.revokedGrants).toEqual([grant]);
	});

	it("does not contact the runtime when local authority is already expired", async () => {
		const port = new FakeAuthorityPort();
		const grant = authorityGrant({ lease_expires_at: AUTHORITY_NOW });

		await expect(installSession(port, grant, currentLease(grant))).rejects.toMatchObject({
			code: "expired",
		});
		expect(port.installations).toBe(0);
		expect(port.revocations).toEqual([]);
	});

	it("keeps remote retirement failure ahead of an ambiguous install failure", async () => {
		const installError = new Error("authority install response lost");
		const retirementError = new Error("authority revoke response lost");
		const port = new FakeAuthorityPort();
		port.installResult = Promise.reject(installError);
		port.revokeResult = Promise.reject(retirementError);

		const failure = await installSession(port).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(RuntimeAuthorityRetirementError);
		if (!(failure instanceof RuntimeAuthorityRetirementError)) return;
		expect(failure.errors).toEqual([retirementError, installError]);
		expect(failure.cause).toBe(retirementError);
		expect(port.installations).toBe(1);
		expect(port.revocations).toEqual(["revoked"]);
	});
});

async function installSession(
	port: FakeAuthorityPort,
	grant = authorityGrant(),
	lease = currentLease(grant),
): Promise<NodeRuntimeAuthoritySession> {
	return NodeRuntimeAuthoritySession.install({
		port,
		grant,
		currentLease: lease,
		evidenceSink: noEvidence,
		...(grant.lease_expires_at === "2026-08-17T00:00:00.100Z"
			? {}
			: { now: () => new Date(AUTHORITY_NOW) }),
	});
}

function currentLease(grant: RuntimeAuthorityGrant): RuntimeAuthorityRenewal {
	return {
		grant_id: grant.grant_id,
		lease_id: grant.lease_id,
		fencing_token: grant.fencing_token,
		lease_expires_at: grant.lease_expires_at,
	};
}

class FakeAuthorityPort implements RuntimeAuthorityPort {
	readonly assertions: RuntimeAuthorityRequest[] = [];
	readonly renewals: RuntimeAuthorityRenewal[] = [];
	readonly revocations: RuntimeAuthorityDenyCode[] = [];
	readonly revokedGrants: RuntimeAuthorityGrant[] = [];
	readonly installationLeases: RuntimeAuthorityRenewal[] = [];
	installations = 0;
	assertError: Error | null = null;
	assertResult: Promise<void> = Promise.resolve();
	beforeInstall: ((lease: RuntimeAuthorityRenewal, attempt: number) => void) | null = null;
	renewError: Error | null = null;
	installResult: Promise<void> = Promise.resolve();
	revokeResult: Promise<void> = Promise.resolve();

	async installAuthority(
		_grant: RuntimeAuthorityGrant,
		currentLease: RuntimeAuthorityRenewal,
	): Promise<void> {
		this.installations += 1;
		this.installationLeases.push(structuredClone(currentLease));
		this.beforeInstall?.(currentLease, this.installations);
		return this.installResult;
	}

	async assertAuthority(request: RuntimeAuthorityRequest): Promise<void> {
		this.assertions.push(request);
		if (this.assertError !== null) throw this.assertError;
		await this.assertResult;
	}

	async renewAuthority(_missionId: string, renewal: RuntimeAuthorityRenewal): Promise<void> {
		this.renewals.push(renewal);
		if (this.renewError !== null) throw this.renewError;
	}

	async revokeAuthority(
		grant: RuntimeAuthorityGrant,
		_reason: RuntimeAuthorityDenyCode,
	): Promise<void> {
		this.revokedGrants.push(structuredClone(grant));
		this.revocations.push(_reason);
		return this.revokeResult;
	}
}
