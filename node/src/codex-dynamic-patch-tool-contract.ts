import { z } from "zod";
import { CODEX_PATCH_MAX_BYTES } from "./codex-workspace-patch-contract.js";

export const CODEX_DYNAMIC_TOOL_NAMESPACE = "agentrelay";
export const CODEX_DYNAMIC_PATCH_TOOL_NAME = "apply_patch";
export const CODEX_DYNAMIC_PATCH_TOOL_CONTRACT = "agentrelay.apply_patch/v1";
export type CodexDynamicPatchToolContract = typeof CODEX_DYNAMIC_PATCH_TOOL_CONTRACT;

const providerReferenceSchema = z
	.string()
	.min(1)
	.max(512)
	.refine((value) => !hasUnpairedSurrogate(value) && !hasControlCharacter(value), {
		message: "Provider references must be valid, printable Unicode",
	});
const patchSchema = z.string().superRefine((patch, context) => {
	if (hasUnpairedSurrogate(patch)) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Patch must not contain unpaired UTF-16 surrogates",
		});
		return;
	}
	if (Buffer.byteLength(patch, "utf8") > CODEX_PATCH_MAX_BYTES) {
		context.addIssue({
			code: z.ZodIssueCode.too_big,
			maximum: CODEX_PATCH_MAX_BYTES,
			type: "string",
			inclusive: true,
			message: "Patch exceeds the byte limit",
		});
	}
});

export const codexDynamicPatchToolCallParamsSchema = z
	.object({
		threadId: providerReferenceSchema,
		turnId: providerReferenceSchema,
		callId: providerReferenceSchema,
		namespace: z.literal(CODEX_DYNAMIC_TOOL_NAMESPACE),
		tool: z.literal(CODEX_DYNAMIC_PATCH_TOOL_NAME),
		arguments: z.object({ patch: patchSchema }).strict(),
	})
	.strict();

export interface CodexDynamicPatchToolCall {
	readonly threadId: string;
	readonly turnId: string;
	readonly callId: string;
	readonly patch: string;
}

/**
 * Every outcome proves a durable Capsule receipt. `fatal_rejected` is reserved for a durable,
 * proven-no-effect failed receipt and instructs the transport to respond once before teardown.
 * Uncertain effects or receipt persistence failures must reject the handler instead.
 */
export type CodexDynamicPatchToolOutcome = "applied" | "rejected" | "fatal_rejected";

/**
 * Local write-authority coordinator for the one AgentRelay dynamic tool.
 *
 * The production handler is the lifecycle authority: before any effect it must
 * durably bind the exact Capsule thread, active HostTurn, provider turn/call, and
 * live workspace-write authority. This transport only parses and dispatches the
 * provider references; it does not make them authoritative.
 *
 * The handler must not call the Codex client that invoked it. App-server input is
 * serialized while a server request is pending, so re-entering that client cannot
 * make progress and is treated as a fatal contract violation. Client teardown aborts
 * the signal but never waits indefinitely for a handler that ignores cancellation;
 * the Capsule-level coordinator remains responsible for proving its own quiescence.
 */
export interface CodexDynamicPatchToolHandler {
	handle(
		call: CodexDynamicPatchToolCall,
		signal: AbortSignal,
	): PromiseLike<CodexDynamicPatchToolOutcome>;
}

export interface CodexDynamicPatchToolSpec {
	readonly type: "namespace";
	readonly name: typeof CODEX_DYNAMIC_TOOL_NAMESPACE;
	readonly description: string;
	readonly tools: readonly [
		{
			readonly type: "function";
			readonly name: typeof CODEX_DYNAMIC_PATCH_TOOL_NAME;
			readonly description: string;
			readonly inputSchema: {
				readonly type: "object";
				readonly properties: {
					readonly patch: { readonly type: "string" };
				};
				readonly required: readonly ["patch"];
				readonly additionalProperties: false;
			};
			readonly deferLoading: false;
		},
	];
}

export interface CodexDynamicPatchToolResponse {
	readonly contentItems: readonly [
		{
			readonly type: "inputText";
			readonly text: string;
		},
	];
	readonly success: boolean;
}

const dynamicPatchToolSpec: CodexDynamicPatchToolSpec = deepFreeze({
	type: "namespace",
	name: CODEX_DYNAMIC_TOOL_NAMESPACE,
	description: "AgentRelay-authorized workspace operations",
	tools: [
		{
			type: "function",
			name: CODEX_DYNAMIC_PATCH_TOOL_NAME,
			description: "Apply one bounded patch through AgentRelay",
			inputSchema: {
				type: "object",
				properties: { patch: { type: "string" } },
				required: ["patch"],
				additionalProperties: false,
			},
			deferLoading: false,
		},
	],
});

const appliedResponse: CodexDynamicPatchToolResponse = deepFreeze({
	contentItems: [{ type: "inputText", text: "AgentRelay applied the patch." }],
	success: true,
});

const rejectedResponse: CodexDynamicPatchToolResponse = deepFreeze({
	contentItems: [{ type: "inputText", text: "AgentRelay did not apply the patch." }],
	success: false,
});

export function codexDynamicPatchTools(): readonly [CodexDynamicPatchToolSpec] {
	return [structuredClone(dynamicPatchToolSpec)];
}

export function parseCodexDynamicPatchToolCallParams(value: unknown): CodexDynamicPatchToolCall {
	const params = codexDynamicPatchToolCallParamsSchema.parse(value);
	return Object.freeze({
		threadId: params.threadId,
		turnId: params.turnId,
		callId: params.callId,
		patch: params.arguments.patch,
	});
}

export function parseCodexDynamicPatchToolOutcome(value: unknown): CodexDynamicPatchToolOutcome {
	return z.enum(["applied", "rejected", "fatal_rejected"]).parse(value);
}

export function codexDynamicPatchToolResponse(
	outcome: CodexDynamicPatchToolOutcome,
): CodexDynamicPatchToolResponse {
	return structuredClone(outcome === "applied" ? appliedResponse : rejectedResponse);
}

function hasUnpairedSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true;
		}
	}
	return false;
}

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0)!;
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
	}
	return false;
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const entry of Object.values(value)) deepFreeze(entry);
	return value;
}
