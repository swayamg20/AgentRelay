import type { RuntimeAuthorityGrant, RuntimeAuthorityLimits } from "./runtime-authority.js";
import { compileRuntimeAuthorityGrant, runtimeAuthorityRequest } from "./runtime-authority.js";

export const AUTHORITY_IDS = {
	grant: "97000000-0000-4000-8000-000000000001",
	agent: "97000000-0000-4000-8000-000000000002",
	node: "97000000-0000-4000-8000-000000000003",
	binding: "97000000-0000-4000-8000-000000000004",
	mission: "97000000-0000-4000-8000-000000000005",
	delivery: "97000000-0000-4000-8000-000000000006",
	lease: "97000000-0000-4000-8000-000000000007",
} as const;

export const AUTHORITY_NOW = "2026-08-17T00:00:00.000Z";

const capabilities = [
	{ action: "runtime_start", resource: "runtime" },
	{ action: "runtime_recover", resource: "runtime" },
	{ action: "runtime_cancel", resource: "runtime" },
	{ action: "workspace_read", resource: "workspace" },
	{ action: "usage_report", resource: "usage" },
	{ action: "artifact_publish", resource: "artifact" },
	{ action: "outbound_publish", resource: "relay" },
] as const;

export function authorityLimits(
	overrides: Partial<RuntimeAuthorityLimits> = {},
): RuntimeAuthorityLimits {
	return {
		turn_ms: 60_000,
		reported_tokens: 10_000,
		output_bytes: 32_000,
		artifact_count: 8,
		artifact_bytes: 1_000_000,
		artifact_types: ["api_contract", "patch"],
		...overrides,
	};
}

export function authorityGrant(
	overrides: Partial<Parameters<typeof compileRuntimeAuthorityGrant>[0]> = {},
): RuntimeAuthorityGrant {
	return compileRuntimeAuthorityGrant({
		schema_version: 1,
		product_policy_version: 1,
		grant_id: AUTHORITY_IDS.grant,
		agent_id: AUTHORITY_IDS.agent,
		node_id: AUTHORITY_IDS.node,
		workspace_binding_id: AUTHORITY_IDS.binding,
		workspace_alias: "backend",
		workspace_resource_sha256: "a".repeat(64),
		mission_id: AUTHORITY_IDS.mission,
		delivery_id: AUTHORITY_IDS.delivery,
		execution_attempt: 1,
		lease_id: AUTHORITY_IDS.lease,
		fencing_token: "9007199254740993",
		policy_profile: "coding",
		policy_grant_sha256: "b".repeat(64),
		lease_expires_at: "2026-08-17T00:01:00.000Z",
		hard_expires_at: "2026-08-17T00:05:00.000Z",
		capabilities: [...capabilities],
		limit_sources: {
			product: authorityLimits(),
			local: authorityLimits(),
			mission: authorityLimits(),
			runtime: authorityLimits(),
		},
		...overrides,
	});
}

export function startRequest(grant = authorityGrant()) {
	return runtimeAuthorityRequest(grant, { action: "runtime_start", resource: "runtime" });
}
