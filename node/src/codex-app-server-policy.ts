import { type JsonValue, jsonValueSchema } from "@agentrelay/protocol";
import { z } from "zod";
import { CodexAppServerError } from "./codex-app-server-process.js";
import {
	CODEX_APP_SERVER_CLIENT_NAME,
	type CodexInitializeResponse,
	type CodexThread,
	type CodexThreadStartResult,
	SUPPORTED_CODEX_CLI_VERSION,
} from "./codex-app-server-protocol.js";
import type {
	CodexServerRequest,
	CodexServerRequestDecision,
} from "./codex-app-server-transport.js";

export const CODEX_APP_SERVER_CLIENT_VERSION = "0.0.1";

const MAX_TURN_INPUT_BYTES = 1_048_576;
const MAX_OUTPUT_SCHEMA_BYTES = 256 * 1_024;
const opaqueReferenceSchema = z.string().min(1).max(1_024);
export const codexEmptyResultSchema = z.object({}).strict();
const outputSchema = jsonValueSchema.refine(
	(value) => value !== null && !Array.isArray(value) && typeof value === "object",
	"Codex output schema must be a JSON object",
);
const startCodexTurnInputSchema = z
	.object({
		threadId: opaqueReferenceSchema,
		clientUserMessageId: opaqueReferenceSchema,
		text: z.string().min(1).max(MAX_TURN_INPUT_BYTES),
		cwd: z.string().min(1).max(4_096),
		outputSchema,
	})
	.strict();

export interface StartCodexTurnInput {
	readonly threadId: string;
	readonly clientUserMessageId: string;
	readonly text: string;
	readonly cwd: string;
	readonly outputSchema: JsonValue;
}

export const QUIET_CODEX_NOTIFICATION_METHODS = [
	"item/agentMessage/delta",
	"item/plan/delta",
	"item/reasoning/summaryTextDelta",
	"item/reasoning/summaryPartAdded",
	"item/reasoning/textDelta",
	"item/commandExecution/outputDelta",
	"item/fileChange/outputDelta",
	"turn/diff/updated",
	"turn/plan/updated",
] as const;

export function parseCodexReference(value: string): string {
	return opaqueReferenceSchema.parse(value);
}

export function parseStartCodexTurnInput(
	value: StartCodexTurnInput,
	expectedCwd: string,
): z.output<typeof startCodexTurnInputSchema> {
	const input = startCodexTurnInputSchema.parse(value);
	if (Buffer.byteLength(input.text, "utf8") > MAX_TURN_INPUT_BYTES) {
		throw new CodexAppServerError("policy", "Codex turn input exceeds the byte limit");
	}
	if (input.cwd !== expectedCwd) {
		throw new CodexAppServerError("policy", "Codex turn cannot change the Capsule workspace");
	}
	if (Buffer.byteLength(JSON.stringify(input.outputSchema), "utf8") > MAX_OUTPUT_SCHEMA_BYTES) {
		throw new CodexAppServerError("policy", "Codex output schema exceeds the byte limit");
	}
	return input;
}

export function parseCodexProviderResult<TSchema extends z.ZodTypeAny>(
	schema: TSchema,
	value: unknown,
	method: string,
): z.infer<TSchema> {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new CodexAppServerError("protocol", `Codex ${method} returned an invalid payload`, {
			cause: parsed.error,
		});
	}
	return parsed.data;
}

export function assertCodexIdentity(
	response: CodexInitializeResponse,
	expectedCodexHome: string,
): void {
	const expectedPrefix = `${CODEX_APP_SERVER_CLIENT_NAME}/${SUPPORTED_CODEX_CLI_VERSION} (`;
	if (!response.userAgent.startsWith(expectedPrefix)) {
		throw new CodexAppServerError(
			"version",
			`Unsupported Codex app-server identity; expected ${SUPPORTED_CODEX_CLI_VERSION}`,
		);
	}
	if (response.platformFamily !== "unix") {
		throw new CodexAppServerError("policy", "Codex Mission Capsules currently require Unix");
	}
	if (response.codexHome !== expectedCodexHome) {
		throw new CodexAppServerError("policy", "Codex used an unexpected home directory");
	}
}

export function assertReadOnlyThread(
	result: CodexThreadStartResult,
	cwd: string,
	expectedThreadId?: string,
): void {
	assertThreadVersionAndScope(result.thread, cwd, expectedThreadId);
	if (
		result.cwd !== cwd ||
		result.approvalPolicy !== "never" ||
		result.approvalsReviewer !== "user"
	) {
		throw new CodexAppServerError("policy", "Codex did not preserve the requested local policy");
	}
	if (result.sandbox.type !== "readOnly" || result.sandbox.networkAccess !== false) {
		throw new CodexAppServerError("policy", "Codex did not enter the required read-only sandbox");
	}
}

export function assertThreadVersionAndScope(
	thread: CodexThread,
	cwd: string,
	expectedThreadId?: string,
): void {
	if (thread.cliVersion !== SUPPORTED_CODEX_CLI_VERSION) {
		throw new CodexAppServerError(
			"version",
			`Codex thread was created by unsupported CLI ${thread.cliVersion}`,
		);
	}
	if (thread.cwd !== cwd || thread.ephemeral) {
		throw new CodexAppServerError("policy", "Codex thread is outside the persistent Capsule scope");
	}
	if (expectedThreadId !== undefined && thread.id !== expectedThreadId) {
		throw new CodexAppServerError("protocol", "Codex returned a different thread identity");
	}
}

export function denyCodexServerRequest(request: CodexServerRequest): CodexServerRequestDecision {
	const fatal = new CodexAppServerError(
		"policy",
		`Codex app-server requested unsupported authority: ${request.method}`,
	);
	switch (request.method) {
		case "item/commandExecution/requestApproval":
		case "item/fileChange/requestApproval":
			return { kind: "result", value: { decision: "decline" }, fatal };
		case "item/permissions/requestApproval":
			return { kind: "result", value: { permissions: {}, scope: "turn" }, fatal };
		case "item/tool/requestUserInput":
			return { kind: "result", value: { answers: {} }, fatal };
		case "mcpServer/elicitation/request":
			return { kind: "result", value: { action: "decline", content: null, _meta: null }, fatal };
		case "item/tool/call":
			return { kind: "result", value: { contentItems: [], success: false }, fatal };
		case "applyPatchApproval":
		case "execCommandApproval":
			return {
				kind: "result",
				value: { decision: { denied: { rejection: "AgentRelay local policy denied approval" } } },
				fatal,
			};
		default:
			return {
				kind: "error",
				code: -32601,
				message: "AgentRelay does not implement this server request",
				fatal,
			};
	}
}
