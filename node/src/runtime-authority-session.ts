import type { RuntimeAuthorityPort } from "./runtime-authority-port.js";
import {
	LocalReferenceMonitor,
	RuntimeAuthorityDeniedError,
	type RuntimeAuthorityDenyCode,
	type RuntimeAuthorityEvidenceSink,
	type RuntimeAuthorityGrant,
	type RuntimeAuthorityRenewal,
	type RuntimeAuthorityRequest,
	type RuntimeWorkspaceAuthority,
	advanceRuntimeAuthorityLease,
	runtimeAuthorityDenyCodeSchema,
	runtimeAuthorityRequest,
} from "./runtime-authority.js";

export interface NodeRuntimeAuthoritySessionOptions {
	readonly port: RuntimeAuthorityPort;
	readonly grant: RuntimeAuthorityGrant;
	readonly currentLease: RuntimeAuthorityRenewal;
	readonly evidenceSink: RuntimeAuthorityEvidenceSink;
	readonly abortSignal?: AbortSignal;
	readonly now?: () => Date;
	readonly readCurrentLease?: () => RuntimeAuthorityRenewal;
	readonly beforeRemoteInstall?: (session: NodeRuntimeAuthoritySession) => void | Promise<void>;
	readonly beforeReady?: (session: NodeRuntimeAuthoritySession) => void | Promise<void>;
}

type RuntimeAuthoritySessionPhase = "local_preinstall" | "remote_installing" | "active" | "revoked";

export class RuntimeAuthorityRetirementError extends AggregateError {
	constructor(retirementError: unknown, authorityError: unknown) {
		super(
			[retirementError, authorityError],
			"Runtime authority retirement could not be proven after an authority failure",
			{ cause: retirementError },
		);
		this.name = "RuntimeAuthorityRetirementError";
	}
}

/**
 * Node-local reference monitor for one installed runtime grant.
 *
 * Node effect callers use this session instead of calling the authority port's
 * raw assertion method. That keeps local liveness and the effect in one guarded
 * operation while the runtime independently records and revalidates the request.
 */
export class NodeRuntimeAuthoritySession implements RuntimeWorkspaceAuthority {
	readonly #port: RuntimeAuthorityPort;
	readonly #monitor: LocalReferenceMonitor;
	#phase: RuntimeAuthoritySessionPhase = "local_preinstall";
	#remoteInstallAttempted = false;
	#remoteInstallInFlight: Promise<void> | null = null;
	#remoteRetirement: Promise<void> | null = null;
	#remoteRetired = false;

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
		const session = new NodeRuntimeAuthoritySession({ ...options, currentLease, now });
		const abortSession = () => session.revokeLocal("revoked");
		options.abortSignal?.addEventListener("abort", abortSession, { once: true });
		if (options.abortSignal?.aborted) abortSession();
		let beforeReadyPending = options.beforeReady !== undefined;
		try {
			options.abortSignal?.throwIfAborted();
			await options.beforeRemoteInstall?.(session);
			options.abortSignal?.throwIfAborted();

			for (let attempt = 0; attempt < 8; attempt += 1) {
				currentLease = session.synchronizeLocalLease(options, currentLease, now);
				try {
					await session.installRemote(currentLease);
				} catch (error) {
					const failure = session.authorityFailure(error);
					if (session.signal.aborted) throw failure;
					options.abortSignal?.throwIfAborted();
					session.throwIfLocallyRevoked();
					const latest = readLatestRenewal(options, currentLease);
					if (!leaseAdvanced(currentLease, latest) && !isExpiredDenial(failure)) throw failure;
					currentLease = session.applyLocalLease(latest, now);
					continue;
				}

				options.abortSignal?.throwIfAborted();
				session.throwIfLocallyRevoked();
				const installedLease = currentLease;
				const latest = readLatestRenewal(options, currentLease);
				currentLease = session.applyLocalLease(latest, now);
				if (leaseAdvanced(installedLease, latest)) continue;

				if (beforeReadyPending) {
					beforeReadyPending = false;
					await options.beforeReady?.(session);
					options.abortSignal?.throwIfAborted();
					session.throwIfLocallyRevoked();
					const handoffLease = readLatestRenewal(options, currentLease);
					currentLease = session.applyLocalLease(handoffLease, now);
					if (leaseAdvanced(installedLease, handoffLease)) continue;
				}

				session.assertLocallyLive();
				session.activate();
				return session;
			}
			throw new Error("Runtime authority lease did not stabilize during installation");
		} catch (error) {
			const failure = session.authorityFailure(error);
			const reason = denialReason(failure);
			session.revokeLocal(reason);
			return session.failAfterRetirement(failure);
		} finally {
			options.abortSignal?.removeEventListener("abort", abortSession);
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
			this.revokeLocal(reason);
			return this.failAfterRetirement(error);
		}
		if (this.#phase !== "active") return;
		try {
			await this.#port.renewAuthority(this.grant.mission_id, renewal);
		} catch (error) {
			const reason = denialReason(error);
			this.revokeLocal(reason);
			return this.failAfterRetirement(error);
		}
	}

	async revoke(reason: RuntimeAuthorityDenyCode = "revoked"): Promise<void> {
		this.revokeLocal(reason);
		await this.retireRemote();
	}

	revokeLocal(reason: RuntimeAuthorityDenyCode = "revoked"): void {
		this.#phase = "revoked";
		this.#monitor.revoke(reason);
	}

	async performWorkspaceRead<T>(effect: () => T | Promise<T>): Promise<T> {
		return this.#monitor.perform(this.workspaceReadRequest(), effect);
	}

	async performWorkspaceWrite<T>(effect: () => T | Promise<T>): Promise<T> {
		return this.#monitor.perform(this.workspaceWriteRequest(), effect);
	}

	async perform<T>(
		request: RuntimeAuthorityRequest,
		effect: (signal: AbortSignal) => T | Promise<T>,
	): Promise<T> {
		this.assertActive();
		return this.#monitor.perform(request, async () => {
			try {
				await this.#port.assertAuthority(request);
			} catch (error) {
				this.revokeLocal(denialReason(error));
				throw error;
			}
			this.#monitor.assert(request);
			return effect(this.#monitor.signal);
		});
	}

	private synchronizeLocalLease(
		options: NodeRuntimeAuthoritySessionOptions,
		currentLease: RuntimeAuthorityRenewal,
		now: () => Date,
	): RuntimeAuthorityRenewal {
		return this.applyLocalLease(readLatestRenewal(options, currentLease), now);
	}

	private applyLocalLease(
		lease: RuntimeAuthorityRenewal,
		now: () => Date,
	): RuntimeAuthorityRenewal {
		this.#monitor.renew(lease);
		assertLeaseLive(this.grant, lease, now());
		return lease;
	}

	private async installRemote(currentLease: RuntimeAuthorityRenewal): Promise<void> {
		this.throwIfLocallyRevoked();
		this.#phase = "remote_installing";
		this.#remoteInstallAttempted = true;
		this.#remoteRetired = false;
		let markInstallSettled!: () => void;
		const installSettled = new Promise<void>((resolve) => {
			markInstallSettled = resolve;
		});
		this.#remoteInstallInFlight = installSettled;
		try {
			await this.#port.installAuthority(this.grant, currentLease);
		} finally {
			markInstallSettled();
			if (this.#remoteInstallInFlight === installSettled) this.#remoteInstallInFlight = null;
		}
	}

	private activate(): void {
		this.throwIfLocallyRevoked();
		this.#phase = "active";
	}

	private assertActive(): void {
		if (this.#phase === "active") return;
		this.throwIfLocallyRevoked();
		throw new Error("Runtime authority session is not active");
	}

	private assertLocallyLive(): void {
		this.#monitor.assert(this.workspaceReadRequest());
	}

	private workspaceReadRequest(): RuntimeAuthorityRequest {
		return runtimeAuthorityRequest(this.grant, {
			action: "workspace_read",
			resource: "workspace",
		});
	}

	private workspaceWriteRequest(): RuntimeAuthorityRequest {
		return runtimeAuthorityRequest(this.grant, {
			action: "workspace_write",
			resource: "workspace",
		});
	}

	private throwIfLocallyRevoked(): void {
		if (!this.signal.aborted) return;
		throw new RuntimeAuthorityDeniedError(this.abortReason());
	}

	private abortReason(): RuntimeAuthorityDenyCode {
		const parsed = runtimeAuthorityDenyCodeSchema.safeParse(this.signal.reason);
		return parsed.success ? parsed.data : "revoked";
	}

	private authorityFailure(error: unknown): unknown {
		if (!this.signal.aborted) return error;
		if (error === this.signal.reason || isAbortError(error)) {
			return new RuntimeAuthorityDeniedError(this.abortReason());
		}
		return error;
	}

	private async failAfterRetirement(failure: unknown): Promise<never> {
		if (failure instanceof RuntimeAuthorityRetirementError) throw failure;
		try {
			await this.retireRemote();
		} catch (retirementError) {
			throw new RuntimeAuthorityRetirementError(retirementError, failure);
		}
		throw failure;
	}

	private async retireRemote(): Promise<void> {
		if (!this.#remoteInstallAttempted || this.#remoteRetired) return;
		if (this.#remoteRetirement !== null) return this.#remoteRetirement;
		const installation = this.#remoteInstallInFlight;
		const retirement = (async () => {
			await installation?.catch(() => undefined);
			if (this.#remoteRetired) return;
			await this.#port.revokeAuthority(this.grant, this.abortReason());
			this.#remoteRetired = true;
		})();
		this.#remoteRetirement = retirement;
		try {
			await retirement;
		} finally {
			if (this.#remoteRetirement === retirement) this.#remoteRetirement = null;
		}
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

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}
