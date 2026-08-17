import {
	type AdapterInfo,
	adapterInfoSchema,
	hostEventSchema,
	hostExecutionAttemptSchema,
	hostSessionRefSchema,
	hostTurnRefSchema,
	sessionInputSchema,
	startTurnInputSchema,
	uuidSchema,
} from "@agentrelay/protocol";
import { z } from "zod";
import {
	runtimeAuthorityDenyCodeSchema,
	runtimeAuthorityGrantSchema,
	runtimeAuthorityRenewalSchema,
	runtimeAuthorityRequestSchema,
} from "./runtime-authority.js";

export const CAPSULE_WIRE_VERSION = 1;
// A valid recovery request can contain sixteen 1 MiB text artifacts plus all
// bounded Mission text. JSON escaping can expand a one-byte control character
// to six bytes, so the wire cap must be larger than the protocol payload cap.
export const MAX_CAPSULE_REQUEST_FRAME_BYTES = 128 * 1_048_576;
// The largest bounded HostEvent is a ready disposition with sixteen evidence
// entries and sixteen artifact references per entry. Keep responses separate
// so an unauthenticated peer cannot make the server buffer request-sized frames.
export const MAX_CAPSULE_RESPONSE_FRAME_BYTES = 4 * 1_048_576;

const emptyParamsSchema = z.object({}).strict();
const requestEnvelope = {
	version: z.literal(CAPSULE_WIRE_VERSION),
	capsule_id: uuidSchema,
	capability_token: z.string().regex(/^ar_capsule_[a-f0-9]{64}$/),
	request_id: uuidSchema,
};

export const capsuleRequestSchema = z.discriminatedUnion("method", [
	z.object({ ...requestEnvelope, method: z.literal("probe"), params: emptyParamsSchema }).strict(),
	z
		.object({
			...requestEnvelope,
			method: z.literal("install_authority"),
			params: z
				.object({
					grant: runtimeAuthorityGrantSchema,
					current_lease: runtimeAuthorityRenewalSchema,
				})
				.strict(),
		})
		.strict(),
	z
		.object({
			...requestEnvelope,
			method: z.literal("assert_authority"),
			params: z.object({ request: runtimeAuthorityRequestSchema }).strict(),
		})
		.strict(),
	z
		.object({
			...requestEnvelope,
			method: z.literal("renew_authority"),
			params: z.object({ mission_id: uuidSchema, renewal: runtimeAuthorityRenewalSchema }).strict(),
		})
		.strict(),
	z
		.object({
			...requestEnvelope,
			method: z.literal("revoke_authority"),
			params: z
				.object({
					mission_id: uuidSchema,
					grant_id: uuidSchema,
					reason: runtimeAuthorityDenyCodeSchema,
				})
				.strict(),
		})
		.strict(),
	z
		.object({
			...requestEnvelope,
			method: z.literal("ensure_session"),
			params: z.object({ input: sessionInputSchema }).strict(),
		})
		.strict(),
	z
		.object({
			...requestEnvelope,
			method: z.literal("lookup_turn"),
			params: z
				.object({ delivery_id: uuidSchema, execution_attempt: hostExecutionAttemptSchema })
				.strict(),
		})
		.strict(),
	z
		.object({
			...requestEnvelope,
			method: z.literal("start_turn"),
			params: z.object({ input: startTurnInputSchema }).strict(),
		})
		.strict(),
	z
		.object({
			...requestEnvelope,
			method: z.literal("recover_turn"),
			params: z.object({ turn: hostTurnRefSchema, input: startTurnInputSchema }).strict(),
		})
		.strict(),
	z
		.object({
			...requestEnvelope,
			method: z.literal("cancel_turn"),
			params: z.object({ turn: hostTurnRefSchema }).strict(),
		})
		.strict(),
	z
		.object({ ...requestEnvelope, method: z.literal("shutdown"), params: emptyParamsSchema })
		.strict(),
]);

const responseEnvelope = {
	version: z.literal(CAPSULE_WIRE_VERSION),
	capsule_id: uuidSchema,
	request_id: uuidSchema,
};

const capsuleUnaryResultSchema = z.union([
	adapterInfoSchema,
	hostSessionRefSchema,
	hostTurnRefSchema.nullable(),
	emptyParamsSchema,
]);

export const capsuleResponseSchema = z.discriminatedUnion("kind", [
	z
		.object({ ...responseEnvelope, kind: z.literal("result"), value: capsuleUnaryResultSchema })
		.strict(),
	z.object({ ...responseEnvelope, kind: z.literal("event"), event: hostEventSchema }).strict(),
	z.object({ ...responseEnvelope, kind: z.literal("end") }).strict(),
	z
		.object({
			...responseEnvelope,
			kind: z.literal("error"),
			code: z.enum([
				"invalid_request",
				"authentication_failed",
				"authority_denied",
				"scope_mismatch",
				"correlation_conflict",
				"not_found",
				"internal",
			]),
			message: z.string().min(1).max(2_000),
		})
		.strict(),
]);

export const fakeCapsuleOutcomeSchema = z.enum(["ready", "reply"]);

export const capsuleLaunchDescriptorSchema = z
	.object({
		schema_version: z.literal(1),
		capsule_id: uuidSchema,
		capability_token: z.string().regex(/^ar_capsule_[a-f0-9]{64}$/),
		socket_path: z
			.string()
			.min(1)
			.max(512)
			.refine((value) => !value.includes("\0")),
		session: sessionInputSchema,
		runtime: z
			.object({
				kind: z.literal("fake"),
				outcome: fakeCapsuleOutcomeSchema,
				completion_delay_ms: z.number().int().min(0).max(60_000),
			})
			.strict(),
	})
	.strict();

export const CAPSULE_ADAPTER_INFO: AdapterInfo = adapterInfoSchema.parse({
	name: "capsule-fake",
	version: "1.0.0",
	capabilities: {
		cancellation: true,
		recovery: true,
		usage: "unavailable",
	},
});

export type CapsuleRequest = z.infer<typeof capsuleRequestSchema>;
export type CapsuleResponse = z.infer<typeof capsuleResponseSchema>;
export type CapsuleLaunchDescriptor = z.infer<typeof capsuleLaunchDescriptorSchema>;
export type FakeCapsuleOutcome = z.infer<typeof fakeCapsuleOutcomeSchema>;
export type CapsuleErrorCode = Extract<CapsuleResponse, { kind: "error" }>["code"];
export type CapsuleUnaryResult = z.infer<typeof capsuleUnaryResultSchema>;
export type CapsuleResultResponse = Extract<CapsuleResponse, { kind: "result" }>;
export type CapsuleEventResponse = Extract<CapsuleResponse, { kind: "event" }>;
export type CapsuleEndResponse = Extract<CapsuleResponse, { kind: "end" }>;
export type CapsuleErrorResponse = Extract<CapsuleResponse, { kind: "error" }>;

export const capsuleProbeResultSchema = adapterInfoSchema;
export const capsuleEnsureSessionResultSchema = hostSessionRefSchema;
export const capsuleLookupTurnResultSchema = hostTurnRefSchema.nullable();
export const capsuleEmptyResultSchema = emptyParamsSchema;
