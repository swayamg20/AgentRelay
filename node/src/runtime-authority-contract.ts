import { createHash } from "node:crypto";
import { artifactTypeSchema, deliveryLeaseAuthoritySchema } from "@agentrelay/protocol";
import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const activeFencingTokenSchema = deliveryLeaseAuthoritySchema.shape.fencing_token;
const positiveLimitSchema = z.number().int().safe().positive();

export const RUNTIME_AUTHORITY_PRODUCT_POLICY_VERSION = 1;

export const runtimeActionSchema = z.enum([
	"runtime_start",
	"runtime_recover",
	"runtime_cancel",
	"workspace_read",
	"workspace_write",
	"verification_execute",
	"usage_report",
	"artifact_publish",
	"outbound_publish",
	"repository_push",
	"repository_merge",
	"package_publish",
	"deploy",
	"network_access",
	"secret_read",
	"privilege_expand",
]);

export const runtimeResourceSchema = z.enum([
	"runtime",
	"workspace",
	"verification_command",
	"usage",
	"artifact",
	"relay",
	"repository",
	"package",
	"deployment",
	"network",
	"secret",
	"privilege",
]);

export const runtimeCapabilitySchema = z
	.object({ action: runtimeActionSchema, resource: runtimeResourceSchema })
	.strict();

export interface RuntimeAuthorityLimits {
	readonly turn_ms: number;
	readonly reported_tokens: number;
	readonly output_bytes: number;
	readonly artifact_count: number;
	readonly artifact_bytes: number;
	readonly artifact_types: readonly string[];
}

export const runtimeAuthorityLimitsSchema: z.ZodType<RuntimeAuthorityLimits> = z
	.object({
		turn_ms: positiveLimitSchema,
		reported_tokens: positiveLimitSchema,
		output_bytes: positiveLimitSchema,
		artifact_count: positiveLimitSchema,
		artifact_bytes: positiveLimitSchema,
		artifact_types: z.array(artifactTypeSchema).max(32),
	})
	.strict()
	.transform((limits): RuntimeAuthorityLimits => immutableLimits(limits));

const runtimeAuthorityScopeSchema = z
	.object({
		grant_id: z.string().uuid(),
		agent_id: z.string().uuid(),
		node_id: z.string().uuid(),
		workspace_binding_id: z.string().uuid(),
		workspace_alias: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
		workspace_resource_sha256: sha256Schema,
		mission_id: z.string().uuid(),
		delivery_id: z.string().uuid(),
		execution_attempt: z.number().int().safe().positive(),
		lease_id: z.string().uuid(),
		fencing_token: activeFencingTokenSchema,
		policy_profile: z.string().min(1).max(64),
		policy_grant_sha256: sha256Schema,
	})
	.strict();

const runtimeAuthorityGrantObjectSchema = runtimeAuthorityScopeSchema
	.extend({
		schema_version: z.literal(1),
		product_policy_version: z.literal(RUNTIME_AUTHORITY_PRODUCT_POLICY_VERSION),
		lease_expires_at: z.string().datetime({ offset: true }),
		hard_expires_at: z.string().datetime({ offset: true }),
		capabilities: z.array(runtimeCapabilitySchema).max(32),
		limit_sources: z
			.object({
				product: runtimeAuthorityLimitsSchema,
				local: runtimeAuthorityLimitsSchema,
				mission: runtimeAuthorityLimitsSchema,
				runtime: runtimeAuthorityLimitsSchema,
			})
			.strict(),
	})
	.strict();

const runtimeAuthorityGrantInputSchema =
	runtimeAuthorityGrantObjectSchema.superRefine(validateGrantCapabilities);

export const runtimeAuthorityGrantSchema = runtimeAuthorityGrantObjectSchema
	.extend({ effective_limits: runtimeAuthorityLimitsSchema })
	.strict()
	.superRefine((grant, ctx) => {
		validateGrantCapabilities(grant, ctx);
		if (
			canonicalJson(intersectLimits(grant.limit_sources)) !== canonicalJson(grant.effective_limits)
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Effective authority limits do not match their four policy sources",
				path: ["effective_limits"],
			});
		}
	});

export const runtimeAuthorityRenewalSchema = z
	.object({
		grant_id: runtimeAuthorityScopeSchema.shape.grant_id,
		lease_id: runtimeAuthorityScopeSchema.shape.lease_id,
		fencing_token: activeFencingTokenSchema,
		lease_expires_at: z.string().datetime({ offset: true }),
	})
	.strict();

const runtimeAuthorityMeasurementSchema = z
	.object({
		reported_tokens: z.number().int().safe().nonnegative().optional(),
		output_bytes: z.number().int().safe().nonnegative().optional(),
		artifact_count: z.number().int().safe().nonnegative().optional(),
		artifact_bytes: z.number().int().safe().nonnegative().optional(),
		artifact_type: artifactTypeSchema.optional(),
	})
	.strict();

export const runtimeAuthorityRequestSchema = runtimeAuthorityScopeSchema
	.extend({
		capability: runtimeCapabilitySchema,
		measurement: runtimeAuthorityMeasurementSchema.optional(),
	})
	.strict();

export const runtimeAuthorityDenyCodeSchema = z.enum([
	"invalid_request",
	"wrong_grant",
	"wrong_agent",
	"wrong_node",
	"wrong_workspace",
	"wrong_resource",
	"wrong_mission",
	"wrong_delivery",
	"wrong_attempt",
	"wrong_lease",
	"stale_fence",
	"policy_changed",
	"expired",
	"revoked",
	"capability_missing",
	"budget_exceeded",
	"product_denied",
]);

export const runtimeAuthorityEvidenceSchema = z
	.object({
		schema_version: z.literal(1),
		decision_id: z.string().uuid(),
		recorded_at: z.string().datetime({ offset: true }),
		grant_id: z.string().uuid(),
		grant_sha256: sha256Schema,
		agent_id: z.string().uuid(),
		node_id: z.string().uuid(),
		workspace_alias: runtimeAuthorityScopeSchema.shape.workspace_alias,
		mission_id: z.string().uuid(),
		delivery_id: z.string().uuid(),
		execution_attempt: z.number().int().safe().positive(),
		fencing_token: activeFencingTokenSchema,
		action: z.union([runtimeActionSchema, z.literal("unknown")]),
		resource: z.union([runtimeResourceSchema, z.literal("unknown")]),
		decision: z.enum(["allow", "deny"]),
		code: z.union([z.literal("allowed"), runtimeAuthorityDenyCodeSchema]),
	})
	.strict();

export type RuntimeAction = z.infer<typeof runtimeActionSchema>;
export type RuntimeResource = z.infer<typeof runtimeResourceSchema>;
export type RuntimeCapability = z.infer<typeof runtimeCapabilitySchema>;
export type RuntimeAuthorityGrant = z.infer<typeof runtimeAuthorityGrantSchema>;
export type RuntimeAuthorityRenewal = z.infer<typeof runtimeAuthorityRenewalSchema>;
export type RuntimeAuthorityRequest = z.infer<typeof runtimeAuthorityRequestSchema>;
export type RuntimeAuthorityDenyCode = z.infer<typeof runtimeAuthorityDenyCodeSchema>;
export type RuntimeAuthorityEvidence = z.infer<typeof runtimeAuthorityEvidenceSchema>;

const PRODUCT_DENIED_ACTIONS = new Set<RuntimeAction>([
	"repository_push",
	"repository_merge",
	"package_publish",
	"deploy",
	"network_access",
	"secret_read",
	"privilege_expand",
]);

const ACTION_RESOURCES: Readonly<Record<RuntimeAction, RuntimeResource>> = Object.freeze({
	runtime_start: "runtime",
	runtime_recover: "runtime",
	runtime_cancel: "runtime",
	workspace_read: "workspace",
	workspace_write: "workspace",
	verification_execute: "verification_command",
	usage_report: "usage",
	artifact_publish: "artifact",
	outbound_publish: "relay",
	repository_push: "repository",
	repository_merge: "repository",
	package_publish: "package",
	deploy: "deployment",
	network_access: "network",
	secret_read: "secret",
	privilege_expand: "privilege",
});

export function compileRuntimeAuthorityGrant(
	input: z.input<typeof runtimeAuthorityGrantInputSchema>,
): RuntimeAuthorityGrant {
	const parsed = runtimeAuthorityGrantInputSchema.parse(input);
	return parseRuntimeAuthorityGrant({
		...parsed,
		effective_limits: intersectLimits(parsed.limit_sources),
	});
}

export function parseRuntimeAuthorityGrant(value: unknown): RuntimeAuthorityGrant {
	return immutableGrant(runtimeAuthorityGrantSchema.parse(value));
}

export function runtimeAuthorityRequest(
	grant: RuntimeAuthorityGrant,
	capability: RuntimeCapability,
	measurement?: z.input<typeof runtimeAuthorityMeasurementSchema>,
): RuntimeAuthorityRequest {
	return runtimeAuthorityRequestSchema.parse({
		...scopeFromGrant(grant),
		capability,
		...(measurement === undefined ? {} : { measurement }),
	});
}

export function runtimeAuthorityGrantSha256(grant: RuntimeAuthorityGrant): string {
	return createHash("sha256").update(canonicalJson(grant), "utf8").digest("hex");
}

export function isProductDeniedAction(action: RuntimeAction): boolean {
	return PRODUCT_DENIED_ACTIONS.has(action);
}

export function expectedRuntimeResource(action: RuntimeAction): RuntimeResource {
	return ACTION_RESOURCES[action];
}

export function sameRuntimeCapability(left: RuntimeCapability, right: RuntimeCapability): boolean {
	return left.action === right.action && left.resource === right.resource;
}

function intersectLimits(sources: {
	readonly product: RuntimeAuthorityLimits;
	readonly local: RuntimeAuthorityLimits;
	readonly mission: RuntimeAuthorityLimits;
	readonly runtime: RuntimeAuthorityLimits;
}): RuntimeAuthorityLimits {
	const values = Object.values(sources);
	const artifactTypes = values
		.map((source) => source.artifact_types)
		.reduce((current, source) => current.filter((type) => source.includes(type)));
	return immutableLimits({
		turn_ms: Math.min(...values.map((source) => source.turn_ms)),
		reported_tokens: Math.min(...values.map((source) => source.reported_tokens)),
		output_bytes: Math.min(...values.map((source) => source.output_bytes)),
		artifact_count: Math.min(...values.map((source) => source.artifact_count)),
		artifact_bytes: Math.min(...values.map((source) => source.artifact_bytes)),
		artifact_types: [...new Set(artifactTypes)].sort(),
	});
}

function immutableLimits(limits: RuntimeAuthorityLimits): RuntimeAuthorityLimits {
	return Object.freeze({ ...limits, artifact_types: Object.freeze([...limits.artifact_types]) });
}

function immutableGrant(grant: RuntimeAuthorityGrant): RuntimeAuthorityGrant {
	return Object.freeze({
		...grant,
		capabilities: Object.freeze(grant.capabilities.map((item) => Object.freeze({ ...item }))),
		limit_sources: Object.freeze({ ...grant.limit_sources }),
		effective_limits: immutableLimits(grant.effective_limits),
	}) as unknown as RuntimeAuthorityGrant;
}

function scopeFromGrant(grant: RuntimeAuthorityGrant) {
	return {
		grant_id: grant.grant_id,
		agent_id: grant.agent_id,
		node_id: grant.node_id,
		workspace_binding_id: grant.workspace_binding_id,
		workspace_alias: grant.workspace_alias,
		workspace_resource_sha256: grant.workspace_resource_sha256,
		mission_id: grant.mission_id,
		delivery_id: grant.delivery_id,
		execution_attempt: grant.execution_attempt,
		lease_id: grant.lease_id,
		fencing_token: grant.fencing_token,
		policy_profile: grant.policy_profile,
		policy_grant_sha256: grant.policy_grant_sha256,
	};
}

function capabilityKey(capability: RuntimeCapability): string {
	return `${capability.action}:${capability.resource}`;
}

function validateGrantCapabilities(
	grant: { readonly capabilities: readonly RuntimeCapability[] },
	ctx: z.RefinementCtx,
): void {
	const unique = new Set(grant.capabilities.map(capabilityKey));
	if (unique.size !== grant.capabilities.length) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Runtime capabilities must be unique",
			path: ["capabilities"],
		});
	}
	for (const [index, capability] of grant.capabilities.entries()) {
		if (capability.resource === expectedRuntimeResource(capability.action)) continue;
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Runtime capability action and resource do not match",
			path: ["capabilities", index, "resource"],
		});
	}
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
