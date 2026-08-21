import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	DEFAULT_HOST_EVENT_STREAM_POLICY,
	type HostEvent,
	type HostSessionRef,
	type HostTurnRef,
	type SessionInput,
	acceptHostEvent,
	createHostEventStreamState,
	hostEventSchema,
	hostTurnRefSchema,
	jsonValueSchema,
	sessionInputSchema,
	startTurnInputSchema,
	uuidSchema,
} from "@agentrelay/protocol";
import { z } from "zod";
import { digestCanonicalJson, digestStartTurnInput, executionKey } from "./capsule-correlation.js";
import { SUPPORTED_CODEX_CLI_VERSION } from "./codex-app-server-protocol.js";
import {
	CODEX_CAPSULE_PROMPT_VERSION,
	buildCodexCapsuleTurnIntent,
} from "./codex-capsule-prompt.js";
import { CODEX_DYNAMIC_PATCH_TOOL_CONTRACT } from "./codex-dynamic-patch-tool-contract.js";
import {
	CODEX_PATCH_MAX_BYTES,
	codexPatchAuthoritySchema,
	codexPatchResultSchema,
	codexPatchSha256,
	codexPatchTransactionId,
} from "./codex-workspace-patch-contract.js";
import { MAX_PRIVATE_STATE_FILE_BYTES } from "./private-state-file.js";

export const CODEX_CAPSULE_STATE_SCHEMA_VERSION = 4;
export const CODEX_PATCH_MAX_CALLS_PER_TURN = 32;
export const CODEX_PATCH_MAX_RETAINED_RAW_BYTES_PER_TURN = 1_048_576;
export const CODEX_CAPSULE_STATE_TERMINAL_RECEIPT_RESERVE_BYTES = 4_096;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const localReferenceSchema = z.string().min(1).max(256);
const providerReferenceSchema = z
	.string()
	.min(1)
	.max(512)
	.refine((value) => isPrintableUnicode(value), {
		message: "Provider references must be valid, printable Unicode",
	});

const storedSessionSchema = z
	.object({
		input: sessionInputSchema,
		input_sha256: sha256Schema,
		host_session_id: localReferenceSchema,
		phase: z.enum(["prepared", "start_maybe_sent", "ready"]),
		codex_thread_id: providerReferenceSchema.nullable(),
	})
	.strict();

const storedProviderIntentSchema = z
	.object({
		prompt_version: z.literal(CODEX_CAPSULE_PROMPT_VERSION),
		tool_contract: z.literal(CODEX_DYNAMIC_PATCH_TOOL_CONTRACT).nullable(),
		client_user_message_id: providerReferenceSchema,
		text: z.string().min(1).max(1_048_576),
		text_sha256: sha256Schema,
		output_schema: jsonValueSchema,
		output_schema_sha256: sha256Schema,
	})
	.strict();

export const storedCodexPatchReceiptSchema = z.discriminatedUnion("outcome", [
	z.object({ outcome: z.literal("applied"), result: codexPatchResultSchema }).strict(),
	z
		.object({
			outcome: z.literal("rejected"),
			source: z.enum(["capsule_policy", "mediator"]),
		})
		.strict(),
	z.object({ outcome: z.literal("failed"), classification: z.literal("fatal") }).strict(),
	z.object({ outcome: z.literal("indeterminate") }).strict(),
]);

const storedCodexPatchCallSchema = z
	.object({
		transaction_id: sha256Schema,
		provider_thread_id: providerReferenceSchema,
		provider_turn_id: providerReferenceSchema,
		call_id: providerReferenceSchema,
		host_turn: hostTurnRefSchema,
		authority: codexPatchAuthoritySchema,
		patch_sha256: sha256Schema,
		patch_bytes: z.number().int().nonnegative().max(CODEX_PATCH_MAX_BYTES),
		patch: z.string().nullable(),
		receipt: storedCodexPatchReceiptSchema.nullable(),
		created_at: z.string().datetime({ offset: true }),
		updated_at: z.string().datetime({ offset: true }),
	})
	.strict()
	.superRefine((call, context) => {
		if ((call.patch === null) !== (call.receipt !== null)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Raw patch retention must end exactly when a receipt is durable",
				path: ["patch"],
			});
		}
		if (call.patch !== null) {
			try {
				if (
					call.patch_bytes !== Buffer.byteLength(call.patch, "utf8") ||
					call.patch_sha256 !== codexPatchSha256(call.patch)
				) {
					context.addIssue({
						code: z.ZodIssueCode.custom,
						message: "Retained patch does not match its durable digest",
						path: ["patch"],
					});
				}
			} catch {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Retained patch is invalid",
					path: ["patch"],
				});
			}
		}
		if (
			call.receipt?.outcome === "applied" &&
			(call.receipt.result.transactionId !== call.transaction_id ||
				call.receipt.result.patchSha256 !== call.patch_sha256)
		) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Applied patch receipt does not match its durable request",
				path: ["receipt"],
			});
		}
	});

const storedCodexPatchCallsSchema = z
	.record(sha256Schema, storedCodexPatchCallSchema)
	.superRefine((calls, context) => {
		const values = Object.values(calls);
		if (values.length > CODEX_PATCH_MAX_CALLS_PER_TURN) {
			context.addIssue({
				code: z.ZodIssueCode.too_big,
				maximum: CODEX_PATCH_MAX_CALLS_PER_TURN,
				type: "array",
				inclusive: true,
				message: "Codex patch call limit exceeded",
			});
		}
		const pending = values.filter((call) => call.receipt === null);
		const retainedBytes = pending.reduce((total, call) => total + call.patch_bytes, 0);
		if (retainedBytes > CODEX_PATCH_MAX_RETAINED_RAW_BYTES_PER_TURN) {
			context.addIssue({
				code: z.ZodIssueCode.too_big,
				maximum: CODEX_PATCH_MAX_RETAINED_RAW_BYTES_PER_TURN,
				type: "array",
				inclusive: true,
				message: "Codex retained patch bytes exceed the aggregate limit",
			});
		}
	});

const storedCodexTurnSchema = z
	.object({
		input: startTurnInputSchema,
		input_sha256: sha256Schema,
		host_turn_id: localReferenceSchema,
		phase: z.enum(["prepared", "start_maybe_sent", "accepted", "cancelling", "terminal"]),
		codex_turn_id: providerReferenceSchema.nullable(),
		provider_intent: storedProviderIntentSchema,
		cancellation: z.enum(["none", "requested", "interrupt_maybe_sent"]),
		patch_calls: storedCodexPatchCallsSchema,
		events: z.array(hostEventSchema).min(1),
		created_at: z.string().datetime({ offset: true }),
		updated_at: z.string().datetime({ offset: true }),
	})
	.strict();

export const codexCapsuleStateSchema = z
	.object({
		schema_version: z.literal(CODEX_CAPSULE_STATE_SCHEMA_VERSION),
		capsule_id: uuidSchema,
		created_at: z.string().datetime({ offset: true }),
		updated_at: z.string().datetime({ offset: true }),
		runtime: z
			.object({
				kind: z.literal("codex_app_server"),
				cli_version: z.literal(SUPPORTED_CODEX_CLI_VERSION),
			})
			.strict(),
		session: storedSessionSchema,
		turns: z
			.record(storedCodexTurnSchema)
			.refine((turns) => Object.keys(turns).length <= 200, "Codex Capsule turn limit exceeded"),
	})
	.strict();

export type CodexCapsuleState = z.infer<typeof codexCapsuleStateSchema>;
export type StoredCodexTurn = z.infer<typeof storedCodexTurnSchema>;
export type StoredCodexPatchCall = z.infer<typeof storedCodexPatchCallSchema>;
export type StoredCodexPatchReceipt = z.infer<typeof storedCodexPatchReceiptSchema>;

export interface CodexCapsuleIdentity {
	readonly capsuleId: string;
	readonly session: SessionInput;
}

export function createCodexCapsuleState(
	identityValue: CodexCapsuleIdentity,
	now: Date,
): CodexCapsuleState {
	const identity = parseIdentity(identityValue);
	const timestamp = now.toISOString();
	return codexCapsuleStateSchema.parse({
		schema_version: CODEX_CAPSULE_STATE_SCHEMA_VERSION,
		capsule_id: identity.capsuleId,
		created_at: timestamp,
		updated_at: timestamp,
		runtime: { kind: "codex_app_server", cli_version: SUPPORTED_CODEX_CLI_VERSION },
		session: {
			input: identity.session,
			input_sha256: digestCanonicalJson(identity.session),
			host_session_id: `capsule-session-${randomUUID()}`,
			phase: "prepared",
			codex_thread_id: null,
		},
		turns: {},
	});
}

export function validateCodexCapsuleState(
	identityValue: CodexCapsuleIdentity,
	stateValue: unknown,
): CodexCapsuleState {
	const identity = parseIdentity(identityValue);
	const state = codexCapsuleStateSchema.parse(stateValue);
	if (state.capsule_id !== identity.capsuleId) {
		throw new Error("Codex Capsule state belongs to another capsule generation");
	}
	if (!isDeepStrictEqual(state.session.input, identity.session)) {
		throw new Error("Codex Capsule state belongs to another Mission session scope");
	}
	validateSession(state);
	let activeTurns = 0;
	for (const [key, turn] of Object.entries(state.turns)) {
		validateTurn(state, key, turn);
		if (turn.phase !== "terminal") activeTurns += 1;
	}
	if (activeTurns > 1) throw new Error("Codex Capsule contains multiple active turns");
	if (state.session.phase !== "ready" && Object.keys(state.turns).length > 0) {
		throw new Error("Codex Capsule contains turns before its runtime session is ready");
	}
	assertCodexCapsuleStateStorageBound(state);
	return state;
}

/** Leaves per-request space for the largest fixed terminal receipt before publishing raw input. */
export function assertCodexCapsuleStateStorageBound(state: CodexCapsuleState): void {
	const pendingPatchCalls = Object.values(state.turns).reduce(
		(total, turn) =>
			total + Object.values(turn.patch_calls).filter((call) => call.receipt === null).length,
		0,
	);
	const reserve = pendingPatchCalls * CODEX_CAPSULE_STATE_TERMINAL_RECEIPT_RESERVE_BYTES;
	const serialized = JSON.stringify(state, null, 2);
	if (
		serialized === undefined ||
		Buffer.byteLength(`${serialized}\n`, "utf8") > MAX_PRIVATE_STATE_FILE_BYTES - reserve
	) {
		throw new Error("Codex Capsule state exceeds its durable write budget");
	}
}

export function hostSessionFromState(state: CodexCapsuleState): HostSessionRef {
	return {
		...structuredClone(state.session.input),
		sessionId: state.session.host_session_id,
	};
}

export function hostTurnFromStored(turn: StoredCodexTurn): HostTurnRef {
	return {
		turnId: turn.host_turn_id,
		sessionId: turn.input.session.sessionId,
		missionId: turn.input.missionId,
		deliveryId: turn.input.deliveryId,
		executionAttempt: turn.input.executionAttempt,
		contractVersion: turn.input.contractVersion,
	};
}

export function isStoredTurnTerminal(turn: StoredCodexTurn): boolean {
	return turn.phase === "terminal";
}

function parseIdentity(identity: CodexCapsuleIdentity): CodexCapsuleIdentity {
	return {
		capsuleId: uuidSchema.parse(identity.capsuleId),
		session: sessionInputSchema.parse(identity.session),
	};
}

function validateSession(state: CodexCapsuleState): void {
	if (state.session.input_sha256 !== digestCanonicalJson(state.session.input)) {
		throw new Error("Codex Capsule session digest does not match its exact input");
	}
	const hasThread = state.session.codex_thread_id !== null;
	if ((state.session.phase === "ready") !== hasThread) {
		throw new Error("Codex Capsule session phase does not match its thread binding");
	}
}

function validateTurn(state: CodexCapsuleState, key: string, turn: StoredCodexTurn): void {
	if (key !== executionKey(turn.input.deliveryId, turn.input.executionAttempt)) {
		throw new Error("Codex Capsule turn is stored under the wrong execution key");
	}
	if (turn.input_sha256 !== digestStartTurnInput(turn.input)) {
		throw new Error("Codex Capsule turn digest does not match its exact input");
	}
	if (!isDeepStrictEqual(turn.input.session, hostSessionFromState(state))) {
		throw new Error("Codex Capsule turn does not belong to its runtime session");
	}
	const expectedIntent = buildCodexCapsuleTurnIntent(
		turn.input,
		turn.provider_intent.tool_contract,
	);
	if (
		turn.provider_intent.prompt_version !== expectedIntent.promptVersion ||
		turn.provider_intent.tool_contract !== expectedIntent.toolContract ||
		turn.provider_intent.client_user_message_id !== expectedIntent.clientUserMessageId ||
		turn.provider_intent.text !== expectedIntent.text ||
		turn.provider_intent.text_sha256 !== expectedIntent.textSha256 ||
		!isDeepStrictEqual(turn.provider_intent.output_schema, expectedIntent.outputSchema) ||
		turn.provider_intent.output_schema_sha256 !== expectedIntent.outputSchemaSha256 ||
		turn.provider_intent.text_sha256 !== sha256(turn.provider_intent.text) ||
		turn.provider_intent.output_schema_sha256 !==
			digestCanonicalJson(turn.provider_intent.output_schema)
	) {
		throw new Error("Codex Capsule provider intent does not match its exact turn input");
	}
	validateTurnPhase(turn);
	validatePatchCalls(state, turn);
	validateTurnEvents(turn);
}

function validateTurnPhase(turn: StoredCodexTurn): void {
	if (["prepared", "start_maybe_sent"].includes(turn.phase) && turn.codex_turn_id !== null) {
		throw new Error("Codex Capsule turn crossed a provider binding before its start phase");
	}
	if (turn.phase === "accepted" && turn.codex_turn_id === null) {
		throw new Error("Accepted Codex turn is missing its provider binding");
	}
	if (turn.phase === "cancelling" && turn.cancellation === "none") {
		throw new Error("Cancelling Codex turn is missing its cancellation barrier");
	}
	if (turn.phase !== "cancelling" && turn.phase !== "terminal" && turn.cancellation !== "none") {
		throw new Error("Codex turn has a cancellation barrier in the wrong phase");
	}
	if (
		turn.phase === "terminal" &&
		turn.events.at(-1)?.kind === "cancelled" &&
		turn.cancellation === "none"
	) {
		throw new Error("Cancelled Codex turn lacks a durable local cancellation intent");
	}
}

function validatePatchCalls(state: CodexCapsuleState, turn: StoredCodexTurn): void {
	const hostTurn = hostTurnFromStored(turn);
	if (
		Object.keys(turn.patch_calls).length > 0 &&
		turn.provider_intent.tool_contract !== CODEX_DYNAMIC_PATCH_TOOL_CONTRACT
	) {
		throw new Error("Codex patch calls require the exact durable provider tool contract");
	}
	for (const [transactionId, call] of Object.entries(turn.patch_calls)) {
		if (transactionId !== call.transaction_id) {
			throw new Error("Codex patch call is stored under the wrong transaction ID");
		}
		if (
			state.session.codex_thread_id === null ||
			call.provider_thread_id !== state.session.codex_thread_id ||
			turn.codex_turn_id === null ||
			call.provider_turn_id !== turn.codex_turn_id ||
			!isDeepStrictEqual(call.host_turn, hostTurn)
		) {
			throw new Error("Codex patch call does not match its durable turn binding");
		}
		if (
			call.authority.delivery_id !== call.host_turn.deliveryId ||
			call.authority.execution_attempt !== call.host_turn.executionAttempt
		) {
			throw new Error("Codex patch authority does not match its durable Host turn");
		}
		const expectedTransactionId = codexPatchTransactionId({
			capsule_id: state.capsule_id,
			provider_thread_id: call.provider_thread_id,
			provider_turn_id: call.provider_turn_id,
			call_id: call.call_id,
		});
		if (call.transaction_id !== expectedTransactionId) {
			throw new Error("Codex patch transaction ID does not match its exact provider key");
		}
	}
	if (
		turn.phase === "terminal" &&
		Object.values(turn.patch_calls).some((call) => call.receipt === null)
	) {
		throw new Error("Terminal Codex turn retains an unresolved patch request");
	}
}

function validateTurnEvents(turn: StoredCodexTurn): void {
	let stream = createHostEventStreamState({ ...hostTurnFromStored(turn), turnId: undefined });
	for (const event of turn.events) {
		stream = acceptHostEvent(stream, event, DEFAULT_HOST_EVENT_STREAM_POLICY).state;
	}
	if ((turn.phase === "terminal") !== (stream.phase === "terminal")) {
		throw new Error("Codex Capsule terminal phase does not match its event stream");
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPrintableUnicode(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			index += 1;
			continue;
		}
		if (code >= 0xdc00 && code <= 0xdfff) return false;
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
	}
	return true;
}

export function cloneStoredEvents(turn: StoredCodexTurn): readonly HostEvent[] {
	return structuredClone(turn.events);
}
