import type { RuntimeAuthorityPort } from "./runtime-authority-port.js";
import {
	LocalReferenceMonitor,
	RuntimeAuthorityDeniedError,
	type RuntimeAuthorityDenyCode,
	type RuntimeAuthorityEvidenceSink,
	type RuntimeAuthorityGrant,
	type RuntimeAuthorityRenewal,
	type RuntimeAuthorityRequest,
	advanceRuntimeAuthorityLease,
} from "./runtime-authority.js";

export interface NodeRuntimeAuthoritySessionOptions {
	readonly port: RuntimeAuthorityPort;
	readonly grant: RuntimeAuthorityGrant;
	readonly currentLease: RuntimeAuthorityRenewal;
	readonly evidenceSink: RuntimeAuthorityEvidenceSink;
	readonly now?: () => Date;
	readonly readCurrentLease?: () => RuntimeAuthorityRenewal;
	readonly beforeReady?: (session: NodeRuntimeAuthoritySession) => void | Promise<void>;
}

/**
 * Node-local reference monitor for one installed runtime grant.
 *
 * Node effect callers use this session instead of calling the authority port's
 * raw assertion method. That keeps local liveness and the effect in one guarded
 * operation while the runtime independently records and revalidates the request.
 */
export class NodeRuntimeAuthoritySession {
	readonly #port: RuntimeAuthorityPort;
	readonly #monitor: LocalReferenceMonitor;

	private constructor(options: NodeRuntimeAuthoritySessionOptions) {
		this.#port = options.port;
		this.#monitor = new LocalReferenceMonitor(options.grant, options.evidenceSink, {
			currentLease: options.currentLease,
			...(options.now === undefined ? {} : { now: options.now }),
		});
	}

	static async install(
		options: NodeRuntimeAuthoritySessionOptions,
	): Promise<NodeRuntimeAuthoritySession> {
		const now = options.now ?? (() => new Date());
		let currentLease = normalizedRenewal(
			options.grant,
			options.grant.lease_expires_at,
			options.currentLease,
		);
		assertLeaseLive(options.grant, currentLease, now());
		let session: NodeRuntimeAuthoritySession | null = null;
		try {
			for (let attempt = 0; attempt < 8; attempt += 1) {
				try {
					await options.port.installAuthority(options.grant, currentLease);
				} catch (error) {
					const latest = readLatestRenewal(options, currentLease);
					if (!leaseAdvanced(currentLease, latest) && !isExpiredDenial(error)) throw error;
					assertLeaseLive(options.grant, latest, now());
					currentLease = latest;
					continue;
				}
				const latest = readLatestRenewal(options, currentLease);
				if (leaseAdvanced(currentLease, latest)) {
					assertLeaseLive(options.grant, latest, now());
					currentLease = latest;
					continue;
				}
				assertLeaseLive(options.grant, latest, now());
				session = new NodeRuntimeAuthoritySession({ ...options, currentLease: latest, now });
				await options.beforeReady?.(session);
				if (session.signal.aborted) throw new RuntimeAuthorityDeniedError("expired");
				return session;
			}
			throw new Error("Runtime authority lease did not stabilize during installation");
		} catch (error) {
			const reason = denialReason(error);
			if (session !== null) session.#monitor.revoke(reason);
			await options.port.revokeAuthority(options.grant, reason).catch(() => undefined);
			throw error;
		}
	}

	get grant(): RuntimeAuthorityGrant {
		return this.#monitor.grant;
	}

	get signal(): AbortSignal {
		return this.#monitor.signal;
	}

	async renew(renewal: RuntimeAuthorityRenewal): Promise<void> {
		try {
			this.#monitor.renew(renewal);
		} catch (error) {
			const reason = denialReason(error);
			this.#monitor.revoke(reason);
			await this.revokeRemote(reason);
			throw error;
		}
		try {
			await this.#port.renewAuthority(this.grant.mission_id, renewal);
		} catch (error) {
			const reason = denialReason(error);
			this.#monitor.revoke(reason);
			await this.revokeRemote(reason);
			throw error;
		}
	}

	async revoke(reason: RuntimeAuthorityDenyCode = "revoked"): Promise<void> {
		this.revokeLocal(reason);
		await this.#port.revokeAuthority(this.grant, reason);
	}

	revokeLocal(reason: RuntimeAuthorityDenyCode = "revoked"): void {
		this.#monitor.revoke(reason);
	}

	async perform<T>(
		request: RuntimeAuthorityRequest,
		effect: (signal: AbortSignal) => T | Promise<T>,
	): Promise<T> {
		return this.#monitor.perform(request, async () => {
			try {
				await this.#port.assertAuthority(request);
			} catch (error) {
				this.#monitor.revoke(denialReason(error));
				throw error;
			}
			this.#monitor.assert(request);
			return effect(this.#monitor.signal);
		});
	}

	private async revokeRemote(reason: RuntimeAuthorityDenyCode): Promise<void> {
		await this.#port.revokeAuthority(this.grant, reason).catch(() => undefined);
	}
}

function normalizedRenewal(
	grant: RuntimeAuthorityGrant,
	currentExpiry: string,
	value: RuntimeAuthorityRenewal,
): RuntimeAuthorityRenewal {
	return { ...value, lease_expires_at: advanceRuntimeAuthorityLease(grant, currentExpiry, value) };
}

function readLatestRenewal(
	options: NodeRuntimeAuthoritySessionOptions,
	currentLease: RuntimeAuthorityRenewal,
): RuntimeAuthorityRenewal {
	return normalizedRenewal(
		options.grant,
		currentLease.lease_expires_at,
		options.readCurrentLease?.() ?? currentLease,
	);
}

function assertLeaseLive(
	grant: RuntimeAuthorityGrant,
	lease: RuntimeAuthorityRenewal,
	now: Date,
): void {
	const timestamp = now.getTime();
	if (
		!Number.isFinite(timestamp) ||
		timestamp >= Date.parse(lease.lease_expires_at) ||
		timestamp >= Date.parse(grant.hard_expires_at)
	) {
		throw new RuntimeAuthorityDeniedError("expired");
	}
}

function leaseAdvanced(left: RuntimeAuthorityRenewal, right: RuntimeAuthorityRenewal): boolean {
	return Date.parse(right.lease_expires_at) > Date.parse(left.lease_expires_at);
}

function isExpiredDenial(error: unknown): boolean {
	return (
		(error instanceof RuntimeAuthorityDeniedError && error.code === "expired") ||
		(typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "authority_denied" &&
			error instanceof Error &&
			error.message === "Runtime authority denied: expired")
	);
}

function denialReason(error: unknown): RuntimeAuthorityDenyCode {
	return error instanceof RuntimeAuthorityDeniedError ? error.code : "revoked";
}
