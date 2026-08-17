import type { RuntimeAuthorityPort } from "./runtime-authority-port.js";
import {
	LocalReferenceMonitor,
	RuntimeAuthorityDeniedError,
	type RuntimeAuthorityDenyCode,
	type RuntimeAuthorityEvidenceSink,
	type RuntimeAuthorityGrant,
	type RuntimeAuthorityRenewal,
	type RuntimeAuthorityRequest,
} from "./runtime-authority.js";

export interface NodeRuntimeAuthoritySessionOptions {
	readonly port: RuntimeAuthorityPort;
	readonly grant: RuntimeAuthorityGrant;
	readonly currentLease: RuntimeAuthorityRenewal;
	readonly evidenceSink: RuntimeAuthorityEvidenceSink;
	readonly now?: () => Date;
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
		const session = new NodeRuntimeAuthoritySession(options);
		try {
			await options.port.installAuthority(options.grant, options.currentLease);
			return session;
		} catch (error) {
			session.#monitor.revoke(denialReason(error));
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
		this.#monitor.signal.throwIfAborted();
		try {
			await this.#port.renewAuthority(this.grant.mission_id, renewal);
		} catch (error) {
			this.#monitor.revoke(denialReason(error));
			throw error;
		}

		try {
			this.#monitor.renew(renewal);
		} catch (error) {
			this.#monitor.revoke(denialReason(error));
			await this.revokeRemote(denialReason(error));
			throw error;
		}
	}

	async revoke(reason: RuntimeAuthorityDenyCode = "revoked"): Promise<void> {
		this.revokeLocal(reason);
		await this.#port.revokeAuthority(this.grant.mission_id, this.grant.grant_id, reason);
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
		await this.#port
			.revokeAuthority(this.grant.mission_id, this.grant.grant_id, reason)
			.catch(() => undefined);
	}
}

function denialReason(error: unknown): RuntimeAuthorityDenyCode {
	return error instanceof RuntimeAuthorityDeniedError ? error.code : "revoked";
}
