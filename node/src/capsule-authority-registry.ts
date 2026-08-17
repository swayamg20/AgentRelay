import type { RuntimeAuthorityGrant, RuntimeAuthorityRenewal } from "./runtime-authority.js";

export interface CachedCapsuleAuthority {
	readonly acceptedInstallSha256: string;
	readonly grant: RuntimeAuthorityGrant;
	readonly currentLease: RuntimeAuthorityRenewal;
	readonly status: "active" | "revoking" | "revoked";
}

/** Serializes and retains the authority lifecycle for each local Mission Capsule. */
export class CapsuleAuthorityRegistry {
	readonly #authorities = new Map<string, CachedCapsuleAuthority>();
	readonly #revokedGrantIds = new Map<string, Set<string>>();
	readonly #transitions = new Map<string, Promise<void>>();

	get(missionId: string): CachedCapsuleAuthority | undefined {
		return this.#authorities.get(missionId);
	}

	isRevoked(missionId: string, grantId: string): boolean {
		return this.#revokedGrantIds.get(missionId)?.has(grantId) ?? false;
	}

	activate(value: Omit<CachedCapsuleAuthority, "status">): CachedCapsuleAuthority {
		const authority = { ...value, status: "active" as const };
		this.#authorities.set(value.grant.mission_id, authority);
		return authority;
	}

	renew(
		authority: CachedCapsuleAuthority,
		currentLease: RuntimeAuthorityRenewal,
	): CachedCapsuleAuthority {
		return this.replace(authority, { ...authority, currentLease });
	}

	markRevoking(authority: CachedCapsuleAuthority): CachedCapsuleAuthority {
		return this.replace(authority, { ...authority, status: "revoking" });
	}

	markRevoked(authority: CachedCapsuleAuthority): CachedCapsuleAuthority {
		const revoked = this.replace(authority, { ...authority, status: "revoked" });
		let grantIds = this.#revokedGrantIds.get(authority.grant.mission_id);
		if (grantIds === undefined) {
			grantIds = new Set<string>();
			this.#revokedGrantIds.set(authority.grant.mission_id, grantIds);
		}
		grantIds.add(authority.grant.grant_id);
		return revoked;
	}

	async runTransition<T>(missionId: string, operation: () => T | Promise<T>): Promise<T> {
		const previous = this.#transitions.get(missionId);
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.#transitions.set(missionId, current);
		if (previous !== undefined) await previous;
		try {
			return await operation();
		} finally {
			release();
			if (this.#transitions.get(missionId) === current) this.#transitions.delete(missionId);
		}
	}

	private replace(
		current: CachedCapsuleAuthority,
		next: CachedCapsuleAuthority,
	): CachedCapsuleAuthority {
		const missionId = current.grant.mission_id;
		if (this.#authorities.get(missionId) !== current) {
			throw new Error("Capsule authority changed outside its Mission transition");
		}
		this.#authorities.set(missionId, next);
		return next;
	}
}
