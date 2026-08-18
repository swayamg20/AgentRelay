import { randomUUID } from "node:crypto";
import {
	type RuntimeAuthorityDenyCode,
	type RuntimeAuthorityEvidence,
	type RuntimeAuthorityGrant,
	type RuntimeAuthorityLimits,
	type RuntimeAuthorityRenewal,
	type RuntimeAuthorityRequest,
	expectedRuntimeResource,
	isProductDeniedAction,
	parseRuntimeAuthorityGrant,
	runtimeAuthorityEvidenceSchema,
	runtimeAuthorityGrantSha256,
	runtimeAuthorityRenewalSchema,
	runtimeAuthorityRequestSchema,
	sameRuntimeCapability,
} from "./runtime-authority-contract.js";

export * from "./runtime-authority-contract.js";

export interface RuntimeAuthorityEvidenceSink {
	record(evidence: RuntimeAuthorityEvidence): void | Promise<void>;
}

/** One live, scoped reference-monitor boundary for a concrete workspace read effect. */
export interface RuntimeWorkspaceReadAuthority {
	readonly grant: RuntimeAuthorityGrant;
	readonly signal: AbortSignal;
	performWorkspaceRead<T>(effect: () => T | Promise<T>): Promise<T>;
}

export class RuntimeAuthorityDeniedError extends Error {
	constructor(readonly code: RuntimeAuthorityDenyCode) {
		super(`Runtime authority denied: ${code}`);
		this.name = "RuntimeAuthorityDeniedError";
	}
}

/** A local, non-model reference monitor for one fenced delivery attempt. */
export class LocalReferenceMonitor {
	readonly #grant: RuntimeAuthorityGrant;
	readonly #evidenceSink: RuntimeAuthorityEvidenceSink;
	readonly #now: () => Date;
	readonly #abort = new AbortController();
	#leaseExpiresAt: string;
	#revoked: RuntimeAuthorityDenyCode | null = null;
	#expiryTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		grantValue: RuntimeAuthorityGrant,
		evidenceSink: RuntimeAuthorityEvidenceSink,
		options: {
			readonly now?: () => Date;
			readonly currentLease?: RuntimeAuthorityRenewal;
		} = {},
	) {
		this.#grant = parseRuntimeAuthorityGrant(grantValue);
		this.#leaseExpiresAt = this.#grant.lease_expires_at;
		this.#evidenceSink = evidenceSink;
		this.#now = options.now ?? (() => new Date());
		if (options.currentLease !== undefined) {
			this.#leaseExpiresAt = advanceRuntimeAuthorityLease(
				this.#grant,
				this.#leaseExpiresAt,
				options.currentLease,
			);
		}
		this.armExpiry();
	}

	get grant(): RuntimeAuthorityGrant {
		return this.#grant;
	}

	get effectiveLimits(): RuntimeAuthorityLimits {
		return this.#grant.effective_limits;
	}

	get signal(): AbortSignal {
		return this.#abort.signal;
	}

	renew(value: RuntimeAuthorityRenewal): void {
		this.assertLive();
		const nextExpiry = advanceRuntimeAuthorityLease(this.#grant, this.#leaseExpiresAt, value);
		if (Date.parse(nextExpiry) === Date.parse(this.#leaseExpiresAt)) return;
		this.#leaseExpiresAt = nextExpiry;
		this.armExpiry();
	}

	revoke(reason: RuntimeAuthorityDenyCode = "revoked"): void {
		if (this.#revoked !== null) return;
		this.#revoked = reason;
		if (this.#expiryTimer !== null) clearTimeout(this.#expiryTimer);
		this.#expiryTimer = null;
		this.#abort.abort(reason);
	}

	assert(value: unknown): Readonly<{ decision: "allow"; code: "allowed" }> {
		this.assertLive();
		const parsed = runtimeAuthorityRequestSchema.safeParse(value);
		if (!parsed.success) this.deny("invalid_request");
		const request = parsed.data;
		this.assertScope(request);
		if (request.capability.resource !== expectedRuntimeResource(request.capability.action)) {
			this.deny("wrong_resource");
		}
		if (isProductDeniedAction(request.capability.action)) this.deny("product_denied");
		if (!this.#grant.capabilities.some((item) => sameRuntimeCapability(item, request.capability))) {
			this.deny("capability_missing");
		}
		this.assertMeasurement(request);
		return Object.freeze({ decision: "allow", code: "allowed" });
	}

	async perform<T>(request: unknown, effect: () => T | Promise<T>): Promise<T> {
		let decision: Readonly<{ decision: "allow"; code: "allowed" }>;
		try {
			decision = this.assert(request);
		} catch (error) {
			if (error instanceof RuntimeAuthorityDeniedError) {
				await this.recordEvidence(request, "deny", error.code).catch(() => undefined);
			}
			throw error;
		}
		await this.recordEvidence(request, decision.decision, decision.code);
		this.assert(request);
		return effect();
	}

	private assertScope(request: RuntimeAuthorityRequest): void {
		const grant = this.#grant;
		if (request.grant_id !== grant.grant_id) this.deny("wrong_grant");
		if (request.agent_id !== grant.agent_id) this.deny("wrong_agent");
		if (request.node_id !== grant.node_id) this.deny("wrong_node");
		if (
			request.workspace_binding_id !== grant.workspace_binding_id ||
			request.workspace_alias !== grant.workspace_alias
		) {
			this.deny("wrong_workspace");
		}
		if (request.workspace_resource_sha256 !== grant.workspace_resource_sha256) {
			this.deny("wrong_resource");
		}
		if (request.mission_id !== grant.mission_id) this.deny("wrong_mission");
		if (request.delivery_id !== grant.delivery_id) this.deny("wrong_delivery");
		if (request.execution_attempt !== grant.execution_attempt) this.deny("wrong_attempt");
		if (request.lease_id !== grant.lease_id) this.deny("wrong_lease");
		if (request.fencing_token !== grant.fencing_token) this.deny("stale_fence");
		if (
			request.policy_profile !== grant.policy_profile ||
			request.policy_grant_sha256 !== grant.policy_grant_sha256
		) {
			this.deny("policy_changed");
		}
	}

	private assertMeasurement(request: RuntimeAuthorityRequest): void {
		const measurement = request.measurement;
		const action = request.capability.action;
		if (action === "usage_report" && measurement?.reported_tokens === undefined) {
			this.deny("invalid_request");
		}
		if (
			action === "artifact_publish" &&
			(measurement?.artifact_count === undefined ||
				measurement.artifact_bytes === undefined ||
				measurement.artifact_type === undefined)
		) {
			this.deny("invalid_request");
		}
		if (action === "outbound_publish" && measurement?.output_bytes === undefined) {
			this.deny("invalid_request");
		}
		if (measurement === undefined) return;
		if (
			action !== "usage_report" &&
			action !== "artifact_publish" &&
			action !== "outbound_publish"
		) {
			this.deny("invalid_request");
		}
		const limits = this.#grant.effective_limits;
		if (
			(measurement.reported_tokens ?? 0) > limits.reported_tokens ||
			(measurement.output_bytes ?? 0) > limits.output_bytes ||
			(measurement.artifact_count ?? 0) > limits.artifact_count ||
			(measurement.artifact_bytes ?? 0) > limits.artifact_bytes ||
			(measurement.artifact_type !== undefined &&
				!limits.artifact_types.includes(measurement.artifact_type))
		) {
			this.deny("budget_exceeded");
		}
	}

	private assertLive(): void {
		if (this.#revoked !== null) this.deny(this.#revoked);
		const now = this.#now().getTime();
		if (
			!Number.isFinite(now) ||
			now >= Date.parse(this.#leaseExpiresAt) ||
			now >= Date.parse(this.#grant.hard_expires_at)
		) {
			this.revoke("expired");
			this.deny("expired");
		}
	}

	private deny(code: RuntimeAuthorityDenyCode): never {
		throw new RuntimeAuthorityDeniedError(code);
	}

	private async recordEvidence(
		requestValue: unknown,
		decision: "allow" | "deny",
		code: "allowed" | RuntimeAuthorityDenyCode,
	): Promise<void> {
		const parsed = runtimeAuthorityRequestSchema.safeParse(requestValue);
		const capability = parsed.success
			? parsed.data.capability
			: { action: "unknown" as const, resource: "unknown" as const };
		await this.#evidenceSink.record(
			runtimeAuthorityEvidenceSchema.parse({
				schema_version: 1,
				decision_id: randomUUID(),
				recorded_at: this.#now().toISOString(),
				grant_id: this.#grant.grant_id,
				grant_sha256: runtimeAuthorityGrantSha256(this.#grant),
				agent_id: this.#grant.agent_id,
				node_id: this.#grant.node_id,
				workspace_alias: this.#grant.workspace_alias,
				mission_id: this.#grant.mission_id,
				delivery_id: this.#grant.delivery_id,
				execution_attempt: this.#grant.execution_attempt,
				fencing_token: this.#grant.fencing_token,
				action: capability.action,
				resource: capability.resource,
				decision,
				code,
			}),
		);
	}

	private armExpiry(): void {
		if (this.#expiryTimer !== null) clearTimeout(this.#expiryTimer);
		if (this.#revoked !== null) return;
		const deadline = Math.min(
			Date.parse(this.#leaseExpiresAt),
			Date.parse(this.#grant.hard_expires_at),
		);
		const remaining = deadline - this.#now().getTime();
		if (!Number.isFinite(remaining) || remaining <= 0) {
			this.revoke("expired");
			return;
		}
		this.#expiryTimer = setTimeout(() => this.armExpiry(), Math.min(remaining, 2_147_483_647));
		this.#expiryTimer.unref?.();
	}
}

export function advanceRuntimeAuthorityLease(
	grant: RuntimeAuthorityGrant,
	currentExpiry: string,
	value: RuntimeAuthorityRenewal,
): string {
	const parsed = runtimeAuthorityRenewalSchema.safeParse(value);
	if (!parsed.success) throw new RuntimeAuthorityDeniedError("invalid_request");
	const renewal = parsed.data;
	if (renewal.grant_id !== grant.grant_id) throw new RuntimeAuthorityDeniedError("wrong_grant");
	if (renewal.lease_id !== grant.lease_id) throw new RuntimeAuthorityDeniedError("wrong_lease");
	if (renewal.fencing_token !== grant.fencing_token) {
		throw new RuntimeAuthorityDeniedError("stale_fence");
	}
	if (Date.parse(renewal.lease_expires_at) < Date.parse(currentExpiry)) {
		throw new RuntimeAuthorityDeniedError("expired");
	}
	return renewal.lease_expires_at;
}
