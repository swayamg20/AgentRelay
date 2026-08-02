import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
	type ArtifactRef,
	type ContractRevision,
	type Message,
	type MissionContext,
	type MissionStatus,
	type TurnDisposition,
	type VerificationEvidence,
	artifactRefSchema,
	contractRevisionSchema,
	contractVersionSchema,
	deliveryCursorSchema,
	messageSchema,
	missionContextSchema,
	missionEventEnvelopeSchema,
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

const rawMissionCoordinatorEventSchema = z.discriminatedUnion("type", [
	participantsAcceptedEventSchema,
	turnCompletedEventSchema,
	contractAcknowledgedEventSchema,
	verificationRecordedEventSchema,
]);

const rawMissionCoordinatorAppendInputSchema = z.discriminatedUnion("type", [
	participantsAcceptedEventSchema.omit(relayOwnedEventFields),
	turnCompletedEventSchema.omit(relayOwnedEventFields),
	contractAcknowledgedEventSchema.omit(relayOwnedEventFields),
	verificationRecordedEventSchema.omit(relayOwnedEventFields),
]);

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

export const storedMissionDeliveryItemSchema = z
	.object({
		delivery: storedDeliverySchema,
		event: missionCoordinatorEventSchema,
		actor_agent_id: uuidSchema,
		source_delivery_id: uuidSchema.nullable(),
		causal_parent_event_id: uuidSchema.nullable(),
	})
	.strict()
	.superRefine((item, ctx) => {
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
		} else {
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
	});

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

export type MissionParticipantAcceptanceInput = z.infer<
	typeof missionParticipantAcceptanceInputSchema
>;
export type StoredMissionDeliveryItem = z.infer<typeof storedMissionDeliveryItemSchema>;
export type StoredMissionDeliveryCursorPage = z.infer<typeof storedMissionDeliveryCursorPageSchema>;

function compareDeliveryCursors(left: string, right: string): number {
	if (left.length !== right.length) {
		return left.length > right.length ? 1 : -1;
	}
	return left === right ? 0 : left > right ? 1 : -1;
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
	if (event.type !== "turn_completed") {
		return;
	}

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

export interface MissionVerificationRecord {
	readonly event_id: string;
	readonly participant_agent_id: string;
	readonly contract_version: number;
	readonly verification_round: number;
	readonly evidence: VerificationEvidence;
}

export interface MissionCoordinatorState {
	readonly mission_context: MissionContext;
	readonly required_verification_commands: Readonly<Record<string, readonly string[]>>;
	readonly status: MissionStatus;
	readonly sequence_no: number;
	readonly turn_count: number;
	readonly contract_version: number;
	readonly verification_round: number;
	readonly active_contract: ArtifactRef;
	readonly pending_revision: ContractRevision | null;
	readonly accepted_revisions: readonly ContractRevision[];
	readonly current_participant_agent_id: string | null;
	readonly ready_agent_ids: readonly string[];
	readonly verification_records: readonly MissionVerificationRecord[];
	readonly messages: readonly Message[];
	readonly applied_events: readonly MissionCoordinatorEvent[];
}

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
	} else {
		reduced = applyVerificationRecorded(current, event);
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
	if (event.evidence.outcome === "failed") {
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

	const verification_records = [...state.verification_records, record];
	if (!allRequiredCommandsPassed(state, verification_records)) {
		return { ...state, verification_records };
	}
	return {
		...state,
		status: transitionMissionStatus(state.status, { type: "verification_passed" }),
		verification_records,
	};
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
