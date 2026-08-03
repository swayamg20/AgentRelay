import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
	MAX_ARTIFACT_BYTES,
	type MessageType,
	actorRefSchema,
	artifactRefSchema,
	contractVersionSchema,
	messageTypeSchema,
	missionContextSchema,
	opaqueReferenceSchema,
	runtimeNameSchema,
	runtimeVersionSchema,
	turnDispositionSchema,
	uuidSchema,
} from "./schemas.js";

const MAX_HOST_TEXT_LENGTH = 16_000;
const MAX_HOST_ITEMS = 64;
export const MAX_HOST_PEER_MESSAGES = 64;
const MAX_PROVIDER_TOKENS = 100_000_000;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 4_096;
const workspaceAliasSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const hostTextSchema = z
	.string()
	.min(1)
	.max(MAX_HOST_TEXT_LENGTH)
	.refine((value) => value.trim().length > 0, "Host text cannot be blank");
const hostOutputChunkSchema = z.string().min(1).max(MAX_HOST_TEXT_LENGTH);
const hostArtifactTextSchema = z.string().max(MAX_ARTIFACT_BYTES);
export const hostExecutionAttemptSchema = z.number().int().safe().positive();

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export const jsonValueSchema = z.unknown().transform((value, ctx): JsonValue => {
	try {
		return sanitizeJsonValue(value);
	} catch (error) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: error instanceof Error ? error.message : "Value is not bounded JSON",
		});
		return null;
	}
});

export const adapterInfoSchema = z
	.object({
		name: runtimeNameSchema,
		version: runtimeVersionSchema,
		capabilities: z
			.object({
				cancellation: z.boolean(),
				recovery: z.boolean(),
				usage: z.enum(["turn_cumulative", "unavailable"]),
			})
			.strict(),
	})
	.strict();

export const sessionInputSchema = z
	.object({
		missionId: uuidSchema,
		participantId: uuidSchema,
		workspaceAlias: workspaceAliasSchema,
	})
	.strict();

export const hostSessionRefSchema = sessionInputSchema.extend({
	sessionId: opaqueReferenceSchema,
});

export const hostMissionTextInputSchema = z
	.object({
		text: hostTextSchema,
		authorPrincipalId: uuidSchema,
		provenance: z.literal("mission_manifest"),
	})
	.strict();

export const hostPeerMessageInputSchema = z
	.object({
		messageId: uuidSchema,
		authorAgentId: uuidSchema,
		kind: messageTypeSchema,
		body: hostTextSchema,
	})
	.strict();

const hostArtifactPayloadInputSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("text"), text: hostArtifactTextSchema }).strict(),
	z
		.object({
			kind: z.literal("json"),
			rawText: hostArtifactTextSchema,
			value: z.unknown().optional(),
		})
		.strict(),
]);

export const hostArtifactPayloadSchema = hostArtifactPayloadInputSchema.transform(
	(payload, ctx) => {
		if (payload.kind === "text") {
			return payload;
		}

		let rawValue: unknown;
		try {
			rawValue = JSON.parse(payload.rawText);
		} catch {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Artifact rawText is not valid JSON" });
			return { kind: "json" as const, rawText: payload.rawText, value: null };
		}
		const parsed = jsonValueSchema.safeParse(rawValue);
		if (!parsed.success) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Artifact rawText must contain bounded JSON",
			});
			return { kind: "json" as const, rawText: payload.rawText, value: null };
		}
		if (payload.value !== undefined) {
			const asserted = jsonValueSchema.safeParse(payload.value);
			if (!asserted.success || canonicalJson(asserted.data) !== canonicalJson(parsed.data)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Parsed JSON does not match the supplied typed artifact value",
				});
			}
		}
		return { kind: "json" as const, rawText: payload.rawText, value: parsed.data };
	},
);

type SerializableHostArtifactPayload =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "json"; readonly rawText: string; readonly value: JsonValue };

/** Returns the exact UTF-8 text whose bytes are identified by the artifact hash. */
export function serializeHostArtifactPayload(payload: SerializableHostArtifactPayload): string {
	return payload.kind === "text" ? payload.text : payload.rawText;
}

export const hostInputArtifactSchema = z
	.object({
		artifact: artifactRefSchema,
		source: actorRefSchema,
		payload: hostArtifactPayloadSchema,
	})
	.strict()
	.superRefine((artifact, ctx) => {
		const serialized = serializeHostArtifactPayload(artifact.payload);
		const byteLength = Buffer.byteLength(serialized, "utf8");
		const sha256 = createHash("sha256").update(serialized, "utf8").digest("hex");
		const isJsonMediaType = hasJsonMediaType(artifact.artifact.media_type);
		if (isJsonMediaType !== (artifact.payload.kind === "json")) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "JSON media types require a JSON payload, and vice versa",
				path: ["payload", "kind"],
			});
		}
		if (byteLength !== artifact.artifact.byte_size) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Artifact byte length does not match its UTF-8 payload",
				path: ["artifact", "byte_size"],
			});
		}
		if (sha256 !== artifact.artifact.sha256) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Artifact hash does not match its UTF-8 payload",
				path: ["artifact", "sha256"],
			});
		}
	});

const turnInputObjectSchema = z
	.object({
		session: hostSessionRefSchema,
		missionId: uuidSchema,
		contractVersion: contractVersionSchema,
		missionSequence: z.number().int().safe().positive(),
		objective: hostMissionTextInputSchema,
		assignment: hostMissionTextInputSchema,
		acceptanceCriteria: z.array(hostMissionTextInputSchema).min(1).max(32),
		peerMessages: z.array(hostPeerMessageInputSchema).max(MAX_HOST_PEER_MESSAGES),
		artifacts: z.array(hostInputArtifactSchema).max(16),
	})
	.strict();

export const turnInputSchema = turnInputObjectSchema.refine(
	(input) => input.missionId === input.session.missionId,
	{
		message: "Turn Mission must match its host session",
		path: ["missionId"],
	},
);

export const startTurnInputSchema = turnInputObjectSchema
	.extend({
		deliveryId: uuidSchema,
		executionAttempt: hostExecutionAttemptSchema,
	})
	.refine((input) => input.missionId === input.session.missionId, {
		message: "Turn Mission must match its host session",
		path: ["missionId"],
	});

export const hostTurnRefSchema = z
	.object({
		turnId: opaqueReferenceSchema,
		sessionId: opaqueReferenceSchema,
		missionId: uuidSchema,
		deliveryId: uuidSchema,
		executionAttempt: hostExecutionAttemptSchema,
		contractVersion: contractVersionSchema,
	})
	.strict();

export const hostFailureSchema = z
	.object({
		class: z.enum(["transient", "permanent", "policy_denied"]),
		message: z.string().min(1).max(4_000),
	})
	.strict();

export const hostUsageSchema = z.discriminatedUnion("available", [
	z
		.object({
			available: z.literal(true),
			scope: z.literal("turn_cumulative"),
			inputTokens: z.number().int().nonnegative().max(MAX_PROVIDER_TOKENS),
			outputTokens: z.number().int().nonnegative().max(MAX_PROVIDER_TOKENS),
		})
		.strict(),
	z
		.object({
			available: z.literal(false),
			reason: z.enum(["unsupported", "not_reported"]),
		})
		.strict(),
]);

export const hostToolActivitySchema = z
	.object({
		toolCallId: opaqueReferenceSchema,
		name: runtimeNameSchema,
		phase: z.enum(["started", "completed", "failed"]),
	})
	.strict();

export const hostPermissionActivitySchema = z
	.object({
		requestId: opaqueReferenceSchema,
		capability: runtimeNameSchema,
		phase: z.enum(["requested", "granted", "denied"]),
	})
	.strict();

const hostEventSequenceSchema = z.number().int().safe().positive();

export const hostEventSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("accepted"),
			turn: hostTurnRefSchema,
			sequence: hostEventSequenceSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("output"),
			turn: hostTurnRefSchema,
			sequence: hostEventSequenceSchema,
			text: hostOutputChunkSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("tool"),
			turn: hostTurnRefSchema,
			sequence: hostEventSequenceSchema,
			activity: hostToolActivitySchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("permission"),
			turn: hostTurnRefSchema,
			sequence: hostEventSequenceSchema,
			activity: hostPermissionActivitySchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("artifact"),
			turn: hostTurnRefSchema,
			sequence: hostEventSequenceSchema,
			artifact: artifactRefSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("usage"),
			turn: hostTurnRefSchema,
			sequence: hostEventSequenceSchema,
			usage: hostUsageSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("completed"),
			turn: hostTurnRefSchema,
			sequence: hostEventSequenceSchema,
			disposition: turnDispositionSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("failed"),
			turn: hostTurnRefSchema,
			sequence: hostEventSequenceSchema,
			failure: hostFailureSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("cancelled"),
			turn: hostTurnRefSchema,
			sequence: hostEventSequenceSchema,
		})
		.strict(),
]);

export interface HostMissionInputs {
	readonly objective: HostMissionTextInput;
	readonly assignment: HostMissionTextInput;
	readonly acceptanceCriteria: readonly HostMissionTextInput[];
}

/** Derives host prompt text only from a relay-authenticated Mission context. */
export function deriveHostMissionInputs(
	contextInput: unknown,
	participantAgentId: string,
): HostMissionInputs {
	const context = missionContextSchema.parse(contextInput);
	const validatedParticipantAgentId = uuidSchema.parse(participantAgentId);
	const participant = context.manifest.participants.find(
		(candidate) => candidate.agent_id === validatedParticipantAgentId,
	);
	if (!participant) {
		throw new Error(`Mission participant not found: ${participantAgentId}`);
	}

	const fromManifest = (text: string): HostMissionTextInput =>
		hostMissionTextInputSchema.parse({
			text,
			authorPrincipalId: context.created_by.principal_id,
			provenance: "mission_manifest",
		});

	return {
		objective: fromManifest(context.manifest.objective),
		assignment: fromManifest(participant.initial_assignment),
		acceptanceCriteria: context.manifest.public_acceptance_criteria.map(fromManifest),
	};
}

export type AdapterInfo = z.infer<typeof adapterInfoSchema>;
export type SessionInput = z.infer<typeof sessionInputSchema>;
export type HostSessionRef = z.infer<typeof hostSessionRefSchema>;
export type HostMissionTextInput = z.infer<typeof hostMissionTextInputSchema>;
export type PeerMessageKind = MessageType;
export type HostPeerMessageInput = z.infer<typeof hostPeerMessageInputSchema>;
export type HostArtifactPayload = z.infer<typeof hostArtifactPayloadSchema>;
export type HostInputArtifact = z.infer<typeof hostInputArtifactSchema>;
export type TurnInput = z.infer<typeof turnInputSchema>;
export type StartTurnInput = z.infer<typeof startTurnInputSchema>;
export type HostTurnRef = z.infer<typeof hostTurnRefSchema>;
export type HostFailure = z.infer<typeof hostFailureSchema>;
export type HostUsage = z.infer<typeof hostUsageSchema>;
export type HostToolActivity = z.infer<typeof hostToolActivitySchema>;
export type HostPermissionActivity = z.infer<typeof hostPermissionActivitySchema>;
export type HostEvent = z.infer<typeof hostEventSchema>;
export type HostTurnCorrelation = Omit<HostTurnRef, "turnId"> & { readonly turnId?: string };

export interface HostEventStreamPolicy {
	readonly maxEvents: number;
	readonly maxOutputBytes: number;
	readonly maxArtifacts: number;
	readonly maxArtifactBytes: number;
	readonly maxTokens: number;
	readonly usage: AdapterInfo["capabilities"]["usage"];
}

export interface HostEventStreamState {
	readonly phase: "awaiting_acceptance" | "active" | "terminal";
	readonly lastSequence: number;
	readonly outputBytes: number;
	readonly artifactCount: number;
	readonly artifactBytes: number;
	readonly artifactKeys: readonly string[];
	readonly usage: HostUsage | null;
	readonly turn: HostTurnRef | null;
	readonly expectedTurn: HostTurnCorrelation;
}

export const DEFAULT_HOST_EVENT_STREAM_POLICY: HostEventStreamPolicy = Object.freeze({
	maxEvents: 256,
	maxOutputBytes: 256 * 1_024,
	maxArtifacts: 16,
	maxArtifactBytes: 16 * MAX_ARTIFACT_BYTES,
	maxTokens: MAX_PROVIDER_TOKENS,
	usage: "turn_cumulative",
});

export class InvalidHostEventStreamError extends Error {
	constructor(
		readonly reason:
			| "sequence"
			| "acceptance"
			| "terminal"
			| "event_limit"
			| "output_limit"
			| "artifact_limit"
			| "usage_regression"
			| "usage_unavailable"
			| "usage_limit"
			| "usage_missing"
			| "turn_mismatch",
	) {
		super(`Invalid host event stream: ${reason}`);
		this.name = "InvalidHostEventStreamError";
	}
}

export function createHostEventStreamState(
	expectedTurn: HostTurnCorrelation,
): HostEventStreamState {
	return {
		phase: "awaiting_acceptance",
		lastSequence: 0,
		outputBytes: 0,
		artifactCount: 0,
		artifactBytes: 0,
		artifactKeys: [],
		usage: null,
		turn: null,
		expectedTurn: structuredClone(expectedTurn),
	};
}

/** Validates one replayable host event and returns its normalized event plus next stream state. */
export function acceptHostEvent(
	current: HostEventStreamState,
	eventInput: unknown,
	policy: HostEventStreamPolicy = DEFAULT_HOST_EVENT_STREAM_POLICY,
): { readonly event: HostEvent; readonly state: HostEventStreamState } {
	assertHostEventStreamPolicy(policy);
	const event = hostEventSchema.parse(eventInput);
	if (event.sequence !== current.lastSequence + 1) {
		throw new InvalidHostEventStreamError("sequence");
	}
	if (
		(current.phase === "awaiting_acceptance" && event.kind !== "accepted") ||
		(current.phase !== "awaiting_acceptance" && event.kind === "accepted")
	) {
		throw new InvalidHostEventStreamError("acceptance");
	}
	if (
		current.phase === "awaiting_acceptance" &&
		event.kind === "accepted" &&
		!matchesExpectedHostTurn(current.expectedTurn, event.turn)
	) {
		throw new InvalidHostEventStreamError("turn_mismatch");
	}
	if (current.phase === "terminal") {
		throw new InvalidHostEventStreamError("terminal");
	}
	if (
		current.phase !== "awaiting_acceptance" &&
		(current.turn === null || !sameHostTurnRef(current.turn, event.turn))
	) {
		throw new InvalidHostEventStreamError("turn_mismatch");
	}
	if (event.sequence > policy.maxEvents) {
		throw new InvalidHostEventStreamError("event_limit");
	}

	const outputBytes = current.outputBytes + textBytesInHostEvent(event);
	if (outputBytes > policy.maxOutputBytes) {
		throw new InvalidHostEventStreamError("output_limit");
	}

	const artifacts = artifactsInHostEvent(event);
	const artifactKeys = [...current.artifactKeys];
	let artifactBytes = current.artifactBytes;
	for (const artifact of artifacts) {
		const key = JSON.stringify([
			artifact.artifact_id,
			artifact.type,
			artifact.version,
			artifact.sha256,
			artifact.media_type,
			artifact.byte_size,
		]);
		if (!artifactKeys.includes(key)) {
			artifactKeys.push(key);
			artifactBytes += artifact.byte_size;
		}
	}
	const artifactCount = artifactKeys.length;
	if (artifactCount > policy.maxArtifacts || artifactBytes > policy.maxArtifactBytes) {
		throw new InvalidHostEventStreamError("artifact_limit");
	}

	let usage = current.usage === null ? null : structuredClone(current.usage);
	if (event.kind === "usage") {
		if (event.usage.available && policy.usage === "unavailable") {
			throw new InvalidHostEventStreamError("usage_unavailable");
		}
		if (
			event.usage.available &&
			event.usage.inputTokens + event.usage.outputTokens > policy.maxTokens
		) {
			throw new InvalidHostEventStreamError("usage_limit");
		}
		if (
			usage?.available &&
			(!event.usage.available ||
				event.usage.inputTokens < usage.inputTokens ||
				event.usage.outputTokens < usage.outputTokens)
		) {
			throw new InvalidHostEventStreamError("usage_regression");
		}
		usage = structuredClone(event.usage);
	}

	const terminal =
		event.kind === "completed" || event.kind === "failed" || event.kind === "cancelled";
	if (terminal && usage === null) {
		throw new InvalidHostEventStreamError("usage_missing");
	}
	return {
		event,
		state: {
			phase: terminal ? "terminal" : "active",
			lastSequence: event.sequence,
			outputBytes,
			artifactCount,
			artifactBytes,
			artifactKeys,
			usage,
			turn: current.turn === null ? structuredClone(event.turn) : structuredClone(current.turn),
			expectedTurn: structuredClone(current.expectedTurn),
		},
	};
}

export interface AgentHostAdapter {
	probe(): Promise<AdapterInfo>;
	ensureSession(input: SessionInput): Promise<HostSessionRef>;
	lookupTurn(deliveryId: string, executionAttempt: number): Promise<HostTurnRef | null>;
	startTurn(input: StartTurnInput): AsyncIterable<HostEvent>;
	recoverTurn(ref: HostTurnRef): AsyncIterable<HostEvent>;
	cancelTurn(ref: HostTurnRef): Promise<void>;
}

function canonicalJson(value: JsonValue): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) as string;
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
		.join(",")}}`;
}

function hasJsonMediaType(mediaType: string): boolean {
	const essence = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	return essence === "application/json" || /^application\/[^/;]+\+json$/.test(essence);
}

function artifactsInHostEvent(event: HostEvent) {
	if (event.kind === "artifact") {
		return [event.artifact];
	}
	if (event.kind !== "completed") {
		return [];
	}
	if (event.disposition.kind === "reply") {
		return event.disposition.artifacts ?? [];
	}
	if (event.disposition.kind === "propose_contract") {
		return [event.disposition.artifact];
	}
	if (event.disposition.kind === "ready") {
		return event.disposition.evidence.flatMap((evidence) => evidence.artifacts);
	}
	return [];
}

function textBytesInHostEvent(event: HostEvent): number {
	if (event.kind === "output") {
		return Buffer.byteLength(event.text, "utf8");
	}
	if (event.kind === "failed") {
		return Buffer.byteLength(event.failure.message, "utf8");
	}
	if (event.kind !== "completed") {
		return 0;
	}
	const disposition = event.disposition;
	if (disposition.kind === "reply") {
		return Buffer.byteLength(disposition.message, "utf8");
	}
	if (disposition.kind === "blocked") {
		return Buffer.byteLength(
			disposition.requested_input === undefined
				? disposition.reason
				: `${disposition.reason}${disposition.requested_input}`,
			"utf8",
		);
	}
	if (disposition.kind === "ready") {
		return disposition.evidence.reduce(
			(total, evidence) => total + Buffer.byteLength(evidence.summary, "utf8"),
			0,
		);
	}
	return 0;
}

function assertHostEventStreamPolicy(policy: HostEventStreamPolicy): void {
	for (const value of [
		policy.maxEvents,
		policy.maxOutputBytes,
		policy.maxArtifacts,
		policy.maxArtifactBytes,
		policy.maxTokens,
	]) {
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw new Error("Host event stream limits must be positive safe integers");
		}
	}
}

function sameHostTurnRef(left: HostTurnRef, right: HostTurnRef): boolean {
	return (
		left.turnId === right.turnId &&
		left.sessionId === right.sessionId &&
		left.missionId === right.missionId &&
		left.deliveryId === right.deliveryId &&
		left.executionAttempt === right.executionAttempt &&
		left.contractVersion === right.contractVersion
	);
}

function matchesExpectedHostTurn(expected: HostTurnCorrelation, received: HostTurnRef): boolean {
	return (
		(expected.turnId === undefined || expected.turnId === received.turnId) &&
		expected.sessionId === received.sessionId &&
		expected.missionId === received.missionId &&
		expected.deliveryId === received.deliveryId &&
		expected.executionAttempt === received.executionAttempt &&
		expected.contractVersion === received.contractVersion
	);
}

function sanitizeJsonValue(value: unknown): JsonValue {
	const seen = new WeakSet<object>();
	let nodes = 0;

	const visit = (item: unknown, depth: number): JsonValue => {
		nodes += 1;
		if (nodes > MAX_JSON_NODES) {
			throw new Error("JSON value has too many nodes");
		}
		if (depth > MAX_JSON_DEPTH) {
			throw new Error("JSON value is nested too deeply");
		}

		if (item === null || typeof item === "boolean") {
			return item;
		}
		if (typeof item === "number") {
			if (!Number.isFinite(item)) {
				throw new Error("JSON numbers must be finite");
			}
			return item;
		}
		if (typeof item === "string") {
			if (item.length > MAX_HOST_TEXT_LENGTH) {
				throw new Error("JSON string is too long");
			}
			return item;
		}
		if (typeof item !== "object") {
			throw new Error("Value is not JSON-compatible");
		}
		if (seen.has(item)) {
			throw new Error("JSON value cannot be cyclic or aliased");
		}
		seen.add(item);

		if (Array.isArray(item)) {
			const descriptors = Object.getOwnPropertyDescriptors(item);
			const length = Object.getOwnPropertyDescriptor(item, "length")?.value;
			if (!Number.isSafeInteger(length) || length < 0 || length > MAX_HOST_ITEMS) {
				throw new Error("JSON array has too many items");
			}
			const output: JsonValue[] = [];
			for (let index = 0; index < length; index += 1) {
				const descriptor = descriptors[String(index)];
				if (!descriptor || !("value" in descriptor)) {
					throw new Error("JSON arrays cannot contain holes or accessors");
				}
				output.push(visit(descriptor.value, depth + 1));
			}
			return output;
		}

		const prototype = Object.getPrototypeOf(item);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error("JSON objects must be plain objects");
		}
		const descriptors = Object.getOwnPropertyDescriptors(item);
		const keys = Object.keys(descriptors).filter((key) => descriptors[key]?.enumerable);
		if (keys.length > MAX_HOST_ITEMS) {
			throw new Error("JSON object has too many keys");
		}
		const output: { [key: string]: JsonValue } = {};
		for (const key of keys) {
			if (key.length > 256) {
				throw new Error("JSON object key is too long");
			}
			const descriptor = descriptors[key];
			if (!descriptor || !("value" in descriptor)) {
				throw new Error("JSON objects cannot contain enumerable accessors");
			}
			Object.defineProperty(output, key, {
				value: visit(descriptor.value, depth + 1),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		return output;
	};

	return visit(value, 0);
}
