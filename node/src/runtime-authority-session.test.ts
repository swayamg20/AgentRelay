import { describe, expect, it, vi } from "vitest";
import type { RuntimeAuthorityPort } from "./runtime-authority-port.js";
import { NodeRuntimeAuthoritySession } from "./runtime-authority-session.js";
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

	it("does not contact the runtime when local authority is already expired", async () => {
		const port = new FakeAuthorityPort();
		const grant = authorityGrant({ lease_expires_at: AUTHORITY_NOW });

		await expect(installSession(port, grant, currentLease(grant))).rejects.toMatchObject({
			code: "expired",
		});
		expect(port.installations).toBe(0);
		expect(port.revocations).toEqual([]);
	});

	it("best-effort revokes an ambiguous remote install without replacing its error", async () => {
		const installError = new Error("authority install response lost");
		const port = new FakeAuthorityPort();
		port.installResult = Promise.reject(installError);
		port.revokeResult = Promise.reject(new Error("authority revoke response lost"));

		await expect(installSession(port)).rejects.toBe(installError);
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
	installations = 0;
	assertError: Error | null = null;
	installResult: Promise<void> = Promise.resolve();
	revokeResult: Promise<void> = Promise.resolve();

	async installAuthority(
		_grant: RuntimeAuthorityGrant,
		_currentLease: RuntimeAuthorityRenewal,
	): Promise<void> {
		this.installations += 1;
		return this.installResult;
	}

	async assertAuthority(request: RuntimeAuthorityRequest): Promise<void> {
		this.assertions.push(request);
		if (this.assertError !== null) throw this.assertError;
	}

	async renewAuthority(_missionId: string, renewal: RuntimeAuthorityRenewal): Promise<void> {
		this.renewals.push(renewal);
	}

	async revokeAuthority(
		_missionId: string,
		_grantId: string,
		_reason: RuntimeAuthorityDenyCode,
	): Promise<void> {
		this.revocations.push(_reason);
		return this.revokeResult;
	}
}
