import { z } from "zod";

const MAX_TEXT_LENGTH = 16_000;
const MAX_ACCEPTANCE_CRITERIA = 32;
const MAX_ARTIFACTS = 16;
const MAX_ARTIFACT_TYPES = 16;
const MAX_VERIFICATION_EVIDENCE = 16;
export const MAX_ARTIFACT_BYTES = 1_048_576;
const MAX_TURNS = 200;
const MAX_WALL_TIME_SECONDS = 7 * 24 * 60 * 60;
const MAX_TOKEN_BUDGET = 100_000_000;

const boundedTextSchema = z
	.string()
	.min(1)
	.max(MAX_TEXT_LENGTH)
	.refine((value) => value.trim().length > 0, "Text cannot be blank");
const acceptanceCriterionSchema = z
	.string()
	.min(1)
	.max(2_000)
	.refine((value) => value.trim().length > 0, "Acceptance criterion cannot be blank");
const identifierSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const aliasSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
	.refine((value) => value !== "." && value !== "..", "Alias cannot be a path segment");
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const baseCommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const repositoryRefSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
	.refine(
		(value) =>
			!value.includes("..") &&
			!value.includes("//") &&
			!value.endsWith("/") &&
			!value.endsWith(".") &&
			!value.endsWith(".lock"),
		"Repository ref is not a safe canonical ref name",
	);
function boundedOpaqueReferenceSchema(maxLength: number) {
	return z
		.string()
		.min(1)
		.max(maxLength)
		.refine(
			(value) =>
				[...value].every((character) => {
					const code = character.charCodeAt(0);
					return code > 0x1f && code !== 0x7f;
				}),
			"Reference cannot contain control characters",
		);
}

export const opaqueReferenceSchema = boundedOpaqueReferenceSchema(256);
const fencingTokenSchema = z
	.string()
	.regex(/^(?:0|[1-9][0-9]*)$/)
	.max(64);
export const uuidSchema = z
	.string()
	.uuid()
	.refine((value) => value === value.toLowerCase(), "UUID must use lowercase canonical form");
export const contractVersionSchema = z.number().int().positive().max(1_000_000);

function hasUniqueValues(values: string[]): boolean {
	return new Set(values).size === values.length;
}

export const isoTimestampSchema = z.string().datetime({ offset: true });

export const missionStatusSchema = z.enum([
	"awaiting_acceptance",
	"active",
	"verifying",
	"blocked",
	"completed",
	"cancelled",
	"expired",
	"failed",
]);

export const deliveryStatusSchema = z.enum([
	"stored",
	"leased",
	"executing",
	"acknowledged",
	"cancelled",
	"dead_lettered",
]);

export const deliveryKindSchema = z.enum(["turn", "verification", "contract_acknowledgement"]);

export const deliveryCancellationReasonSchema = z.enum([
	"mission_cancelled",
	"mission_expired",
	"mission_failed",
	"work_superseded",
	"node_revoked",
	"workspace_revoked",
]);

export const deliveryReleaseClassificationSchema = z.enum([
	"transient",
	"permanent",
	"policy_denied",
]);

export const deliveryCursorSchema = z
	.string()
	.regex(/^[1-9][0-9]*$/)
	.max(19)
	.refine((cursor) => compareDecimalStrings(cursor, "9223372036854775807") <= 0, {
		message: "Delivery cursor exceeds Postgres bigint range",
	});

export const runStatusSchema = z.enum(["running", "completed", "failed", "cancelled"]);

export const artifactTypeSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z][a-z0-9._-]*$/);

export const messageTypeSchema = z.enum([
	"question",
	"answer",
	"proposal",
	"decision",
	"progress",
	"blocker",
]);

export const policyProfileNameSchema = aliasSchema;

export const policyRequestSchema = z
	.object({
		profile_name: policyProfileNameSchema,
	})
	.strict();

export const actorRefSchema = z
	.object({
		principal_id: uuidSchema,
		kind: z.enum(["owner", "agent"]),
	})
	.strict();

export const nodeStatusSchema = z.enum(["active", "revoked"]);

export const nodeEnrollmentInputSchema = z
	.object({
		name: aliasSchema,
		capabilities: z.array(identifierSchema).max(32),
	})
	.strict()
	.refine((input) => hasUniqueValues(input.capabilities), {
		message: "Node capabilities must be unique",
		path: ["capabilities"],
	});

export const nodeCredentialRotationInputSchema = z
	.object({
		expected_credential_id: uuidSchema,
	})
	.strict();

export const nodeDescriptorSchema = z
	.object({
		node_id: uuidSchema,
		agent_id: uuidSchema,
		name: aliasSchema,
		status: nodeStatusSchema,
		capabilities: z.array(identifierSchema).max(32),
		last_seen_at: isoTimestampSchema.nullable(),
		created_at: isoTimestampSchema,
		updated_at: isoTimestampSchema,
		revoked_at: isoTimestampSchema.nullable(),
	})
	.strict()
	.superRefine((node, ctx) => {
		if ((node.status === "revoked") !== (node.revoked_at !== null)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Node revocation timestamp must match revoked status",
				path: ["revoked_at"],
			});
		}
		if (
			node.revoked_at !== null &&
			(Date.parse(node.revoked_at) < Date.parse(node.created_at) ||
				Date.parse(node.revoked_at) > Date.parse(node.updated_at))
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Node revocation timestamp must fall within its persisted lifetime",
				path: ["revoked_at"],
			});
		}
		if (Date.parse(node.updated_at) < Date.parse(node.created_at)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Node update cannot precede enrollment",
				path: ["updated_at"],
			});
		}
		if (
			node.last_seen_at !== null &&
			(Date.parse(node.last_seen_at) < Date.parse(node.created_at) ||
				Date.parse(node.last_seen_at) > Date.parse(node.updated_at))
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Node last-seen timestamp must fall within its persisted lifetime",
				path: ["last_seen_at"],
			});
		}
		if (new Set(node.capabilities).size !== node.capabilities.length) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Node capabilities must be unique",
				path: ["capabilities"],
			});
		}
	});

export const ownedNodeSummarySchema = z
	.object({
		node: nodeDescriptorSchema,
		active_credential_id: uuidSchema.nullable(),
	})
	.strict();

export const workspaceBindingStatusSchema = z.enum(["active", "revoked"]);

export const repositoryUrlSchema = z
	.string()
	.max(2_048)
	.url()
	.superRefine((value, ctx) => {
		if (
			[...value].some((character) => {
				const code = character.charCodeAt(0);
				return code <= 0x20 || code === 0x7f || character === "\\";
			})
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Repository URL must not contain whitespace, controls, or backslashes",
			});
			return;
		}

		const protocolMatch = /^(https|ssh):\/\//.exec(value);
		if (!protocolMatch) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Repository URL must use https or ssh",
			});
			return;
		}

		const protocol = protocolMatch[1];
		const authority = value.slice(protocolMatch[0].length).split("/", 1)[0] ?? "";
		const atIndex = authority.lastIndexOf("@");
		const userInfo = atIndex >= 0 ? authority.slice(0, atIndex) : "";
		if ((protocol === "https" && userInfo) || (protocol === "ssh" && userInfo !== "git")) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Repository URL must not contain credentials",
			});
		}
		if (value.includes("?") || value.includes("#")) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Repository URL must not contain query parameters or fragments",
			});
		}
	});

export const workspaceRegistrationInputSchema = z
	.object({
		alias: aliasSchema,
		repository_url: repositoryUrlSchema,
		allowed_base_refs: z.array(repositoryRefSchema).max(32),
	})
	.strict()
	.refine((input) => hasUniqueValues(input.allowed_base_refs), {
		message: "Allowed base refs must be unique",
		path: ["allowed_base_refs"],
	});

export const workspaceBindingDescriptorSchema = z
	.object({
		workspace_binding_id: uuidSchema,
		node_id: uuidSchema,
		agent_id: uuidSchema,
		alias: aliasSchema,
		repository_url: repositoryUrlSchema,
		allowed_base_refs: z.array(repositoryRefSchema).max(32),
		status: workspaceBindingStatusSchema,
		created_at: isoTimestampSchema,
		updated_at: isoTimestampSchema,
		revoked_at: isoTimestampSchema.nullable(),
	})
	.strict()
	.superRefine((binding, ctx) => {
		if ((binding.status === "revoked") !== (binding.revoked_at !== null)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Workspace-binding revocation timestamp must match revoked status",
				path: ["revoked_at"],
			});
		}
		if (
			binding.revoked_at !== null &&
			(Date.parse(binding.revoked_at) < Date.parse(binding.created_at) ||
				Date.parse(binding.revoked_at) > Date.parse(binding.updated_at))
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Workspace-binding revocation must fall within its persisted lifetime",
				path: ["revoked_at"],
			});
		}
		if (Date.parse(binding.updated_at) < Date.parse(binding.created_at)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Workspace-binding update cannot precede creation",
				path: ["updated_at"],
			});
		}
		if (new Set(binding.allowed_base_refs).size !== binding.allowed_base_refs.length) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Allowed base refs must be unique",
				path: ["allowed_base_refs"],
			});
		}
	});

export const participantSchema = z
	.object({
		agent_id: uuidSchema,
		role: aliasSchema,
		workspace_alias: aliasSchema,
		repository_url: repositoryUrlSchema,
		expected_base_commit: baseCommitSchema,
		initial_assignment: boundedTextSchema,
		requested_local_policy_profile: policyProfileNameSchema,
	})
	.strict();

export const artifactRefSchema = z
	.object({
		artifact_id: uuidSchema,
		type: artifactTypeSchema,
		version: contractVersionSchema,
		sha256: sha256Schema,
		media_type: z.string().min(1).max(128),
		byte_size: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES),
	})
	.strict();

export const sharedContractArtifactSchema = artifactRefSchema.extend({
	version: z.literal(1),
});

export const contractRevisionSchema = z
	.object({
		revision_id: uuidSchema,
		mission_id: uuidSchema,
		previous_version: z.number().int().positive().max(999_999),
		version: contractVersionSchema.min(2),
		artifact: artifactRefSchema,
		proposed_by_agent_id: uuidSchema,
		acknowledged_by_agent_ids: z.array(uuidSchema).max(2),
		idempotency_key: identifierSchema,
		created_at: isoTimestampSchema,
	})
	.strict()
	.superRefine((revision, ctx) => {
		if (revision.version !== revision.previous_version + 1) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Contract revision versions must be consecutive",
				path: ["version"],
			});
		}
		if (revision.artifact.version !== revision.version) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Contract artifact version must match revision version",
				path: ["artifact", "version"],
			});
		}
		if (!hasUniqueValues(revision.acknowledged_by_agent_ids)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Contract acknowledgements must be unique",
				path: ["acknowledged_by_agent_ids"],
			});
		}
	});

export const messageSchema = z
	.object({
		message_id: uuidSchema,
		mission_id: uuidSchema,
		sequence_no: z.number().int().safe().positive(),
		author_agent_id: uuidSchema,
		type: messageTypeSchema,
		body: boundedTextSchema,
		artifacts: z.array(artifactRefSchema).max(MAX_ARTIFACTS),
		contract_version: contractVersionSchema,
		idempotency_key: identifierSchema,
		causal_parent_message_id: uuidSchema.nullable(),
		created_at: isoTimestampSchema,
	})
	.strict()
	.refine((message) => hasUniqueValues(message.artifacts.map((artifact) => artifact.artifact_id)), {
		message: "Message artifact IDs must be unique",
		path: ["artifacts"],
	});

export const verificationEvidenceSchema = z
	.object({
		verification_id: uuidSchema,
		command_id: aliasSchema,
		outcome: z.enum(["passed", "failed"]),
		exit_code: z.number().int().min(0).max(255),
		duration_ms: z
			.number()
			.int()
			.nonnegative()
			.max(MAX_WALL_TIME_SECONDS * 1_000),
		summary: boundedTextSchema,
		output_sha256: sha256Schema,
		artifacts: z.array(artifactRefSchema).max(MAX_ARTIFACTS),
		recorded_at: isoTimestampSchema,
	})
	.strict()
	.superRefine((evidence, ctx) => {
		if (evidence.outcome === "passed" && evidence.exit_code !== 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Passed verification must have exit code 0",
				path: ["exit_code"],
			});
		}
		if (evidence.outcome === "failed" && evidence.exit_code === 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Failed verification must have a non-zero exit code",
				path: ["exit_code"],
			});
		}
	});

const replyDispositionSchema = z
	.object({
		kind: z.literal("reply"),
		message_type: messageTypeSchema,
		message: boundedTextSchema,
		artifacts: z.array(artifactRefSchema).max(MAX_ARTIFACTS).optional(),
	})
	.strict();

const proposeContractDispositionSchema = z
	.object({
		kind: z.literal("propose_contract"),
		artifact: artifactRefSchema,
	})
	.strict();

const readyDispositionSchema = z
	.object({
		kind: z.literal("ready"),
		evidence: z.array(verificationEvidenceSchema).max(MAX_VERIFICATION_EVIDENCE),
	})
	.strict();

const blockedDispositionSchema = z
	.object({
		kind: z.literal("blocked"),
		reason: boundedTextSchema,
		requested_input: boundedTextSchema.optional(),
	})
	.strict();

const failedDispositionSchema = z
	.object({
		kind: z.literal("failed"),
		class: z.enum(["transient", "permanent", "policy_denied"]),
	})
	.strict();

export const turnDispositionSchema = z.discriminatedUnion("kind", [
	replyDispositionSchema,
	proposeContractDispositionSchema,
	readyDispositionSchema,
	blockedDispositionSchema,
	failedDispositionSchema,
]);

export const missionManifestSchema = z
	.object({
		schema_version: z.literal(1),
		mission_id: uuidSchema,
		objective: boundedTextSchema,
		public_acceptance_criteria: z
			.array(acceptanceCriterionSchema)
			.min(1)
			.max(MAX_ACCEPTANCE_CRITERIA),
		participants: z.array(participantSchema).length(2),
		shared_contract: sharedContractArtifactSchema,
		max_turns: z.number().int().positive().max(MAX_TURNS),
		max_wall_time_seconds: z.number().int().positive().max(MAX_WALL_TIME_SECONDS),
		token_budget: z.number().int().positive().max(MAX_TOKEN_BUDGET),
		expires_at: isoTimestampSchema,
		allowed_artifact_types: z.array(artifactTypeSchema).min(1).max(MAX_ARTIFACT_TYPES),
		created_at: isoTimestampSchema,
	})
	.strict()
	.superRefine((manifest, ctx) => {
		if (!hasUniqueValues(manifest.participants.map((participant) => participant.agent_id))) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Mission participants must be unique",
				path: ["participants"],
			});
		}
		if (!hasUniqueValues(manifest.public_acceptance_criteria)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Public acceptance criteria must be unique",
				path: ["public_acceptance_criteria"],
			});
		}
		if (!hasUniqueValues(manifest.allowed_artifact_types)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Allowed artifact types must be unique",
				path: ["allowed_artifact_types"],
			});
		}
		if (!manifest.allowed_artifact_types.includes(manifest.shared_contract.type)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Shared contract type must be allowed by the Mission",
				path: ["shared_contract", "type"],
			});
		}
		if (Date.parse(manifest.expires_at) <= Date.parse(manifest.created_at)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Mission expiry must be after creation",
				path: ["expires_at"],
			});
		}
	});

/** The relay attaches this actor after authenticating Mission creation. */
export const missionContextSchema = z
	.object({
		manifest: missionManifestSchema,
		created_by: actorRefSchema,
	})
	.strict();

/** Persisted common fields; the client supplies idempotency_key and the relay owns the rest. */
export const missionEventEnvelopeSchema = z
	.object({
		event_id: uuidSchema,
		idempotency_key: identifierSchema,
		mission_id: uuidSchema,
		sequence_no: z.number().int().positive().max(2_147_483_647),
		created_at: isoTimestampSchema,
	})
	.strict();

export const deliveryLeaseSchema = z
	.object({
		lease_id: uuidSchema,
		fencing_token: fencingTokenSchema.refine((token) => token !== "0", {
			message: "Active lease fencing token must be positive",
		}),
		expires_at: isoTimestampSchema,
	})
	.strict();

export const deliveryLeaseAuthoritySchema = deliveryLeaseSchema
	.pick({ lease_id: true, fencing_token: true })
	.strict();

export const deliveryLogicalSettlementSchema = z
	.object({
		settled_by_event_id: uuidSchema,
		settled_at: isoTimestampSchema,
	})
	.strict();

export const deliverySchema = z
	.object({
		delivery_id: uuidSchema,
		node_id: uuidSchema,
		mission_id: uuidSchema,
		mission_event_id: uuidSchema,
		kind: deliveryKindSchema,
		cursor: deliveryCursorSchema,
		status: deliveryStatusSchema,
		attempt_count: z.number().int().nonnegative().max(100),
		max_attempts: z.number().int().positive().max(100),
		last_fencing_token: fencingTokenSchema,
		contract_version: contractVersionSchema,
		verification_round: z.number().int().positive().max(2_147_483_647).nullable(),
		lease: deliveryLeaseSchema.nullable(),
		logical_settlement: deliveryLogicalSettlementSchema.nullable(),
		idempotency_key: identifierSchema,
		causal_parent_delivery_id: uuidSchema.nullable(),
		available_at: isoTimestampSchema,
		created_at: isoTimestampSchema,
		updated_at: isoTimestampSchema,
		acknowledged_at: isoTimestampSchema.nullable(),
		cancelled_at: isoTimestampSchema.nullable(),
		cancellation_reason: deliveryCancellationReasonSchema.nullable(),
		dead_lettered_at: isoTimestampSchema.nullable(),
	})
	.strict()
	.superRefine((delivery, ctx) => {
		const needsLease = delivery.status === "leased" || delivery.status === "executing";
		if ((delivery.kind === "verification") !== (delivery.verification_round !== null)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Only verification deliveries carry a verification round",
				path: ["verification_round"],
			});
		}
		if (needsLease && delivery.lease === null) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `${delivery.status} delivery requires a lease`,
				path: ["lease"],
			});
		}
		if (!needsLease && delivery.lease !== null) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `${delivery.status} delivery cannot retain an active lease`,
				path: ["lease"],
			});
		}
		if (delivery.attempt_count > delivery.max_attempts) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Delivery attempt count cannot exceed its limit",
				path: ["attempt_count"],
			});
		}
		if (needsLease && delivery.attempt_count === 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Active delivery lease requires at least one attempt",
				path: ["attempt_count"],
			});
		}
		if (delivery.status === "acknowledged" && delivery.attempt_count === 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Acknowledged delivery requires at least one execution attempt",
				path: ["attempt_count"],
			});
		}
		if (delivery.status === "stored" && delivery.attempt_count >= delivery.max_attempts) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Stored delivery must retain capacity for another lease",
				path: ["attempt_count"],
			});
		}
		if (delivery.last_fencing_token !== String(delivery.attempt_count)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Latest fencing token must equal the delivery attempt count",
				path: ["last_fencing_token"],
			});
		}
		if (delivery.lease !== null && delivery.lease.fencing_token !== delivery.last_fencing_token) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Active lease must use the delivery's latest fencing token",
				path: ["lease", "fencing_token"],
			});
		}
		if ((delivery.status === "acknowledged") !== (delivery.acknowledged_at !== null)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Acknowledged timestamp must match acknowledged status",
				path: ["acknowledged_at"],
			});
		}
		if ((delivery.status === "cancelled") !== (delivery.cancelled_at !== null)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Cancellation timestamp must match cancelled status",
				path: ["cancelled_at"],
			});
		}
		if ((delivery.status === "cancelled") !== (delivery.cancellation_reason !== null)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Cancellation reason must match cancelled status",
				path: ["cancellation_reason"],
			});
		}
		if ((delivery.status === "dead_lettered") !== (delivery.dead_lettered_at !== null)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Dead-letter timestamp must match dead-lettered status",
				path: ["dead_lettered_at"],
			});
		}
		if (delivery.status === "acknowledged" && delivery.logical_settlement === null) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Acknowledged delivery requires logical settlement",
				path: ["logical_settlement"],
			});
		}
		if (
			delivery.logical_settlement !== null &&
			delivery.status !== "acknowledged" &&
			delivery.status !== "cancelled"
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Logical settlement belongs only to acknowledged or cancelled work",
				path: ["logical_settlement"],
			});
		}
		const createdAt = Date.parse(delivery.created_at);
		for (const [field, value] of [
			["available_at", delivery.available_at],
			["updated_at", delivery.updated_at],
			["settled_at", delivery.logical_settlement?.settled_at ?? null],
			["acknowledged_at", delivery.acknowledged_at],
			["cancelled_at", delivery.cancelled_at],
			["dead_lettered_at", delivery.dead_lettered_at],
		] as const) {
			if (value !== null && Date.parse(value) < createdAt) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `${field} cannot precede delivery creation`,
					path: [field],
				});
			}
		}
		if (delivery.lease !== null && Date.parse(delivery.lease.expires_at) < createdAt) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Lease expiry cannot precede delivery creation",
				path: ["lease", "expires_at"],
			});
		}
		const updatedAt = Date.parse(delivery.updated_at);
		if (
			(needsLease || delivery.status === "acknowledged") &&
			Date.parse(delivery.available_at) > updatedAt
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Delivery cannot be leased before it becomes available",
				path: ["available_at"],
			});
		}
		if (delivery.lease !== null && Date.parse(delivery.lease.expires_at) <= updatedAt) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Active lease must expire after the delivery update",
				path: ["lease", "expires_at"],
			});
		}
		for (const [field, value] of [
			["settled_at", delivery.logical_settlement?.settled_at ?? null],
			["acknowledged_at", delivery.acknowledged_at],
			["cancelled_at", delivery.cancelled_at],
			["dead_lettered_at", delivery.dead_lettered_at],
		] as const) {
			if (value !== null && Date.parse(value) > updatedAt) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `${field} cannot follow the delivery update timestamp`,
					path: [field],
				});
			}
		}
		if (
			delivery.acknowledged_at !== null &&
			Date.parse(delivery.acknowledged_at) < Date.parse(delivery.available_at)
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Delivery acknowledgement cannot precede availability",
				path: ["acknowledged_at"],
			});
		}
	});

export const storedDeliverySchema = deliverySchema.refine(
	(delivery): delivery is Delivery & { status: "stored" } => delivery.status === "stored",
	{
		message: "Cursor polling returns only stored deliveries",
		path: ["status"],
	},
);

export const storedDeliveryCursorPageRequestSchema = z
	.object({
		after_cursor: deliveryCursorSchema.nullable().default(null),
		limit: z.number().int().positive().max(200).default(50),
	})
	.strict();

export const storedDeliveryCursorPageSchema = z
	.object({
		items: z.array(storedDeliverySchema).max(200),
		next_cursor: deliveryCursorSchema.nullable(),
	})
	.strict()
	.superRefine((page, ctx) => {
		for (let index = 1; index < page.items.length; index += 1) {
			if (compareDecimalStrings(page.items[index - 1]!.cursor, page.items[index]!.cursor) >= 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Delivery cursors must be strictly increasing",
					path: ["items", index, "cursor"],
				});
			}
		}

		const nodeIds = new Set(page.items.map((delivery) => delivery.node_id));
		if (nodeIds.size > 1) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "A delivery cursor page belongs to one Node",
				path: ["items"],
			});
		}

		const finalCursor = page.items.at(-1)?.cursor;
		if (finalCursor !== undefined && page.next_cursor !== finalCursor) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Next cursor must match the final returned delivery",
				path: ["next_cursor"],
			});
		}
	});

export const runtimeNameSchema = boundedOpaqueReferenceSchema(128);
export const runtimeVersionSchema = boundedOpaqueReferenceSchema(128);

export const runtimeSchema = z
	.object({
		name: runtimeNameSchema,
		version: runtimeVersionSchema,
	})
	.strict();

const availableTokenUsageSchema = z
	.object({
		available: z.literal(true),
		input_tokens: z.number().int().nonnegative().max(MAX_TOKEN_BUDGET),
		output_tokens: z.number().int().nonnegative().max(MAX_TOKEN_BUDGET),
	})
	.strict();

const unavailableTokenUsageSchema = z
	.object({
		available: z.literal(false),
		reason: z.enum(["unsupported", "not_reported"]),
	})
	.strict();

export const tokenUsageSchema = z.discriminatedUnion("available", [
	availableTokenUsageSchema,
	unavailableTokenUsageSchema,
]);

export const runSchema = z
	.object({
		run_id: uuidSchema,
		mission_id: uuidSchema,
		participant_agent_id: uuidSchema,
		node_id: uuidSchema,
		delivery_id: uuidSchema,
		lease_id: uuidSchema,
		fencing_token: fencingTokenSchema.refine((token) => token !== "0", {
			message: "Run fencing token must be positive",
		}),
		contract_version: contractVersionSchema,
		runtime: runtimeSchema,
		turn_ref: opaqueReferenceSchema,
		status: runStatusSchema,
		usage: tokenUsageSchema,
		disposition: turnDispositionSchema.nullable(),
		artifact_hashes: z.array(sha256Schema).max(MAX_ARTIFACTS),
		verification_evidence: z.array(verificationEvidenceSchema).max(MAX_VERIFICATION_EVIDENCE),
		started_at: isoTimestampSchema,
		completed_at: isoTimestampSchema.nullable(),
	})
	.strict()
	.superRefine((run, ctx) => {
		if ((run.status === "running") !== (run.completed_at === null)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Only running runs may omit a completion timestamp",
				path: ["completed_at"],
			});
		}
		if (run.status === "completed" && run.disposition === null) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Completed run requires a disposition",
				path: ["disposition"],
			});
		}
		if (run.status === "running" && run.disposition !== null) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Running run cannot have a terminal disposition",
				path: ["disposition"],
			});
		}
		if (run.status === "failed" && run.disposition?.kind !== "failed") {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Failed run requires a failed disposition",
				path: ["disposition"],
			});
		}
		if (run.status === "completed" && run.disposition?.kind === "failed") {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Completed run cannot have a failed disposition",
				path: ["disposition"],
			});
		}
		if (run.status === "cancelled" && run.disposition !== null) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Cancelled run cannot have a turn disposition",
				path: ["disposition"],
			});
		}
		if (run.completed_at !== null && Date.parse(run.completed_at) < Date.parse(run.started_at)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Run completion cannot precede its start",
				path: ["completed_at"],
			});
		}
	});

export type IsoTimestamp = z.infer<typeof isoTimestampSchema>;
export type OpaqueReference = z.infer<typeof opaqueReferenceSchema>;
export type MissionStatus = z.infer<typeof missionStatusSchema>;
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;
export type DeliveryKind = z.infer<typeof deliveryKindSchema>;
export type DeliveryCancellationReason = z.infer<typeof deliveryCancellationReasonSchema>;
export type DeliveryReleaseClassification = z.infer<typeof deliveryReleaseClassificationSchema>;
export type DeliveryCursor = z.infer<typeof deliveryCursorSchema>;
export type DeliveryLease = z.infer<typeof deliveryLeaseSchema>;
export type DeliveryLeaseAuthority = z.infer<typeof deliveryLeaseAuthoritySchema>;
export type DeliveryLogicalSettlement = z.infer<typeof deliveryLogicalSettlementSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type Runtime = z.infer<typeof runtimeSchema>;
export type ArtifactType = z.infer<typeof artifactTypeSchema>;
export type MessageType = z.infer<typeof messageTypeSchema>;
export type PolicyProfileName = z.infer<typeof policyProfileNameSchema>;
export type PolicyRequest = z.infer<typeof policyRequestSchema>;
export type ActorRef = z.infer<typeof actorRefSchema>;
export type NodeStatus = z.infer<typeof nodeStatusSchema>;
export type NodeEnrollmentInput = z.infer<typeof nodeEnrollmentInputSchema>;
export type NodeCredentialRotationInput = z.infer<typeof nodeCredentialRotationInputSchema>;
export type NodeDescriptor = z.infer<typeof nodeDescriptorSchema>;
export type OwnedNodeSummary = z.infer<typeof ownedNodeSummarySchema>;
export type WorkspaceBindingStatus = z.infer<typeof workspaceBindingStatusSchema>;
export type WorkspaceRegistrationInput = z.infer<typeof workspaceRegistrationInputSchema>;
export type WorkspaceBindingDescriptor = z.infer<typeof workspaceBindingDescriptorSchema>;
export type Participant = z.infer<typeof participantSchema>;
export type ArtifactRef = z.infer<typeof artifactRefSchema>;
export type SharedContractArtifact = z.infer<typeof sharedContractArtifactSchema>;
export type ContractRevision = z.infer<typeof contractRevisionSchema>;
export type Message = z.infer<typeof messageSchema>;
export type VerificationEvidence = z.infer<typeof verificationEvidenceSchema>;
export type TurnDisposition = z.infer<typeof turnDispositionSchema>;
export type MissionManifest = z.infer<typeof missionManifestSchema>;
export type MissionContext = z.infer<typeof missionContextSchema>;
export type MissionEventEnvelope = z.infer<typeof missionEventEnvelopeSchema>;
export type Delivery = z.infer<typeof deliverySchema>;
export type StoredDelivery = z.infer<typeof storedDeliverySchema>;
export type StoredDeliveryCursorPageRequest = z.infer<typeof storedDeliveryCursorPageRequestSchema>;
export type StoredDeliveryCursorPage = z.infer<typeof storedDeliveryCursorPageSchema>;
export type Run = z.infer<typeof runSchema>;

function compareDecimalStrings(left: string, right: string): number {
	if (left.length !== right.length) {
		return left.length > right.length ? 1 : -1;
	}
	return left === right ? 0 : left > right ? 1 : -1;
}
