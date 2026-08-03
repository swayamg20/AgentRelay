import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	type Delivery,
	type HostEvent,
	type HostSessionRef,
	type MissionDeliveryItem,
	type MissionParticipantAcceptanceInput,
	type NodeDeliveryResultPayload,
	deliveryClaimInputSchema,
	deliveryCompleteInputSchema,
	deliveryReleaseInputSchema,
	deliveryRenewInputSchema,
	deliveryStartInputSchema,
	hostEventSchema,
	hostSessionRefSchema,
	missionDeliveryItemSchema,
	missionParticipantAcceptanceInputSchema,
	nodeDeliveryResultPayloadSchema,
	uuidSchema,
} from "@agentrelay/protocol";
import { z } from "zod";

const journalPhaseSchema = z.enum([
	"ingested",
	"claim_intent",
	"claimed",
	"start_intent",
	"relay_executing",
	"host_accepted",
	"host_terminal",
	"complete_intent",
	"release_intent",
	"lease_lost",
	"acknowledged",
	"dead_lettered",
	"authority_lost",
]);

const operationIntentSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("claim"), input: deliveryClaimInputSchema }).strict(),
	z.object({ kind: z.literal("start"), input: deliveryStartInputSchema }).strict(),
	z.object({ kind: z.literal("renew"), input: deliveryRenewInputSchema }).strict(),
	z.object({ kind: z.literal("complete"), input: deliveryCompleteInputSchema }).strict(),
	z.object({ kind: z.literal("release"), input: deliveryReleaseInputSchema }).strict(),
]);

const archivedHostExecutionSchema = z
	.object({
		execution_attempt: z.number().int().positive().max(100),
		host_events: z.array(hostEventSchema).max(4_096),
		result: nodeDeliveryResultPayloadSchema.nullable(),
		archived_at: z.string().datetime(),
	})
	.strict();

const journalDeliverySchema = z
	.object({
		item: missionDeliveryItemSchema,
		identity_sha256: z.string().regex(/^[a-f0-9]{64}$/),
		phase: journalPhaseSchema,
		claim_attempt: z.number().int().nonnegative().max(100),
		renew_count: z.number().int().nonnegative(),
		operation: operationIntentSchema.nullable(),
		host_session: hostSessionRefSchema.nullable(),
		execution_attempt: z.number().int().positive().max(100),
		host_attempt_history: z.array(archivedHostExecutionSchema).max(99),
		host_events: z.array(hostEventSchema).max(4_096),
		result: nodeDeliveryResultPayloadSchema.nullable(),
		last_error: z.string().max(2_000).nullable(),
		updated_at: z.string().datetime(),
	})
	.strict()
	.superRefine((entry, ctx) => {
		if (entry.identity_sha256 !== deliveryIdentityDigest(entry.item)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Delivery identity digest does not match the journaled item",
				path: ["identity_sha256"],
			});
		}
		const accepted = entry.host_events.find((event) => event.kind === "accepted");
		if (accepted && entry.host_session?.sessionId !== accepted.turn.sessionId) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Host acceptance must belong to the journaled session",
				path: ["host_events"],
			});
		}
		for (const [index, event] of entry.host_events.entries()) {
			if (event.turn.executionAttempt !== entry.execution_attempt) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Active host event belongs to a different execution attempt",
					path: ["host_events", index, "turn", "executionAttempt"],
				});
			}
		}
		const archivedAttempts = new Set<number>();
		for (const [historyIndex, attempt] of entry.host_attempt_history.entries()) {
			if (
				attempt.execution_attempt >= entry.execution_attempt ||
				archivedAttempts.has(attempt.execution_attempt)
			) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Archived host execution attempts must be unique and precede the active attempt",
					path: ["host_attempt_history", historyIndex, "execution_attempt"],
				});
			}
			archivedAttempts.add(attempt.execution_attempt);
			for (const [eventIndex, event] of attempt.host_events.entries()) {
				if (event.turn.executionAttempt !== attempt.execution_attempt) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: "Archived host event belongs to a different execution attempt",
						path: [
							"host_attempt_history",
							historyIndex,
							"host_events",
							eventIndex,
							"turn",
							"executionAttempt",
						],
					});
				}
			}
		}
	});

const missionAcceptanceJournalSchema = z
	.object({
		input: missionParticipantAcceptanceInputSchema,
		status: z.enum(["pending", "accepted", "quarantined"]),
		last_error: z.string().max(2_000).nullable(),
	})
	.strict();

export const nodeJournalStateSchema = z
	.object({
		schema_version: z.literal(1),
		cursor: z
			.string()
			.regex(/^[1-9][0-9]*$/)
			.nullable(),
		mission_assignment_cursor: uuidSchema.nullable().default(null),
		deliveries: z.record(uuidSchema, journalDeliverySchema),
		mission_sessions: z.record(uuidSchema, hostSessionRefSchema),
		mission_acceptances: z.record(uuidSchema, missionAcceptanceJournalSchema),
	})
	.strict()
	.superRefine((state, ctx) => {
		for (const [deliveryId, entry] of Object.entries(state.deliveries)) {
			if (entry.item.delivery.delivery_id !== deliveryId) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Journal delivery key must match the payload",
					path: ["deliveries", deliveryId],
				});
			}
		}
		for (const [missionId, session] of Object.entries(state.mission_sessions)) {
			if (session.missionId !== missionId) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Journal Mission key must match the host session",
					path: ["mission_sessions", missionId],
				});
			}
		}
	});

export type JournalPhase = z.infer<typeof journalPhaseSchema>;
export type OperationIntent = z.infer<typeof operationIntentSchema>;
export type JournalDelivery = z.infer<typeof journalDeliverySchema>;
export type NodeJournalState = z.infer<typeof nodeJournalStateSchema>;

export interface JournalStorage {
	load(): Promise<unknown | null>;
	save(state: NodeJournalState): Promise<void>;
}

export class NodeJournal {
	readonly #storage: JournalStorage;
	#state: NodeJournalState;
	#tail: Promise<void> = Promise.resolve();

	private constructor(storage: JournalStorage, state: NodeJournalState) {
		this.#storage = storage;
		this.#state = state;
	}

	static async open(storage: JournalStorage): Promise<NodeJournal> {
		const stored = await storage.load();
		const state = nodeJournalStateSchema.parse(
			stored ?? {
				schema_version: 1,
				cursor: null,
				mission_assignment_cursor: null,
				deliveries: {},
				mission_sessions: {},
				mission_acceptances: {},
			},
		);
		if (
			stored === null ||
			(typeof stored === "object" &&
				stored !== null &&
				!Object.hasOwn(stored, "mission_assignment_cursor"))
		) {
			await storage.save(state);
		}
		return new NodeJournal(storage, state);
	}

	snapshot(): NodeJournalState {
		return structuredClone(this.#state);
	}

	async ingestCursorPage(
		items: readonly MissionDeliveryItem[],
		nextCursor: string | null,
		now = new Date(),
	): Promise<void> {
		await this.update((state) => {
			for (const item of items) upsertDelivery(state, item, now);
			if (nextCursor !== null) {
				if (state.cursor !== null && compareCursor(nextCursor, state.cursor) < 0) {
					throw new Error(`delivery cursor moved backwards: ${state.cursor} -> ${nextCursor}`);
				}
				state.cursor = nextCursor;
			}
		});
	}

	async ingestRecoverable(items: readonly MissionDeliveryItem[], now = new Date()): Promise<void> {
		await this.update((state) => {
			for (const item of items) upsertDelivery(state, item, now);
		});
	}

	async setMissionAssignmentCursor(cursorInput: string | null): Promise<void> {
		const cursor = uuidSchema.nullable().parse(cursorInput);
		await this.update((state) => {
			state.mission_assignment_cursor = cursor;
		});
	}

	async updateDelivery(
		deliveryId: string,
		mutate: (entry: JournalDelivery) => void,
	): Promise<JournalDelivery> {
		return this.update((state) => {
			const entry = state.deliveries[uuidSchema.parse(deliveryId)];
			if (!entry) throw new Error(`delivery is not journaled: ${deliveryId}`);
			mutate(entry);
			return structuredClone(entry);
		});
	}

	async setMissionSession(sessionInput: HostSessionRef): Promise<void> {
		const session = hostSessionRefSchema.parse(sessionInput);
		await this.update((state) => {
			const existing = state.mission_sessions[session.missionId];
			if (existing && !isDeepStrictEqual(existing, session)) {
				throw new Error(`Mission already has a different host session: ${session.missionId}`);
			}
			state.mission_sessions[session.missionId] = structuredClone(session);
		});
	}

	async recordMissionAcceptance(
		missionIdInput: string,
		inputValue: MissionParticipantAcceptanceInput,
		status: "pending" | "accepted",
	): Promise<void> {
		const missionId = uuidSchema.parse(missionIdInput);
		const input = missionParticipantAcceptanceInputSchema.parse(inputValue);
		await this.update((state) => {
			const existing = state.mission_acceptances[missionId];
			if (existing && !isDeepStrictEqual(existing.input, input)) {
				throw new Error(`Mission acceptance changed after it was journaled: ${missionId}`);
			}
			if (existing?.status === "accepted" && status === "pending") {
				throw new Error(`Accepted Mission cannot return to pending: ${missionId}`);
			}
			if (existing?.status === "quarantined") {
				throw new Error(`Quarantined Mission acceptance cannot be resubmitted: ${missionId}`);
			}
			state.mission_acceptances[missionId] = {
				input: structuredClone(input),
				status,
				last_error: null,
			};
		});
	}

	async quarantineMissionAcceptance(missionIdInput: string, error: string): Promise<void> {
		const missionId = uuidSchema.parse(missionIdInput);
		const summary = error.slice(0, 2_000);
		await this.update((state) => {
			const existing = state.mission_acceptances[missionId];
			if (!existing) throw new Error(`Mission acceptance is not journaled: ${missionId}`);
			if (existing.status === "accepted") {
				throw new Error(`Accepted Mission cannot be quarantined: ${missionId}`);
			}
			existing.status = "quarantined";
			existing.last_error = summary;
		});
	}

	async replaceDeliveryState(deliveryInput: Delivery, now = new Date()): Promise<JournalDelivery> {
		return this.updateDelivery(deliveryInput.delivery_id, (entry) => {
			const delivery = structuredClone(deliveryInput);
			assertSameDeliveryIdentity(entry.item.delivery, delivery);
			entry.item.delivery = delivery;
			entry.updated_at = now.toISOString();
		});
	}

	async update<T>(mutate: (state: NodeJournalState) => T | Promise<T>): Promise<T> {
		let resolveResult!: (result: T) => void;
		let rejectResult!: (error: unknown) => void;
		const result = new Promise<T>((resolve, reject) => {
			resolveResult = resolve;
			rejectResult = reject;
		});

		this.#tail = this.#tail.then(async () => {
			try {
				const next = structuredClone(this.#state);
				const value = await mutate(next);
				const validated = nodeJournalStateSchema.parse(next);
				await this.#storage.save(validated);
				this.#state = validated;
				resolveResult(value);
			} catch (error) {
				rejectResult(error);
			}
		});
		await this.#tail;
		return result;
	}
}

function upsertDelivery(state: NodeJournalState, itemInput: MissionDeliveryItem, now: Date): void {
	const item = missionDeliveryItemSchema.parse(itemInput);
	const deliveryId = item.delivery.delivery_id;
	const digest = deliveryIdentityDigest(item);
	const existing = state.deliveries[deliveryId];
	if (!existing) {
		state.deliveries[deliveryId] = {
			item: structuredClone(item),
			identity_sha256: digest,
			phase: "ingested",
			claim_attempt: 0,
			renew_count: 0,
			operation: null,
			host_session: null,
			execution_attempt: 1,
			host_attempt_history: [],
			host_events: [],
			result: null,
			last_error: null,
			updated_at: now.toISOString(),
		};
		return;
	}
	if (existing.identity_sha256 !== digest) {
		throw new Error(`delivery replay changed immutable content: ${deliveryId}`);
	}
	assertSameDeliveryIdentity(existing.item.delivery, item.delivery);
	existing.item.delivery = structuredClone(item.delivery);
	existing.updated_at = now.toISOString();
}

function deliveryIdentityDigest(item: MissionDeliveryItem): string {
	const { delivery } = item;
	return createHash("sha256")
		.update(
			canonicalJson({
				delivery: {
					delivery_id: delivery.delivery_id,
					node_id: delivery.node_id,
					mission_id: delivery.mission_id,
					mission_event_id: delivery.mission_event_id,
					kind: delivery.kind,
					cursor: delivery.cursor,
					contract_version: delivery.contract_version,
					verification_round: delivery.verification_round,
					idempotency_key: delivery.idempotency_key,
					causal_parent_delivery_id: delivery.causal_parent_delivery_id,
				},
				event: item.event,
				actor_agent_id: item.actor_agent_id,
				source_delivery_id: item.source_delivery_id,
				causal_parent_event_id: item.causal_parent_event_id,
			}),
			"utf8",
		)
		.digest("hex");
}

function assertSameDeliveryIdentity(previous: Delivery, next: Delivery): void {
	for (const field of [
		"delivery_id",
		"node_id",
		"mission_id",
		"mission_event_id",
		"kind",
		"cursor",
		"contract_version",
		"verification_round",
		"idempotency_key",
		"causal_parent_delivery_id",
	] as const) {
		if (previous[field] !== next[field]) {
			throw new Error(`delivery identity changed at ${field}: ${previous.delivery_id}`);
		}
	}
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
		.join(",")}}`;
}

function compareCursor(left: string, right: string): number {
	if (left.length !== right.length) return left.length < right.length ? -1 : 1;
	return left === right ? 0 : left < right ? -1 : 1;
}

export function terminalResultFromEvents(events: readonly HostEvent[]): NodeDeliveryResultPayload {
	const terminal = events.at(-1);
	if (terminal?.kind !== "completed") {
		throw new Error("host event stream has no completed disposition");
	}
	if (terminal.disposition.kind === "blocked" || terminal.disposition.kind === "failed") {
		throw new Error(
			`host disposition is not publishable by the Relay: ${terminal.disposition.kind}`,
		);
	}
	return nodeDeliveryResultPayloadSchema.parse({
		type: "turn_completed",
		disposition: terminal.disposition,
	});
}
