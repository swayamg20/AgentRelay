import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
	type ArtifactRef,
	type ContractRevision,
	type Delivery,
	type Message,
	type MissionStatus,
	type TurnDisposition,
	artifactRefSchema,
	contractRevisionSchema,
	contractVersionSchema,
	deliveryCursorSchema,
	deliverySchema,
	isoTimestampSchema,
	messageSchema,
	missionContextSchema,
	missionEventEnvelopeSchema,
	missionStatusSchema,
	policyProfileNameSchema,
	storedDeliverySchema,
	turnDispositionSchema,
	uuidSchema,
	verificationEvidenceSchema,
} from "./schemas.js";
import { transitionMissionStatus } from "./state-machines.js";

const commandIdSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const requiredCommandsSchema = z.record(z.array(commandIdSchema).min(1).max(16));

export const missionCoordinatorConfigSchema = z
	.object({
		mission_context: missionContextSchema,
		required_verification_commands: requiredCommandsSchema,
	})
	.strict()
	.superRefine((config, ctx) => {
		const participantIds = config.mission_context.manifest.participants.map(
			(participant) => participant.agent_id,
		);
		const configuredIds = Object.keys(config.required_verification_commands);
		if (!sameStringSet(participantIds, configuredIds)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Verification plan must contain exactly the two Mission participants",
				path: ["required_verification_commands"],
			});
		}
		for (const participantId of configuredIds) {
			const commands = config.required_verification_commands[participantId] ?? [];
			if (new Set(commands).size !== commands.length) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Required verification command IDs must be unique per participant",
					path: ["required_verification_commands", participantId],
				});
			}
		}
	});

const relayOwnedEventFields = {
	event_id: true,
	mission_id: true,
	sequence_no: true,
	created_at: true,
} as const;

const participantsAcceptedEventSchema = z
	.object({
		...missionEventEnvelopeSchema.shape,
		type: z.literal("participants_accepted"),
		participant_agent_ids: z.array(uuidSchema).length(2),
		contract: artifactRefSchema,
	})
	.strict();
const turnCompletedEventSchema = z
	.object({
		...missionEventEnvelopeSchema.shape,
		type: z.literal("turn_completed"),
		participant_agent_id: uuidSchema,
		delivery_id: uuidSchema,
		contract_version: contractVersionSchema,
		disposition: turnDispositionSchema,
		message: messageSchema.nullable(),
		revision: contractRevisionSchema.nullable(),
	})
	.strict();
const contractAcknowledgedEventSchema = z
	.object({
		...missionEventEnvelopeSchema.shape,
		type: z.literal("contract_acknowledged"),
		participant_agent_id: uuidSchema,
		delivery_id: uuidSchema,
		revision_id: uuidSchema,
		contract_version: contractVersionSchema,
		artifact: artifactRefSchema,
	})
	.strict();
const verificationRecordedEventSchema = z
	.object({
		...missionEventEnvelopeSchema.shape,
		type: z.literal("verification_recorded"),
		participant_agent_id: uuidSchema,
		delivery_id: uuidSchema,
		contract_version: contractVersionSchema,
		verification_round: z.number().int().safe().positive(),
		evidence: verificationEvidenceSchema,
	})
	.strict();
const missionTerminalEventSchema = z
	.object({
		...missionEventEnvelopeSchema.shape,
		type: z.literal("mission_terminal"),
		terminal_status: z.enum(["expired", "failed"]),
		reason: z.enum(["deadline_exceeded", "delivery_dead_lettered"]),
		triggering_delivery_id: uuidSchema.nullable(),
	})
	.strict();

const rawMissionCoordinatorEventSchema = z.discriminatedUnion("type", [
	participantsAcceptedEventSchema,
	turnCompletedEventSchema,
	contractAcknowledgedEventSchema,
	verificationRecordedEventSchema,
	missionTerminalEventSchema,
]);

const rawMissionCoordinatorAppendInputSchema = z.discriminatedUnion("type", [
	participantsAcceptedEventSchema.omit(relayOwnedEventFields),
	turnCompletedEventSchema.omit(relayOwnedEventFields),
	contractAcknowledgedEventSchema.omit(relayOwnedEventFields),
	verificationRecordedEventSchema.omit(relayOwnedEventFields),
]);

const nodeCoordinatorTurnDispositionSchema = turnDispositionSchema.refine(
	(disposition): disposition is CoordinatorTurnDisposition =>
		disposition.kind === "reply" ||
		disposition.kind === "propose_contract" ||
		disposition.kind === "ready",
	"Delivery completion supports reply, propose_contract, and ready turns",
);

export const nodeDeliveryResultPayloadSchema = z
	.discriminatedUnion("type", [
		z
			.object({
				type: z.literal("turn_completed"),
				disposition: nodeCoordinatorTurnDispositionSchema,
			})
			.strict(),
		z.object({ type: z.literal("contract_acknowledged") }).strict(),
		z
			.object({
				type: z.literal("verification_recorded"),
				evidence: z.array(verificationEvidenceSchema).min(1).max(16),
			})
			.strict(),
	])
	.superRefine((result, ctx) => {
		if (result.type !== "verification_recorded") return;
		if (
			new Set(result.evidence.map((evidence) => evidence.command_id)).size !==
			result.evidence.length
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Verification completion must contain one result per command",
				path: ["evidence"],
			});
		}
		if (
			new Set(result.evidence.map((evidence) => evidence.verification_id)).size !==
			result.evidence.length
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Verification evidence IDs must be unique",
				path: ["evidence"],
			});
		}
	});

type RawMissionCoordinatorEvent = z.infer<typeof rawMissionCoordinatorEventSchema>;
type RawMissionCoordinatorAppendInput = z.infer<typeof rawMissionCoordinatorAppendInputSchema>;
export type CoordinatorTurnDisposition = Extract<
	TurnDisposition,
	{ readonly kind: "reply" | "propose_contract" | "ready" }
>;
type RawTurnCompletedEvent = Extract<
	RawMissionCoordinatorEvent,
	{ readonly type: "turn_completed" }
>;
export type MissionCoordinatorEvent =
	| Exclude<RawMissionCoordinatorEvent, { readonly type: "turn_completed" }>
	| (Omit<RawTurnCompletedEvent, "disposition"> & {
			readonly disposition: CoordinatorTurnDisposition;
	  });

type RawAppendTurnCompletedInput = Extract<
	RawMissionCoordinatorAppendInput,
	{ readonly type: "turn_completed" }
>;
export type MissionCoordinatorAppendInput =
	| Exclude<RawMissionCoordinatorAppendInput, { readonly type: "turn_completed" }>
	| (Omit<RawAppendTurnCompletedInput, "disposition"> & {
			readonly disposition: CoordinatorTurnDisposition;
	  });

export const missionCoordinatorEventSchema = rawMissionCoordinatorEventSchema
	.superRefine(validateCoordinatorEventPayload)
	.transform((event): MissionCoordinatorEvent => event as MissionCoordinatorEvent);

export const missionCoordinatorAppendInputSchema = rawMissionCoordinatorAppendInputSchema
	.superRefine(validateCoordinatorEventPayload)
	.transform((event): MissionCoordinatorAppendInput => event as MissionCoordinatorAppendInput);

export const missionVerificationRecordSchema = z
	.object({
		event_id: uuidSchema,
		participant_agent_id: uuidSchema,
		contract_version: contractVersionSchema,
		verification_round: z.number().int().positive().max(2_147_483_647),
		evidence: verificationEvidenceSchema,
	})
	.strict();

const rawMissionCoordinatorStateSchema = z
	.object({
		mission_context: missionContextSchema,
		required_verification_commands: requiredCommandsSchema,
		status: missionStatusSchema,
		sequence_no: z.number().int().nonnegative().max(2_147_483_647),
		turn_count: z.number().int().nonnegative().max(200),
		contract_version: contractVersionSchema,
		verification_round: z.number().int().nonnegative().max(2_147_483_647),
		active_contract: artifactRefSchema,
		pending_revision: contractRevisionSchema.nullable(),
		accepted_revisions: z.array(contractRevisionSchema).max(200),
		current_participant_agent_id: uuidSchema.nullable(),
		ready_agent_ids: z.array(uuidSchema).max(2),
		verification_records: z.array(missionVerificationRecordSchema).max(3_200),
		messages: z.array(messageSchema).max(200),
		applied_events: z.array(missionCoordinatorEventSchema).max(4_096),
	})
	.strict();

export type MissionCoordinatorState = z.infer<typeof rawMissionCoordinatorStateSchema>;
export const missionCoordinatorStateSchema = rawMissionCoordinatorStateSchema.superRefine(
	validateMissionCoordinatorState,
);

export const missionParticipantAcceptanceInputSchema = z
	.object({
		idempotency_key: missionEventEnvelopeSchema.shape.idempotency_key,
		contract: artifactRefSchema,
		local_policy_grant: z
			.object({
				profile_name: policyProfileNameSchema,
				grant_sha256: z.string().regex(/^[a-f0-9]{64}$/),
			})
			.strict(),
	})
	.strict();

export const missionParticipantAcceptanceReceiptSchema = z
	.object({
		mission_id: uuidSchema,
		participant_agent_id: uuidSchema,
		idempotency_key: missionEventEnvelopeSchema.shape.idempotency_key,
		contract: artifactRefSchema,
		local_policy_grant: missionParticipantAcceptanceInputSchema.shape.local_policy_grant,
		accepted_at: isoTimestampSchema,
	})
	.strict();

export const missionParticipantAcceptanceResultSchema = z
	.object({
		receipt: missionParticipantAcceptanceReceiptSchema,
		replayed: z.boolean(),
	})
	.strict();

export const missionParticipantBindingSchema = z
	.object({
		agent_id: uuidSchema,
		node_id: uuidSchema,
		workspace_binding_id: uuidSchema,
	})
	.strict();

export type MissionParticipantBinding = z.infer<typeof missionParticipantBindingSchema>;

const rawMissionCreationResultSchema = z
	.object({
		mission_id: uuidSchema,
		state: missionCoordinatorStateSchema,
		participant_bindings: z.array(missionParticipantBindingSchema).length(2),
		replayed: z.boolean(),
	})
	.strict();

export type MissionCreationResult = z.infer<typeof rawMissionCreationResultSchema>;
export const missionCreationResultSchema = rawMissionCreationResultSchema.superRefine(
	validateMissionCreationResult,
);

export const missionParticipantAcceptanceStatusSchema = z.enum(["pending", "accepted"]);

const rawNodeMissionAssignmentSchema = z
	.object({
		mission_id: uuidSchema,
		coordinator_config: missionCoordinatorConfigSchema,
		coordinator_state: missionCoordinatorStateSchema,
		participant_agent_id: uuidSchema,
		workspace_binding_id: uuidSchema,
		acceptance_status: missionParticipantAcceptanceStatusSchema,
		acceptance_receipt: missionParticipantAcceptanceReceiptSchema.nullable(),
	})
	.strict();

export type NodeMissionAssignment = z.infer<typeof rawNodeMissionAssignmentSchema>;
export const nodeMissionAssignmentSchema = rawNodeMissionAssignmentSchema.superRefine(
	validateNodeMissionAssignment,
);

export const nodeMissionAssignmentResultSchema = z
	.object({ mission: nodeMissionAssignmentSchema })
	.strict();

export const nodeMissionAssignmentListRequestSchema = z
	.object({
		status: missionStatusSchema.optional(),
		after_cursor: uuidSchema.nullable().default(null),
		limit: z.number().int().positive().max(200).default(50),
	})
	.strict();

export const nodeMissionAssignmentListSchema = z
	.object({
		missions: z.array(nodeMissionAssignmentSchema).max(200),
		next_cursor: uuidSchema.nullable(),
	})
	.strict()
	.superRefine((page, ctx) => {
		const finalMissionId = page.missions.at(-1)?.mission_id;
		if (page.next_cursor !== null && finalMissionId === undefined) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "An empty Mission page cannot have a next cursor",
				path: ["next_cursor"],
			});
		} else if (page.next_cursor !== null && page.next_cursor !== finalMissionId) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Next cursor must match the final returned Mission",
				path: ["next_cursor"],
			});
		}
	});

const missionDeliveryItemFields = {
	event: missionCoordinatorEventSchema,
	actor_agent_id: uuidSchema,
	source_delivery_id: uuidSchema.nullable(),
	causal_parent_event_id: uuidSchema.nullable(),
} as const;

export const missionDeliveryItemSchema = z
	.object({
		delivery: deliverySchema,
		...missionDeliveryItemFields,
	})
	.strict()
	.superRefine(validateMissionDeliveryItem);

export const storedMissionDeliveryItemSchema = z
	.object({
		delivery: storedDeliverySchema,
		...missionDeliveryItemFields,
	})
	.strict()
	.superRefine(validateMissionDeliveryItem);

export const storedMissionDeliveryCursorPageSchema = z
	.object({
		items: z.array(storedMissionDeliveryItemSchema).max(200),
		next_cursor: deliveryCursorSchema.nullable(),
	})
	.strict()
	.superRefine((page, ctx) => {
		for (let index = 1; index < page.items.length; index += 1) {
			const previousCursor = page.items[index - 1]!.delivery.cursor;
			const cursor = page.items[index]!.delivery.cursor;
			if (compareDeliveryCursors(previousCursor, cursor) >= 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Delivery cursors must be strictly increasing",
					path: ["items", index, "delivery", "cursor"],
				});
			}
		}

		const nodeIds = new Set(page.items.map((item) => item.delivery.node_id));
		if (nodeIds.size > 1) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "A Mission delivery cursor page belongs to one Node",
				path: ["items"],
			});
		}

		const finalCursor = page.items.at(-1)?.delivery.cursor;
		if (finalCursor !== undefined && page.next_cursor !== finalCursor) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Next cursor must match the final returned delivery",
				path: ["next_cursor"],
			});
		}
	});

export const recoverableMissionDeliveryPageRequestSchema = z
	.object({
		limit: z.number().int().positive().max(200).default(50),
	})
	.strict();

export const recoverableMissionDeliveryPageSchema = z
	.object({
		items: z.array(missionDeliveryItemSchema).max(200),
		as_of: isoTimestampSchema,
	})
	.strict()
	.superRefine((page, ctx) => {
		for (let index = 1; index < page.items.length; index += 1) {
			const previousCursor = page.items[index - 1]!.delivery.cursor;
			const cursor = page.items[index]!.delivery.cursor;
			if (compareDeliveryCursors(previousCursor, cursor) >= 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Recoverable delivery cursors must be strictly increasing",
					path: ["items", index, "delivery", "cursor"],
				});
			}
		}

		const nodeIds = new Set(page.items.map((item) => item.delivery.node_id));
		if (nodeIds.size > 1) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "A recoverable delivery page belongs to one Node",
				path: ["items"],
			});
		}

		const asOf = Date.parse(page.as_of);
		for (const [index, item] of page.items.entries()) {
			const { delivery } = item;
			const resumableLease =
				(delivery.status === "leased" || delivery.status === "executing") &&
				delivery.lease !== null &&
				delivery.logical_settlement === null;
			const dueRetry =
				delivery.status === "stored" &&
				delivery.attempt_count > 0 &&
				delivery.logical_settlement === null &&
				Date.parse(delivery.available_at) <= asOf;
			if (!resumableLease && !dueRetry) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Recovery pages contain only resumable leases or due stored retries",
					path: ["items", index, "delivery", "status"],
				});
			}
		}
	});

export type MissionParticipantAcceptanceInput = z.infer<
	typeof missionParticipantAcceptanceInputSchema
>;
export type MissionParticipantAcceptanceReceipt = z.infer<
	typeof missionParticipantAcceptanceReceiptSchema
>;
export type MissionParticipantAcceptanceResult = z.infer<
	typeof missionParticipantAcceptanceResultSchema
>;
export type MissionParticipantAcceptanceStatus = z.infer<
	typeof missionParticipantAcceptanceStatusSchema
>;
export type NodeMissionAssignmentResult = z.infer<typeof nodeMissionAssignmentResultSchema>;
export type NodeMissionAssignmentListRequest = z.infer<
	typeof nodeMissionAssignmentListRequestSchema
>;
export type NodeMissionAssignmentList = z.infer<typeof nodeMissionAssignmentListSchema>;
export type NodeDeliveryResultPayload = z.infer<typeof nodeDeliveryResultPayloadSchema>;
export type MissionDeliveryItem = z.infer<typeof missionDeliveryItemSchema>;
export type StoredMissionDeliveryItem = z.infer<typeof storedMissionDeliveryItemSchema>;
export type StoredMissionDeliveryCursorPage = z.infer<typeof storedMissionDeliveryCursorPageSchema>;
export type RecoverableMissionDeliveryPageRequest = z.infer<
	typeof recoverableMissionDeliveryPageRequestSchema
>;
export type RecoverableMissionDeliveryPage = z.infer<typeof recoverableMissionDeliveryPageSchema>;

export type MissionVerificationRecord = z.infer<typeof missionVerificationRecordSchema>;

function validateMissionCoordinatorState(
	state: MissionCoordinatorState,
	ctx: z.RefinementCtx,
): void {
	const manifest = state.mission_context.manifest;
	const participantIds = manifest.participants.map((participant) => participant.agent_id);
	if (!sameStringSet(participantIds, Object.keys(state.required_verification_commands))) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Coordinator state must retain verification commands for both participants",
			path: ["required_verification_commands"],
		});
	}
	if (
		state.active_contract.version !== state.contract_version ||
		!manifest.allowed_artifact_types.includes(state.active_contract.type)
	) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Active contract must match the coordinator contract version and artifact policy",
			path: ["active_contract"],
		});
	}
	if (
		state.current_participant_agent_id !== null &&
		!participantIds.includes(state.current_participant_agent_id)
	) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Current participant must belong to the Mission",
			path: ["current_participant_agent_id"],
		});
	}
	if (
		new Set(state.ready_agent_ids).size !== state.ready_agent_ids.length ||
		state.ready_agent_ids.some((participantId) => !participantIds.includes(participantId))
	) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Ready participants must be unique Mission participants",
			path: ["ready_agent_ids"],
		});
	}
	if (state.applied_events.length !== state.sequence_no) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Coordinator sequence must equal its applied event count",
			path: ["sequence_no"],
		});
	}
	for (const [index, event] of state.applied_events.entries()) {
		if (event.mission_id !== manifest.mission_id || event.sequence_no !== index + 1) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Applied events must be contiguous and belong to the Mission",
				path: ["applied_events", index],
			});
		}
	}
	for (const [index, message] of state.messages.entries()) {
		if (message.mission_id !== manifest.mission_id) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Coordinator messages must belong to the Mission",
				path: ["messages", index, "mission_id"],
			});
		}
	}
	for (const [index, revision] of [
		...state.accepted_revisions,
		...(state.pending_revision === null ? [] : [state.pending_revision]),
	].entries()) {
		if (revision.mission_id !== manifest.mission_id) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Contract revisions must belong to the Mission",
				path: ["accepted_revisions", index, "mission_id"],
			});
		}
	}
}

function validateMissionCreationResult(result: MissionCreationResult, ctx: z.RefinementCtx): void {
	const participantIds = result.state.mission_context.manifest.participants.map(
		(participant) => participant.agent_id,
	);
	if (result.mission_id !== result.state.mission_context.manifest.mission_id) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Creation result Mission ID must match coordinator state",
			path: ["mission_id"],
		});
	}
	const bindingAgentIds = result.participant_bindings.map((binding) => binding.agent_id);
	if (!sameStringSet(participantIds, bindingAgentIds)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Creation result must bind exactly the Mission participants",
			path: ["participant_bindings"],
		});
	}
	if (
		new Set(result.participant_bindings.map((binding) => binding.node_id)).size !==
			result.participant_bindings.length ||
		new Set(result.participant_bindings.map((binding) => binding.workspace_binding_id)).size !==
			result.participant_bindings.length
	) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Mission participant Node and workspace bindings must be unique",
			path: ["participant_bindings"],
		});
	}
}

function validateNodeMissionAssignment(
	assignment: NodeMissionAssignment,
	ctx: z.RefinementCtx,
): void {
	const config = assignment.coordinator_config;
	const manifest = config.mission_context.manifest;
	const state = assignment.coordinator_state;
	if (
		assignment.mission_id !== manifest.mission_id ||
		assignment.mission_id !== state.mission_context.manifest.mission_id
	) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Assignment Mission ID must match its config and current state",
			path: ["mission_id"],
		});
	}
	if (
		!isDeepStrictEqual(config.mission_context, state.mission_context) ||
		!isDeepStrictEqual(config.required_verification_commands, state.required_verification_commands)
	) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Coordinator state must retain the immutable Mission config",
			path: ["coordinator_state"],
		});
	}
	const participant = manifest.participants.find(
		(candidate) => candidate.agent_id === assignment.participant_agent_id,
	);
	if (participant === undefined) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Assignment participant must belong to the Mission",
			path: ["participant_agent_id"],
		});
		return;
	}
	const accepted = assignment.acceptance_status === "accepted";
	if (accepted !== (assignment.acceptance_receipt !== null)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Participant acceptance status and receipt must agree",
			path: ["acceptance_receipt"],
		});
	}
	if (assignment.acceptance_status === "pending" && state.status !== "awaiting_acceptance") {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Pending participant acceptance requires an awaiting Mission",
			path: ["acceptance_status"],
		});
	}
	const receipt = assignment.acceptance_receipt;
	if (
		receipt !== null &&
		(receipt.mission_id !== assignment.mission_id ||
			receipt.participant_agent_id !== assignment.participant_agent_id ||
			!isDeepStrictEqual(receipt.contract, manifest.shared_contract) ||
			receipt.local_policy_grant.profile_name !== participant.requested_local_policy_profile)
	) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Acceptance receipt must bind the exact Mission participant contract and policy",
			path: ["acceptance_receipt"],
		});
	}
}

function compareDeliveryCursors(left: string, right: string): number {
	if (left.length !== right.length) {
		return left.length > right.length ? 1 : -1;
	}
	return left === right ? 0 : left > right ? 1 : -1;
}

function validateMissionDeliveryItem(
	item: {
		delivery: Delivery;
		event: MissionCoordinatorEvent;
		actor_agent_id: string;
		source_delivery_id: string | null;
	},
	ctx: z.RefinementCtx,
): void {
	if (item.delivery.mission_event_id !== item.event.event_id) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Delivery must reference the returned Mission event",
			path: ["delivery", "mission_event_id"],
		});
	}
	if (item.delivery.mission_id !== item.event.mission_id) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Delivery and event must belong to the same Mission",
			path: ["delivery", "mission_id"],
		});
	}
	if (item.event.type === "participants_accepted") {
		if (item.source_delivery_id !== null) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Derived participant acceptance has no source delivery",
				path: ["source_delivery_id"],
			});
		}
		return;
	}
	if (item.event.type === "mission_terminal") {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Terminal Mission events do not derive Node deliveries",
			path: ["event", "type"],
		});
		return;
	}
	if (item.actor_agent_id !== item.event.participant_agent_id) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Stored event actor must match the participant result",
			path: ["actor_agent_id"],
		});
	}
	if (item.source_delivery_id !== item.event.delivery_id) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Stored event must retain its source delivery",
			path: ["source_delivery_id"],
		});
	}
}

function validateCoordinatorEventPayload(
	event: RawMissionCoordinatorEvent | RawMissionCoordinatorAppendInput,
	ctx: z.RefinementCtx,
): void {
	if (event.type === "participants_accepted") {
		if (new Set(event.participant_agent_ids).size !== event.participant_agent_ids.length) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Accepted Mission participants must be unique",
				path: ["participant_agent_ids"],
			});
		}
		return;
	}
	if (event.type === "mission_terminal") {
		const expiresMission =
			event.terminal_status === "expired" &&
			event.reason === "deadline_exceeded" &&
			event.triggering_delivery_id === null;
		const failsMission =
			event.terminal_status === "failed" &&
			event.reason === "delivery_dead_lettered" &&
			event.triggering_delivery_id !== null;
		if (!expiresMission && !failsMission) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Mission terminal status must match its authoritative cause",
				path: ["terminal_status"],
			});
		}
		return;
	}
	if (event.type !== "turn_completed") {
		return;
	}
	validateTurnResultCompanions(event, ctx);
}

function validateTurnResultCompanions(
	event: {
		disposition: TurnDisposition;
		message: Message | null;
		revision: ContractRevision | null;
	},
	ctx: z.RefinementCtx,
): void {
	const kind = event.disposition.kind;
	if ((kind === "reply") !== (event.message !== null)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Reply dispositions require exactly one Message companion",
			path: ["message"],
		});
	}
	if ((kind === "propose_contract") !== (event.revision !== null)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Contract proposals require exactly one revision companion",
			path: ["revision"],
		});
	}
	if (kind !== "reply" && kind !== "propose_contract" && kind !== "ready") {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "This coordinator slice supports reply, propose_contract, and ready turns",
			path: ["disposition", "kind"],
		});
	}
}

export type MissionCoordinatorConfig = z.infer<typeof missionCoordinatorConfigSchema>;

export class InvalidMissionCoordinatorEventError extends Error {
	constructor(readonly reason: string) {
		super(`Invalid Mission coordinator event: ${reason}`);
		this.name = "InvalidMissionCoordinatorEventError";
	}
}

export function createMissionCoordinatorState(configInput: unknown): MissionCoordinatorState {
	const config = missionCoordinatorConfigSchema.parse(configInput);
	const manifest = config.mission_context.manifest;
	const required_verification_commands = Object.fromEntries(
		manifest.participants.map((participant) => [
			participant.agent_id,
			[...config.required_verification_commands[participant.agent_id]!],
		]),
	);

	return {
		mission_context: structuredClone(config.mission_context),
		required_verification_commands,
		status: "awaiting_acceptance",
		sequence_no: 0,
		turn_count: 0,
		contract_version: manifest.shared_contract.version,
		verification_round: 0,
		active_contract: structuredClone(manifest.shared_contract),
		pending_revision: null,
		accepted_revisions: [],
		current_participant_agent_id: null,
		ready_agent_ids: [],
		verification_records: [],
		messages: [],
		applied_events: [],
	};
}

export function reduceMissionCoordinatorEvent(
	state: MissionCoordinatorState,
	eventInput: unknown,
): MissionCoordinatorState {
	const event = missionCoordinatorEventSchema.parse(eventInput);
	const replay = findReplay(state, event);
	if (replay !== null) {
		if (isDeepStrictEqual(replay, event)) {
			return state;
		}
		throw new InvalidMissionCoordinatorEventError("event_identity_conflict");
	}

	if (event.mission_id !== state.mission_context.manifest.mission_id) {
		throw new InvalidMissionCoordinatorEventError("mission_mismatch");
	}
	if (event.sequence_no !== state.sequence_no + 1) {
		throw new InvalidMissionCoordinatorEventError("sequence");
	}
	if (isTerminal(state.status)) {
		throw new InvalidMissionCoordinatorEventError("terminal");
	}
	if (
		event.type === "turn_completed" &&
		state.applied_events.some(
			(applied) => applied.type === "turn_completed" && applied.delivery_id === event.delivery_id,
		)
	) {
		throw new InvalidMissionCoordinatorEventError("delivery_conflict");
	}

	const current = structuredClone(state);
	let reduced: MissionCoordinatorState;
	if (event.type === "participants_accepted") {
		reduced = applyParticipantsAccepted(current, event);
	} else if (event.type === "turn_completed") {
		reduced = applyTurnCompleted(current, event);
	} else if (event.type === "contract_acknowledged") {
		reduced = applyContractAcknowledged(current, event);
	} else if (event.type === "verification_recorded") {
		reduced = applyVerificationRecorded(current, event);
	} else {
		reduced = applyMissionTerminal(current, event);
	}

	return {
		...reduced,
		sequence_no: event.sequence_no,
		applied_events: [...reduced.applied_events, structuredClone(event)],
	};
}

export function replayMissionCoordinatorEvents(
	configInput: unknown,
	eventInputs: readonly unknown[],
): MissionCoordinatorState {
	let state = createMissionCoordinatorState(configInput);
	for (const event of eventInputs) {
		state = reduceMissionCoordinatorEvent(state, event);
	}
	return state;
}

type ParticipantsAcceptedEvent = Extract<
	MissionCoordinatorEvent,
	{ readonly type: "participants_accepted" }
>;
type TurnCompletedEvent = Extract<MissionCoordinatorEvent, { readonly type: "turn_completed" }>;
type ContractAcknowledgedEvent = Extract<
	MissionCoordinatorEvent,
	{ readonly type: "contract_acknowledged" }
>;
type VerificationRecordedEvent = Extract<
	MissionCoordinatorEvent,
	{ readonly type: "verification_recorded" }
>;
type MissionTerminalEvent = Extract<MissionCoordinatorEvent, { readonly type: "mission_terminal" }>;

function applyMissionTerminal(
	state: MissionCoordinatorState,
	event: MissionTerminalEvent,
): MissionCoordinatorState {
	if (state.status !== "active" && state.status !== "verifying") {
		throw new InvalidMissionCoordinatorEventError("terminal_state");
	}
	return {
		...state,
		status: transitionMissionStatus(state.status, {
			type: event.terminal_status === "expired" ? "expire" : "fail",
		}),
		pending_revision: null,
		current_participant_agent_id: null,
		ready_agent_ids: [],
		verification_records: [],
	};
}

function applyParticipantsAccepted(
	state: MissionCoordinatorState,
	event: ParticipantsAcceptedEvent,
): MissionCoordinatorState {
	if (state.status !== "awaiting_acceptance" || state.applied_events.length !== 0) {
		throw new InvalidMissionCoordinatorEventError("acceptance_state");
	}
	const manifest = state.mission_context.manifest;
	const participantIds = manifest.participants.map((participant) => participant.agent_id);
	if (!sameStringSet(event.participant_agent_ids, participantIds)) {
		throw new InvalidMissionCoordinatorEventError("acceptance_participants");
	}
	if (!isDeepStrictEqual(event.contract, manifest.shared_contract)) {
		throw new InvalidMissionCoordinatorEventError("acceptance_contract");
	}

	return {
		...state,
		status: transitionMissionStatus(state.status, { type: "participants_accepted" }),
		current_participant_agent_id: participantIds[0]!,
	};
}

function applyTurnCompleted(
	state: MissionCoordinatorState,
	event: TurnCompletedEvent,
): MissionCoordinatorState {
	if (
		state.status !== "active" ||
		state.pending_revision !== null ||
		state.current_participant_agent_id === null
	) {
		throw new InvalidMissionCoordinatorEventError("turn_not_scheduled");
	}
	if (event.participant_agent_id !== state.current_participant_agent_id) {
		throw new InvalidMissionCoordinatorEventError("turn_participant");
	}
	if (event.contract_version !== state.contract_version) {
		throw new InvalidMissionCoordinatorEventError("contract_version");
	}
	if (state.turn_count >= state.mission_context.manifest.max_turns) {
		throw new InvalidMissionCoordinatorEventError("turn_limit");
	}

	const withTurn = { ...state, turn_count: state.turn_count + 1 };
	let reduced: MissionCoordinatorState;
	if (event.disposition.kind === "reply") {
		reduced = applyReply(withTurn, event);
	} else if (event.disposition.kind === "propose_contract") {
		reduced = applyContractProposal(withTurn, event);
	} else if (event.disposition.kind === "ready") {
		reduced = applyReady(withTurn, event);
	} else {
		throw new InvalidMissionCoordinatorEventError("unsupported_disposition");
	}

	if (
		reduced.status === "active" &&
		reduced.turn_count >= reduced.mission_context.manifest.max_turns
	) {
		return {
			...reduced,
			status: transitionMissionStatus(reduced.status, { type: "fail" }),
			pending_revision: null,
			current_participant_agent_id: null,
			ready_agent_ids: [],
			verification_records: [],
		};
	}
	return reduced;
}

function applyReply(
	state: MissionCoordinatorState,
	event: TurnCompletedEvent,
): MissionCoordinatorState {
	const message = event.message;
	if (event.disposition.kind !== "reply" || message === null) {
		throw new InvalidMissionCoordinatorEventError("reply_message_missing");
	}
	const expectedArtifacts = event.disposition.artifacts ?? [];
	const expectedParent = state.messages.at(-1)?.message_id ?? null;
	if (
		message.mission_id !== event.mission_id ||
		message.author_agent_id !== event.participant_agent_id ||
		message.contract_version !== state.contract_version ||
		message.type !== event.disposition.message_type ||
		message.body !== event.disposition.message ||
		!isDeepStrictEqual(message.artifacts, expectedArtifacts) ||
		message.sequence_no !== state.messages.length + 1 ||
		message.causal_parent_message_id !== expectedParent
	) {
		throw new InvalidMissionCoordinatorEventError("reply_message_mismatch");
	}
	if (
		state.messages.some(
			(existing) =>
				existing.message_id === message.message_id ||
				existing.idempotency_key === message.idempotency_key,
		)
	) {
		throw new InvalidMissionCoordinatorEventError("message_identity_conflict");
	}
	assertAllowedArtifacts(state, message.artifacts);

	return {
		...state,
		current_participant_agent_id: otherParticipant(state, event.participant_agent_id),
		ready_agent_ids: [],
		verification_records: [],
		messages: [...state.messages, structuredClone(message)],
	};
}

function applyContractProposal(
	state: MissionCoordinatorState,
	event: TurnCompletedEvent,
): MissionCoordinatorState {
	const revision = event.revision;
	if (event.disposition.kind !== "propose_contract" || revision === null) {
		throw new InvalidMissionCoordinatorEventError("revision_missing");
	}
	if (
		revision.mission_id !== event.mission_id ||
		revision.proposed_by_agent_id !== event.participant_agent_id ||
		revision.previous_version !== state.contract_version ||
		revision.version !== state.contract_version + 1 ||
		revision.acknowledged_by_agent_ids.length !== 0 ||
		!isDeepStrictEqual(revision.artifact, event.disposition.artifact)
	) {
		throw new InvalidMissionCoordinatorEventError("revision_mismatch");
	}
	if (
		revision.artifact.artifact_id !== state.active_contract.artifact_id ||
		revision.artifact.type !== state.active_contract.type
	) {
		throw new InvalidMissionCoordinatorEventError("revision_contract_identity");
	}
	if (
		state.accepted_revisions.some(
			(existing) =>
				existing.revision_id === revision.revision_id ||
				existing.idempotency_key === revision.idempotency_key,
		)
	) {
		throw new InvalidMissionCoordinatorEventError("revision_identity_conflict");
	}
	assertAllowedArtifacts(state, [revision.artifact]);

	return {
		...state,
		pending_revision: structuredClone(revision),
		current_participant_agent_id: null,
		ready_agent_ids: [],
		verification_records: [],
	};
}

function applyReady(
	state: MissionCoordinatorState,
	event: TurnCompletedEvent,
): MissionCoordinatorState {
	if (event.disposition.kind !== "ready") {
		throw new InvalidMissionCoordinatorEventError("ready_disposition");
	}
	assertAllowedArtifacts(
		state,
		event.disposition.evidence.flatMap((evidence) => evidence.artifacts),
	);
	const ready_agent_ids = [...state.ready_agent_ids, event.participant_agent_id];
	const participantIds = missionParticipantIds(state);
	if (sameStringSet(ready_agent_ids, participantIds)) {
		return {
			...state,
			status: transitionMissionStatus(state.status, { type: "participants_ready" }),
			verification_round: state.verification_round + 1,
			current_participant_agent_id: null,
			ready_agent_ids,
			verification_records: [],
		};
	}

	return {
		...state,
		current_participant_agent_id: otherParticipant(state, event.participant_agent_id),
		ready_agent_ids,
	};
}

function applyContractAcknowledged(
	state: MissionCoordinatorState,
	event: ContractAcknowledgedEvent,
): MissionCoordinatorState {
	const pending = state.pending_revision;
	if (
		state.status !== "active" ||
		pending === null ||
		state.current_participant_agent_id !== null
	) {
		throw new InvalidMissionCoordinatorEventError("no_pending_revision");
	}
	if (!missionParticipantIds(state).includes(event.participant_agent_id)) {
		throw new InvalidMissionCoordinatorEventError("acknowledgement_participant");
	}
	if (
		event.revision_id !== pending.revision_id ||
		event.contract_version !== pending.version ||
		!isDeepStrictEqual(event.artifact, pending.artifact)
	) {
		throw new InvalidMissionCoordinatorEventError("acknowledgement_revision");
	}
	if (pending.acknowledged_by_agent_ids.includes(event.participant_agent_id)) {
		throw new InvalidMissionCoordinatorEventError("duplicate_acknowledgement");
	}

	const acknowledged = contractRevisionSchema.parse({
		...pending,
		acknowledged_by_agent_ids: [...pending.acknowledged_by_agent_ids, event.participant_agent_id],
	});
	if (!sameStringSet(acknowledged.acknowledged_by_agent_ids, missionParticipantIds(state))) {
		return { ...state, pending_revision: acknowledged };
	}

	return {
		...state,
		contract_version: acknowledged.version,
		active_contract: structuredClone(acknowledged.artifact),
		pending_revision: null,
		accepted_revisions: [...state.accepted_revisions, acknowledged],
		current_participant_agent_id: otherParticipant(state, acknowledged.proposed_by_agent_id),
		ready_agent_ids: [],
		verification_records: [],
	};
}

function applyVerificationRecorded(
	state: MissionCoordinatorState,
	event: VerificationRecordedEvent,
): MissionCoordinatorState {
	if (
		state.status !== "verifying" ||
		state.pending_revision !== null ||
		state.current_participant_agent_id !== null
	) {
		throw new InvalidMissionCoordinatorEventError("not_verifying");
	}
	if (event.contract_version !== state.contract_version) {
		throw new InvalidMissionCoordinatorEventError("contract_version");
	}
	if (event.verification_round !== state.verification_round) {
		throw new InvalidMissionCoordinatorEventError("verification_round");
	}
	const required = state.required_verification_commands[event.participant_agent_id];
	if (!required || !required.includes(event.evidence.command_id)) {
		throw new InvalidMissionCoordinatorEventError("verification_command");
	}
	if (
		state.applied_events.some(
			(applied) =>
				applied.type === "verification_recorded" &&
				applied.evidence.verification_id === event.evidence.verification_id,
		) ||
		state.verification_records.some(
			(record) =>
				record.participant_agent_id === event.participant_agent_id &&
				record.evidence.command_id === event.evidence.command_id,
		)
	) {
		throw new InvalidMissionCoordinatorEventError("verification_conflict");
	}
	assertAllowedArtifacts(state, event.evidence.artifacts);

	const record: MissionVerificationRecord = {
		event_id: event.event_id,
		participant_agent_id: event.participant_agent_id,
		contract_version: event.contract_version,
		verification_round: event.verification_round,
		evidence: structuredClone(event.evidence),
	};
	const verification_records = [...state.verification_records, record];
	const participantRecords = verification_records.filter(
		(candidate) => candidate.participant_agent_id === event.participant_agent_id,
	);
	if (!allParticipantCommandsRecorded(required, participantRecords)) {
		return { ...state, verification_records };
	}
	if (participantRecords.some((candidate) => candidate.evidence.outcome === "failed")) {
		const remainingTurns = state.mission_context.manifest.max_turns - state.turn_count;
		const canRetry = remainingTurns >= missionParticipantIds(state).length;
		return {
			...state,
			status: transitionMissionStatus(state.status, {
				type: canRetry ? "verification_failed" : "fail",
			}),
			current_participant_agent_id: canRetry ? event.participant_agent_id : null,
			ready_agent_ids: [],
			verification_records: [],
		};
	}

	if (!allRequiredCommandsPassed(state, verification_records)) {
		return { ...state, verification_records };
	}
	return {
		...state,
		status: transitionMissionStatus(state.status, { type: "verification_passed" }),
		verification_records,
	};
}

function allParticipantCommandsRecorded(
	requiredCommands: readonly string[],
	records: readonly MissionVerificationRecord[],
): boolean {
	return requiredCommands.every((commandId) =>
		records.some((record) => record.evidence.command_id === commandId),
	);
}

function findReplay(
	state: MissionCoordinatorState,
	event: MissionCoordinatorEvent,
): MissionCoordinatorEvent | null {
	const matches = state.applied_events.filter(
		(applied) =>
			applied.event_id === event.event_id || applied.idempotency_key === event.idempotency_key,
	);
	if (matches.length === 0) {
		return null;
	}
	if (matches.length !== 1) {
		throw new InvalidMissionCoordinatorEventError("event_identity_conflict");
	}
	return matches[0]!;
}

function allRequiredCommandsPassed(
	state: MissionCoordinatorState,
	records: readonly MissionVerificationRecord[],
): boolean {
	return missionParticipantIds(state).every((participantId) =>
		state.required_verification_commands[participantId]!.every((commandId) =>
			records.some(
				(record) =>
					record.participant_agent_id === participantId &&
					record.contract_version === state.contract_version &&
					record.verification_round === state.verification_round &&
					record.evidence.command_id === commandId &&
					record.evidence.outcome === "passed",
			),
		),
	);
}

function assertAllowedArtifacts(
	state: MissionCoordinatorState,
	artifacts: readonly ArtifactRef[],
): void {
	const allowed = state.mission_context.manifest.allowed_artifact_types;
	if (artifacts.some((artifact) => !allowed.includes(artifact.type))) {
		throw new InvalidMissionCoordinatorEventError("artifact_type");
	}
}

function missionParticipantIds(state: MissionCoordinatorState): string[] {
	return state.mission_context.manifest.participants.map((participant) => participant.agent_id);
}

function otherParticipant(state: MissionCoordinatorState, participantId: string): string {
	const other = missionParticipantIds(state).find((candidate) => candidate !== participantId);
	if (!other) {
		throw new InvalidMissionCoordinatorEventError("participant");
	}
	return other;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
	return (
		left.length === right.length &&
		new Set(left).size === left.length &&
		left.every((item) => right.includes(item))
	);
}

function isTerminal(status: MissionStatus): boolean {
	return (
		status === "completed" || status === "cancelled" || status === "expired" || status === "failed"
	);
}
