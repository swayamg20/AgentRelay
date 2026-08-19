import { z } from "zod";

/** The first Codex transport intentionally supports one CLI protocol version. */
export const SUPPORTED_CODEX_CLI_VERSION = "0.146.0";
export const CODEX_APP_SERVER_CLIENT_NAME = "agentrelay_capsule";
export const MAX_CODEX_APP_SERVER_FRAME_BYTES = 16 * 1_048_576;

const boundedString = (max: number) => z.string().max(max);
const opaqueIdSchema = z.union([boundedString(1_024).min(1), z.number().int().safe()]);
const codexOpaqueIdSchema = boundedString(1_024).min(1);

export const codexInitializeResponseSchema = z
	.object({
		userAgent: boundedString(4_096).min(1),
		codexHome: boundedString(4_096).min(1),
		platformFamily: boundedString(128).min(1),
		platformOs: boundedString(128).min(1),
	})
	.passthrough();

export const codexApiKeyLoginResponseSchema = z.object({ type: z.literal("apiKey") }).passthrough();

export const codexApiKeyAccountResponseSchema = z
	.object({
		account: z.object({ type: z.literal("apiKey") }).passthrough(),
		requiresOpenaiAuth: z.literal(true),
	})
	.passthrough();

const codexTurnErrorSchema = z
	.object({
		message: boundedString(8_192).min(1),
		codexErrorInfo: z.unknown().nullable(),
		additionalDetails: boundedString(32_768).nullable(),
	})
	.strict();

export const codexThreadItemEnvelopeSchema = z
	.object({
		type: boundedString(128).min(1),
		id: codexOpaqueIdSchema,
	})
	.passthrough();

export const codexUserMessageItemSchema = z
	.object({
		type: z.literal("userMessage"),
		id: codexOpaqueIdSchema,
		clientId: boundedString(1_024).nullable(),
		content: z.array(z.unknown()).max(256),
	})
	.passthrough();

export const codexAgentMessageItemSchema = z
	.object({
		type: z.literal("agentMessage"),
		id: codexOpaqueIdSchema,
		text: boundedString(1_048_576),
		phase: z.enum(["commentary", "final_answer"]).nullable(),
	})
	.passthrough();

export const codexTurnSchema = z
	.object({
		id: codexOpaqueIdSchema,
		items: z.array(codexThreadItemEnvelopeSchema).max(4_096),
		itemsView: z.enum(["notLoaded", "summary", "full"]),
		status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
		error: codexTurnErrorSchema.nullable(),
		startedAt: z.number().finite().nullable(),
		completedAt: z.number().finite().nullable(),
		durationMs: z.number().finite().nonnegative().nullable(),
	})
	.passthrough();

const codexThreadStatusSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("notLoaded") }).passthrough(),
	z.object({ type: z.literal("idle") }).passthrough(),
	z.object({ type: z.literal("systemError") }).passthrough(),
	z.object({ type: z.literal("active"), activeFlags: z.array(z.unknown()).max(128) }).passthrough(),
]);

export const codexThreadSchema = z
	.object({
		id: codexOpaqueIdSchema,
		sessionId: codexOpaqueIdSchema,
		ephemeral: z.boolean(),
		modelProvider: boundedString(256).min(1),
		status: codexThreadStatusSchema,
		cwd: boundedString(4_096).min(1),
		cliVersion: boundedString(128).min(1),
		turns: z.array(codexTurnSchema).max(4_096),
	})
	.passthrough();

export const codexSandboxPolicySchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("dangerFullAccess") }).strict(),
	z.object({ type: z.literal("readOnly"), networkAccess: z.boolean() }).passthrough(),
	z
		.object({
			type: z.literal("externalSandbox"),
			networkAccess: z.enum(["restricted", "enabled"]),
		})
		.passthrough(),
	z
		.object({
			type: z.literal("workspaceWrite"),
			writableRoots: z.array(boundedString(4_096)).max(128),
			networkAccess: z.boolean(),
			excludeTmpdirEnvVar: z.boolean(),
			excludeSlashTmp: z.boolean(),
		})
		.passthrough(),
]);

export const codexThreadStartResultSchema = z
	.object({
		thread: codexThreadSchema,
		model: boundedString(256).min(1),
		modelProvider: boundedString(256).min(1),
		serviceTier: boundedString(256).nullable(),
		cwd: boundedString(4_096).min(1),
		instructionSources: z.array(boundedString(4_096)).max(256),
		approvalPolicy: z.unknown(),
		approvalsReviewer: z.unknown(),
		sandbox: codexSandboxPolicySchema,
		reasoningEffort: z.unknown().nullable(),
	})
	.passthrough();

export const codexThreadReadResultSchema = z.object({ thread: codexThreadSchema }).passthrough();

export const codexTurnStartResultSchema = z.object({ turn: codexTurnSchema }).passthrough();

const tokenUsageBreakdownSchema = z
	.object({
		totalTokens: z.number().int().nonnegative(),
		inputTokens: z.number().int().nonnegative(),
		cachedInputTokens: z.number().int().nonnegative(),
		cacheWriteInputTokens: z.number().int().nonnegative(),
		outputTokens: z.number().int().nonnegative(),
		reasoningOutputTokens: z.number().int().nonnegative(),
	})
	.strict();

export const codexRelevantNotificationSchema = z.discriminatedUnion("method", [
	z
		.object({
			method: z.literal("turn/started"),
			params: z.object({ threadId: codexOpaqueIdSchema, turn: codexTurnSchema }).strict(),
		})
		.passthrough(),
	z
		.object({
			method: z.literal("turn/completed"),
			params: z.object({ threadId: codexOpaqueIdSchema, turn: codexTurnSchema }).strict(),
		})
		.passthrough(),
	z
		.object({
			method: z.enum(["item/started", "item/completed"]),
			params: z
				.object({
					threadId: codexOpaqueIdSchema,
					turnId: codexOpaqueIdSchema,
					item: codexThreadItemEnvelopeSchema,
				})
				.passthrough(),
		})
		.passthrough(),
	z
		.object({
			method: z.literal("item/agentMessage/delta"),
			params: z
				.object({
					threadId: codexOpaqueIdSchema,
					turnId: codexOpaqueIdSchema,
					itemId: codexOpaqueIdSchema,
					delta: boundedString(1_048_576),
				})
				.strict(),
		})
		.passthrough(),
	z
		.object({
			method: z.literal("thread/tokenUsage/updated"),
			params: z
				.object({
					threadId: codexOpaqueIdSchema,
					turnId: codexOpaqueIdSchema,
					tokenUsage: z
						.object({
							total: tokenUsageBreakdownSchema,
							last: tokenUsageBreakdownSchema,
							modelContextWindow: z.number().int().positive().nullable(),
						})
						.strict(),
				})
				.strict(),
		})
		.passthrough(),
	z
		.object({
			method: z.literal("error"),
			params: z
				.object({
					error: codexTurnErrorSchema,
					willRetry: z.boolean(),
					threadId: codexOpaqueIdSchema,
					turnId: codexOpaqueIdSchema,
				})
				.strict(),
		})
		.passthrough(),
]);

const relevantNotificationMethods = new Set<string>([
	"turn/started",
	"turn/completed",
	"item/started",
	"item/completed",
	"item/agentMessage/delta",
	"thread/tokenUsage/updated",
	"error",
]);

export function isCodexRelevantNotificationMethod(method: string): boolean {
	return relevantNotificationMethods.has(method);
}

const jsonRpcErrorSchema = z
	.object({
		code: z.number().int().safe(),
		message: boundedString(8_192).min(1),
		data: z.unknown().optional(),
	})
	.strict();

// Generated 0.146.0 bindings describe the stable fields, while the live server can
// attach metadata such as emittedAtMs. Validate what we consume and ignore the rest.
const responseResultSchema = z.object({ id: opaqueIdSchema, result: z.unknown() }).passthrough();
const responseErrorSchema = z
	.object({ id: opaqueIdSchema, error: jsonRpcErrorSchema })
	.passthrough();
const serverRequestSchema = z
	.object({ id: opaqueIdSchema, method: boundedString(256).min(1), params: z.unknown() })
	.passthrough();
const notificationSchema = z
	.object({ method: boundedString(256).min(1), params: z.unknown() })
	.passthrough();

export type CodexServerMessage =
	| { readonly kind: "response"; readonly id: string | number; readonly result: unknown }
	| {
			readonly kind: "response_error";
			readonly id: string | number;
			readonly error: z.infer<typeof jsonRpcErrorSchema>;
	  }
	| {
			readonly kind: "request";
			readonly id: string | number;
			readonly method: string;
			readonly params: unknown;
	  }
	| { readonly kind: "notification"; readonly method: string; readonly params: unknown };

export function parseCodexServerMessage(value: unknown): CodexServerMessage {
	if (typeof value !== "object" || value === null) {
		throw new Error("Codex app-server frame must be an object");
	}
	if ("method" in value) {
		if ("id" in value) {
			const request = serverRequestSchema.parse(value);
			return {
				kind: "request",
				id: request.id,
				method: request.method,
				params: request.params,
			};
		}
		const notification = notificationSchema.parse(value);
		return {
			kind: "notification",
			method: notification.method,
			params: notification.params,
		};
	}
	if ("error" in value) {
		const response = responseErrorSchema.parse(value);
		return { kind: "response_error", ...response };
	}
	const response = responseResultSchema.parse(value);
	return { kind: "response", id: response.id, result: response.result };
}

export type CodexInitializeResponse = z.infer<typeof codexInitializeResponseSchema>;
export type CodexThread = z.infer<typeof codexThreadSchema>;
export type CodexTurn = z.infer<typeof codexTurnSchema>;
export type CodexThreadStartResult = z.infer<typeof codexThreadStartResultSchema>;
export type CodexRelevantNotification = z.infer<typeof codexRelevantNotificationSchema>;
