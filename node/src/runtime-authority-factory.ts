import { createHash } from "node:crypto";
import {
	type AdapterInfo,
	DEFAULT_HOST_EVENT_STREAM_POLICY,
	type Delivery,
	type NodeMissionAssignment,
} from "@agentrelay/protocol";
import type { ResolvedPolicyProfile } from "./policy.js";
import {
	type RuntimeAuthorityGrant,
	type RuntimeAuthorityLimits,
	compileRuntimeAuthorityGrant,
} from "./runtime-authority.js";
import type { WorkspacePreflightResult } from "./workspace.js";

export interface RuntimeAuthorityGrantInput {
	readonly assignment: NodeMissionAssignment;
	readonly delivery: Delivery;
	readonly executionAttempt: number;
	readonly nodeId: string;
	readonly workspaceAlias: string;
	readonly workspace: WorkspacePreflightResult;
	readonly policy: ResolvedPolicyProfile;
	readonly adapter: AdapterInfo;
	readonly now: Date;
	/** Latest trusted Relay lease deadline; omitted when compiling a fresh grant. */
	readonly currentLeaseExpiresAt?: string;
}

/** Compiles one private, locally bounded grant after Relay and workspace authorization. */
export function createRuntimeAuthorityGrant(
	input: RuntimeAuthorityGrantInput,
): RuntimeAuthorityGrant {
	const lease = input.delivery.lease;
	if (input.delivery.status !== "executing" || lease === null) {
		throw new Error("Runtime authority requires a fresh executing delivery lease");
	}
	if (!Number.isFinite(input.now.getTime())) throw new Error("Runtime authority time is invalid");
	if (Date.parse(input.currentLeaseExpiresAt ?? lease.expires_at) <= input.now.getTime()) {
		throw new Error("Runtime authority lease has expired before activation");
	}
	if (
		input.delivery.node_id !== input.nodeId ||
		input.delivery.mission_id !== input.assignment.mission_id
	) {
		throw new Error("Runtime authority identity does not match the executable delivery");
	}

	const manifest = input.assignment.coordinator_config.mission_context.manifest;
	const product = authorityLimits({
		turnMs: 86_400_000,
		reportedTokens: DEFAULT_HOST_EVENT_STREAM_POLICY.maxTokens,
		artifactTypes: manifest.allowed_artifact_types,
	});
	const local = authorityLimits({
		turnMs: input.policy.profile.max_turn_seconds * 1_000,
		reportedTokens: input.policy.profile.max_reported_tokens,
		artifactTypes: manifest.allowed_artifact_types,
	});
	const mission = authorityLimits({
		turnMs: manifest.max_wall_time_seconds * 1_000,
		reportedTokens: manifest.token_budget,
		artifactTypes: manifest.allowed_artifact_types,
	});
	const runtime = authorityLimits({ artifactTypes: manifest.allowed_artifact_types });
	const hardExpiresAt = Math.min(
		Date.parse(manifest.expires_at),
		Date.parse(manifest.created_at) + manifest.max_wall_time_seconds * 1_000,
	);
	if (!Number.isFinite(hardExpiresAt) || hardExpiresAt <= input.now.getTime()) {
		throw new Error("Mission authority has expired before runtime activation");
	}

	const workspaceResourceSha256 = sha256(
		canonicalJson({
			workspace_binding_id: input.assignment.workspace_binding_id,
			workspace_alias: input.workspaceAlias,
			root: input.workspace.root,
			repository_url: input.workspace.repository_url,
			head_commit: input.workspace.head_commit,
			reachable_from_ref: input.workspace.reachable_from_ref,
		}),
	);
	const grantIdentity = canonicalJson({
		mission_id: input.assignment.mission_id,
		delivery_id: input.delivery.delivery_id,
		execution_attempt: input.executionAttempt,
		lease_id: lease.lease_id,
		fencing_token: lease.fencing_token,
		policy_grant_sha256: input.policy.grant.grant_sha256,
		workspace_resource_sha256: workspaceResourceSha256,
	});

	return compileRuntimeAuthorityGrant({
		schema_version: 1,
		product_policy_version: 1,
		grant_id: deterministicUuid(grantIdentity),
		agent_id: input.assignment.participant_agent_id,
		node_id: input.nodeId,
		workspace_binding_id: input.assignment.workspace_binding_id,
		workspace_alias: input.workspaceAlias,
		workspace_resource_sha256: workspaceResourceSha256,
		mission_id: input.assignment.mission_id,
		delivery_id: input.delivery.delivery_id,
		execution_attempt: input.executionAttempt,
		lease_id: lease.lease_id,
		fencing_token: lease.fencing_token,
		policy_profile: input.policy.name,
		policy_grant_sha256: input.policy.grant.grant_sha256,
		lease_expires_at: lease.expires_at,
		hard_expires_at: new Date(hardExpiresAt).toISOString(),
		capabilities: [
			{ action: "runtime_start", resource: "runtime" },
			...(input.adapter.capabilities.recovery
				? ([{ action: "runtime_recover", resource: "runtime" }] as const)
				: []),
			...(input.adapter.capabilities.cancellation
				? ([{ action: "runtime_cancel", resource: "runtime" }] as const)
				: []),
			{ action: "workspace_read", resource: "workspace" },
			{ action: "usage_report", resource: "usage" },
			{ action: "artifact_publish", resource: "artifact" },
			{ action: "outbound_publish", resource: "relay" },
		],
		limit_sources: { product, local, mission, runtime },
	});
}

function authorityLimits(
	overrides: Readonly<{
		turnMs?: number;
		reportedTokens?: number;
		artifactTypes: readonly string[];
	}>,
): RuntimeAuthorityLimits {
	return {
		turn_ms: overrides.turnMs ?? 86_400_000,
		reported_tokens: overrides.reportedTokens ?? DEFAULT_HOST_EVENT_STREAM_POLICY.maxTokens,
		output_bytes: DEFAULT_HOST_EVENT_STREAM_POLICY.maxOutputBytes,
		artifact_count: DEFAULT_HOST_EVENT_STREAM_POLICY.maxArtifacts,
		artifact_bytes: DEFAULT_HOST_EVENT_STREAM_POLICY.maxArtifactBytes,
		artifact_types: [...overrides.artifactTypes],
	};
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function deterministicUuid(value: string): string {
	const bytes = Buffer.from(sha256(value).slice(0, 32), "hex");
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
		.join(",")}}`;
}
