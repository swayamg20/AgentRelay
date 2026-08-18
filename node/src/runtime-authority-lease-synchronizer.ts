import type { DeliveryLease } from "@agentrelay/protocol";
import type { NodeRuntimeAuthoritySession } from "./runtime-authority-session.js";

/** Buffers and serializes Relay lease updates across runtime authority installation. */
export class RuntimeAuthorityLeaseSynchronizer {
	#session: NodeRuntimeAuthoritySession | null = null;
	#pending: DeliveryLease | null = null;
	#bound = false;
	#tail = Promise.resolve();

	async bind(session: NodeRuntimeAuthoritySession | null): Promise<void> {
		if (this.#bound) throw new Error("Runtime authority lease synchronizer is already bound");
		this.#bound = true;
		this.#session = session;
		if (session === null || this.#pending === null) {
			this.#pending = null;
			return;
		}
		const pending = this.#pending;
		this.#pending = null;
		await this.forward(pending);
	}

	forward(lease: DeliveryLease): Promise<void> {
		if (!this.#bound) {
			this.#pending = structuredClone(lease);
			return Promise.resolve();
		}
		const session = this.#session;
		if (session === null) return Promise.resolve();
		const forwarding = this.#tail.then(async () => {
			try {
				await session.renew({
					grant_id: session.grant.grant_id,
					lease_id: lease.lease_id,
					fencing_token: lease.fencing_token,
					lease_expires_at: lease.expires_at,
				});
			} catch (error) {
				throw new RuntimeAuthoritySyncError(error);
			}
		});
		this.#tail = forwarding;
		return forwarding;
	}
}

export class RuntimeAuthoritySyncError extends Error {
	constructor(error: unknown) {
		const detail = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
		super(`Runtime lease renewal was not confirmed: ${detail}`);
		this.name = "RuntimeAuthoritySyncError";
	}
}
