import type {
	RuntimeAuthorityDenyCode,
	RuntimeAuthorityGrant,
	RuntimeAuthorityRenewal,
	RuntimeAuthorityRequest,
} from "./runtime-authority.js";

/** Private Node-to-runtime authority control plane; never exposed to a model or peer. */
export interface RuntimeAuthorityPort {
	installAuthority(
		grant: RuntimeAuthorityGrant,
		currentLease: RuntimeAuthorityRenewal,
	): Promise<void>;
	/**
	 * Remote preflight for one exact action. Callers must also keep the effect
	 * inside a local reference-monitor operation; this check alone is not a fence.
	 */
	assertAuthority(request: RuntimeAuthorityRequest): Promise<void>;
	renewAuthority(missionId: string, renewal: RuntimeAuthorityRenewal): Promise<void>;
	revokeAuthority(
		missionId: string,
		grantId: string,
		reason: RuntimeAuthorityDenyCode,
	): Promise<void>;
}
