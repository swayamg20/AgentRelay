import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { writeSecretFile } from "../cli/io.js";
import { connectorStatePath } from "../cli/paths.js";

const MAX_POSTGRES_BIGINT = "9223372036854775807";
const cursorSchema = z
	.string()
	.regex(/^[1-9][0-9]*$/)
	.max(19)
	.refine(
		(cursor) => cursor.length < MAX_POSTGRES_BIGINT.length || cursor <= MAX_POSTGRES_BIGINT,
		"Connector cursor exceeds Postgres bigint range",
	);
const streamStateSchema = z
	.object({
		cursor: cursorSchema,
		updated_at: z.string().datetime(),
	})
	.strict();

const pickupStateSchema = z
	.object({
		last_event_id: z.string().uuid(),
		last_queued_at: z.string().datetime(),
	})
	.strict();

const connectorStateSchema = z
	.object({
		version: z.literal(1),
		streams: z.record(z.string(), streamStateSchema),
		pickups: z.record(z.string(), pickupStateSchema).optional().default({}),
	})
	.strict();

export type ConnectorState = z.infer<typeof connectorStateSchema>;

export const DEFAULT_PICKUP_COALESCE_MS = 5_000;

export const EMPTY_CONNECTOR_STATE: ConnectorState = { version: 1, streams: {}, pickups: {} };

export interface ConnectorPickupReference {
	relayUrl: string;
	agentId: string;
	senderHandle: string;
	threadId: string;
	eventId: string;
}

export type ConnectorPickupDecision = "queue" | "duplicate" | "coalesced";

export function connectorStreamKey(relayUrl: string, agentId: string): string {
	return hashKey(normalizeRelayUrl(relayUrl), agentId);
}

export function connectorPickupKey(
	relayUrl: string,
	agentId: string,
	senderHandle: string,
	threadId: string,
): string {
	return hashKey(normalizeRelayUrl(relayUrl), agentId, senderHandle, threadId);
}

export async function loadConnectorState(path = connectorStatePath()): Promise<ConnectorState> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return structuredClone(EMPTY_CONNECTOR_STATE);
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`Connector state at ${path} is not valid JSON.`);
	}
	const result = connectorStateSchema.safeParse(parsed);
	if (!result.success) {
		throw new Error(`Connector state at ${path} has an unsupported shape.`);
	}
	return result.data;
}

export function connectorCursor(
	state: ConnectorState,
	relayUrl: string,
	agentId: string,
): string | null {
	return state.streams[connectorStreamKey(relayUrl, agentId)]?.cursor ?? null;
}

/**
 * Suppress replayed events and short bursts from one sender in one thread.
 * One pickup record is keyed to the durable thread, so it can represent a
 * short burst while the queued prompt remains constant and content-free.
 */
export function connectorPickupDecision(
	state: ConnectorState,
	reference: ConnectorPickupReference,
	opts: { now?: Date; coalesceMs?: number } = {},
): ConnectorPickupDecision {
	validatePickupReference(reference);
	const coalesceMs = opts.coalesceMs ?? DEFAULT_PICKUP_COALESCE_MS;
	if (!Number.isFinite(coalesceMs) || coalesceMs < 0) {
		throw new Error("Pickup coalesce interval must be a non-negative finite number.");
	}
	const key = connectorPickupKey(
		reference.relayUrl,
		reference.agentId,
		reference.senderHandle,
		reference.threadId,
	);
	const previous = state.pickups[key];
	if (!previous) return "queue";
	if (previous.last_event_id === reference.eventId) return "duplicate";

	const now = (opts.now ?? new Date()).getTime();
	const elapsed = now - Date.parse(previous.last_queued_at);
	return elapsed < coalesceMs ? "coalesced" : "queue";
}

export async function persistConnectorCursor(
	input: {
		relayUrl: string;
		agentId: string;
		cursor: string;
	},
	deps: {
		path?: string;
		now?: () => Date;
		loadState?: (path: string) => Promise<ConnectorState>;
		writeState?: (path: string, state: ConnectorState) => Promise<void>;
	} = {},
): Promise<void> {
	await persistConnectorProgress(input, deps);
}

/** Persist a replay cursor and, after a successful runtime enqueue, its pickup dedupe record. */
export async function persistConnectorProgress(
	input: {
		relayUrl: string;
		agentId: string;
		cursor: string;
		pickup?: {
			senderHandle: string;
			threadId: string;
			eventId: string;
		};
	},
	deps: {
		path?: string;
		now?: () => Date;
		loadState?: (path: string) => Promise<ConnectorState>;
		writeState?: (path: string, state: ConnectorState) => Promise<void>;
	} = {},
): Promise<void> {
	cursorSchema.parse(input.cursor);
	const path = deps.path ?? connectorStatePath();
	const state = await (deps.loadState ?? loadConnectorState)(path);
	const key = connectorStreamKey(input.relayUrl, input.agentId);
	const now = (deps.now ?? (() => new Date()))().toISOString();
	const pickups = { ...state.pickups };
	if (input.pickup) {
		validatePickupReference({
			...input.pickup,
			relayUrl: input.relayUrl,
			agentId: input.agentId,
		});
		const pickupKey = connectorPickupKey(
			input.relayUrl,
			input.agentId,
			input.pickup.senderHandle,
			input.pickup.threadId,
		);
		pickups[pickupKey] = {
			last_event_id: input.pickup.eventId,
			last_queued_at: now,
		};
	}
	const next: ConnectorState = {
		...state,
		streams: {
			...state.streams,
			[key]: {
				cursor: input.cursor,
				updated_at: now,
			},
		},
		pickups,
	};
	await (deps.writeState ?? writeState)(path, next);
}

async function writeState(path: string, state: ConnectorState): Promise<void> {
	await writeSecretFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

function isMissingFile(error: unknown): boolean {
	return (
		error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
	);
}

function normalizeRelayUrl(relayUrl: string): string {
	return new URL(relayUrl).toString().replace(/\/$/, "");
}

function hashKey(...parts: string[]): string {
	const hash = createHash("sha256");
	for (const part of parts) {
		hash
			.update(String(Buffer.byteLength(part, "utf8")))
			.update(":")
			.update(part);
	}
	return hash.digest("hex");
}

function validatePickupReference(reference: ConnectorPickupReference): void {
	if (reference.agentId.length === 0) throw new Error("Connector agent ID must not be empty.");
	if (reference.senderHandle.length === 0) {
		throw new Error("Connector sender handle must not be empty.");
	}
	if (!z.string().uuid().safeParse(reference.threadId).success) {
		throw new Error("Connector thread ID must be a UUID.");
	}
	if (!z.string().uuid().safeParse(reference.eventId).success) {
		throw new Error("Connector event ID must be a UUID.");
	}
}
