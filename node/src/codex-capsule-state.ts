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
	jsonValueSchema,
	sessionInputSchema,
	startTurnInputSchema,
	uuidSchema,
} from "@agentrelay/protocol";
import { z } from "zod";
import { digestCanonicalJson, digestStartTurnInput, executionKey } from "./capsule-correlation.js";
import { SUPPORTED_CODEX_CLI_VERSION } from "./codex-app-server-protocol.js";
import { buildCodexCapsuleTurnIntent } from "./codex-capsule-prompt.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const localReferenceSchema = z.string().min(1).max(256);
const providerReferenceSchema = z.string().min(1).max(1_024);

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
		prompt_version: z.literal(1),
		client_user_message_id: providerReferenceSchema,
		text: z.string().min(1).max(1_048_576),
		text_sha256: sha256Schema,
		output_schema: jsonValueSchema,
		output_schema_sha256: sha256Schema,
	})
	.strict();

const storedCodexTurnSchema = z
	.object({
		input: startTurnInputSchema,
		input_sha256: sha256Schema,
		host_turn_id: localReferenceSchema,
		phase: z.enum(["prepared", "start_maybe_sent", "accepted", "cancelling", "terminal"]),
		codex_turn_id: providerReferenceSchema.nullable(),
		provider_intent: storedProviderIntentSchema,
		cancellation: z.enum(["none", "requested", "interrupt_maybe_sent"]),
		events: z.array(hostEventSchema),
		created_at: z.string().datetime({ offset: true }),
		updated_at: z.string().datetime({ offset: true }),
	})
	.strict();

export const codexCapsuleStateSchema = z
	.object({
		schema_version: z.literal(1),
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
		schema_version: 1,
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
	return state;
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
	const expectedIntent = buildCodexCapsuleTurnIntent(turn.input);
	if (
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
	validateTurnEvents(turn);
}

function validateTurnPhase(turn: StoredCodexTurn): void {
	const accepted = ["accepted", "cancelling", "terminal"].includes(turn.phase);
	if (accepted !== (turn.codex_turn_id !== null)) {
		throw new Error("Codex Capsule turn phase does not match its provider binding");
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

function validateTurnEvents(turn: StoredCodexTurn): void {
	let stream = createHostEventStreamState({ ...hostTurnFromStored(turn), turnId: undefined });
	for (const event of turn.events) {
		stream = acceptHostEvent(stream, event, DEFAULT_HOST_EVENT_STREAM_POLICY).state;
	}
	const shouldHaveEvents = ["accepted", "cancelling", "terminal"].includes(turn.phase);
	if (shouldHaveEvents !== turn.events.length > 0) {
		throw new Error("Codex Capsule turn phase does not match its durable event stream");
	}
	if ((turn.phase === "terminal") !== (stream.phase === "terminal")) {
		throw new Error("Codex Capsule terminal phase does not match its event stream");
	}
}

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function cloneStoredEvents(turn: StoredCodexTurn): readonly HostEvent[] {
	return structuredClone(turn.events);
}
