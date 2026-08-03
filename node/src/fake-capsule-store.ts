import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
	DEFAULT_HOST_EVENT_STREAM_POLICY,
	type HostEvent,
	type HostSessionRef,
	type HostTurnRef,
	type SessionInput,
	type StartTurnInput,
	acceptHostEvent,
	createHostEventStreamState,
	hostEventSchema,
	hostSessionRefSchema,
	hostTurnRefSchema,
	startTurnInputSchema,
} from "@agentrelay/protocol";
import { z } from "zod";
import { digestStartTurnInput, executionKey } from "./capsule-correlation.js";
import { CapsuleOperationError } from "./capsule-operation-error.js";
import { type CapsuleLaunchDescriptor, capsuleLaunchDescriptorSchema } from "./capsule-protocol.js";
import { writeDurableJson } from "./durable-file.js";

export { digestStartTurnInput, executionKey } from "./capsule-correlation.js";
export { CapsuleOperationError } from "./capsule-operation-error.js";

export const CAPSULE_DESCRIPTOR_FILE = "launch.json";
export const CAPSULE_STATE_FILE = "state.json";

const storedTurnSchema = z
	.object({
		input: startTurnInputSchema,
		input_sha256: z.string().regex(/^[a-f0-9]{64}$/),
		turn: hostTurnRefSchema,
		events: z.array(hostEventSchema).min(1),
		completion_due_at: z.string().datetime({ offset: true }).nullable(),
	})
	.strict();

const fakeCapsuleStateSchema = z
	.object({
		schema_version: z.literal(1),
		capsule_id: z.string().uuid(),
		created_at: z.string().datetime({ offset: true }),
		session: hostSessionRefSchema.nullable(),
		turns: z.record(storedTurnSchema),
	})
	.strict();

type FakeCapsuleState = z.infer<typeof fakeCapsuleStateSchema>;
type StoredTurn = z.infer<typeof storedTurnSchema>;

export async function readCapsuleLaunchDescriptor(
	directory: string,
): Promise<CapsuleLaunchDescriptor> {
	assertUnixSocketSupport();
	const descriptor = capsuleLaunchDescriptorSchema.parse(
		await readSecureJson(join(directory, CAPSULE_DESCRIPTOR_FILE)),
	);
	assertValidCapsuleSocketPath(descriptor.socket_path, descriptor.capsule_id);
	return descriptor;
}

function assertValidCapsuleSocketPath(path: string, capsuleId: string): void {
	const expectedSocketDirectory = `ar-capsules-${process.getuid?.() ?? "unknown"}`;
	if (
		!isAbsolute(path) ||
		normalize(path) !== path ||
		Buffer.byteLength(path, "utf8") > 100 ||
		basename(dirname(path)) !== expectedSocketDirectory ||
		basename(path) !== capsuleSocketFilename(capsuleId)
	) {
		throw new Error("Capsule descriptor contains an invalid local socket path");
	}
}

export function capsuleSocketPath(capsuleId: string): string {
	assertUnixSocketSupport();
	const owner = process.getuid?.() ?? "unknown";
	const path = join(tmpdir(), `ar-capsules-${owner}`, capsuleSocketFilename(capsuleId));
	assertValidCapsuleSocketPath(path, capsuleId);
	return path;
}

function capsuleSocketFilename(capsuleId: string): string {
	const digest = createHash("sha256").update(capsuleId, "utf8").digest("hex").slice(0, 24);
	return `${digest}.sock`;
}

function assertUnixSocketSupport(): void {
	if (process.platform === "win32") {
		throw new Error("Persistent Mission capsules require Unix domain sockets");
	}
}

/** Durable deterministic host state owned by one Mission-scoped capsule process. */
export class FakeCapsuleStore {
	readonly #directory: string;
	readonly #descriptor: CapsuleLaunchDescriptor;
	readonly #statePath: string;
	readonly #timers = new Map<string, AbortController>();
	#state: FakeCapsuleState;
	#pendingWrite: Promise<void> = Promise.resolve();

	private constructor(
		directory: string,
		descriptor: CapsuleLaunchDescriptor,
		state: FakeCapsuleState,
	) {
		this.#directory = directory;
		this.#descriptor = descriptor;
		this.#statePath = join(directory, CAPSULE_STATE_FILE);
		this.#state = state;
	}

	static async open(directory: string): Promise<FakeCapsuleStore> {
		const descriptor = await readCapsuleLaunchDescriptor(directory);
		const statePath = join(directory, CAPSULE_STATE_FILE);
		const decoded = await readSecureJsonIfPresent(statePath);
		const state =
			decoded === null
				? fakeCapsuleStateSchema.parse({
						schema_version: 1,
						capsule_id: descriptor.capsule_id,
						created_at: new Date().toISOString(),
						session: null,
						turns: {},
					})
				: fakeCapsuleStateSchema.parse(decoded);
		validateState(descriptor, state);
		if (decoded === null) {
			await writeDurableJson(statePath, state, { fileMode: 0o600, directoryMode: 0o700 });
		}
		const store = new FakeCapsuleStore(directory, descriptor, state);
		store.schedulePendingCompletions();
		return store;
	}

	get directory(): string {
		return this.#directory;
	}

	get descriptor(): CapsuleLaunchDescriptor {
		return structuredClone(this.#descriptor);
	}

	async ensureSession(input: SessionInput): Promise<HostSessionRef> {
		return this.mutate((state) => {
			if (!isDeepStrictEqual(input, this.#descriptor.session)) {
				throw new CapsuleOperationError(
					"scope_mismatch",
					"Capsule session input does not match its locally persisted Mission scope",
				);
			}
			if (state.session !== null) {
				assertSameSessionInput(state.session, input);
				return structuredClone(state.session);
			}
			state.session = hostSessionRefSchema.parse({
				...input,
				sessionId: `capsule-session-${randomUUID()}`,
			});
			return structuredClone(state.session);
		});
	}

	async lookupTurn(deliveryId: string, executionAttempt: number): Promise<HostTurnRef | null> {
		await this.#pendingWrite;
		const turn = this.#state.turns[executionKey(deliveryId, executionAttempt)];
		return turn === undefined ? null : structuredClone(turn.turn);
	}

	async startTurn(inputValue: StartTurnInput): Promise<HostTurnRef> {
		const input = startTurnInputSchema.parse(inputValue);
		const key = executionKey(input.deliveryId, input.executionAttempt);
		const result = await this.mutate((state) => {
			const existing = state.turns[key];
			if (existing !== undefined) {
				if (!isDeepStrictEqual(existing.input, input)) {
					throw new CapsuleOperationError(
						"correlation_conflict",
						"Capsule execution key was reused with a different start input",
					);
				}
				return { created: false, turn: structuredClone(existing.turn) };
			}
			const session = state.session;
			if (session === null) {
				throw new CapsuleOperationError("scope_mismatch", "Capsule session is not initialized");
			}
			if (!isDeepStrictEqual(input.session, session)) {
				throw new CapsuleOperationError(
					"scope_mismatch",
					"Turn session does not match the Mission-scoped capsule session",
				);
			}
			const active = Object.values(state.turns).find((candidate) => !isTerminal(candidate.events));
			if (active !== undefined) {
				throw new CapsuleOperationError(
					"correlation_conflict",
					"Mission capsule already has an active turn",
				);
			}

			const turn = hostTurnRefSchema.parse({
				turnId: `capsule-turn-${randomUUID()}`,
				sessionId: session.sessionId,
				missionId: input.missionId,
				deliveryId: input.deliveryId,
				executionAttempt: input.executionAttempt,
				contractVersion: input.contractVersion,
			});
			state.turns[key] = {
				input: structuredClone(input),
				input_sha256: digestStartTurnInput(input),
				turn,
				events: [{ kind: "accepted", turn, sequence: 1 }],
				completion_due_at: new Date(
					Date.now() + this.#descriptor.runtime.completion_delay_ms,
				).toISOString(),
			};
			return { created: true, turn: structuredClone(turn) };
		});
		if (result.created) this.scheduleCompletion(key);
		return result.turn;
	}

	async eventsForTurn(
		ref: HostTurnRef,
		expectedInput?: StartTurnInput,
	): Promise<readonly HostEvent[]> {
		await this.#pendingWrite;
		const stored = this.requireTurn(ref);
		if (
			expectedInput !== undefined &&
			!isDeepStrictEqual(stored.input, startTurnInputSchema.parse(expectedInput))
		) {
			throw new CapsuleOperationError(
				"correlation_conflict",
				"Recovered capsule turn input does not match its durable start intent",
			);
		}
		return structuredClone(stored.events);
	}

	async cancelTurn(ref: HostTurnRef): Promise<void> {
		const key = executionKey(ref.deliveryId, ref.executionAttempt);
		await this.mutate((state) => {
			const stored = requireTurnFromState(state, ref);
			if (isTerminal(stored.events)) return;
			appendUsageUnavailable(stored);
			stored.events.push({
				kind: "cancelled",
				turn: structuredClone(stored.turn),
				sequence: stored.events.length + 1,
			});
			stored.completion_due_at = null;
		});
		this.#timers.get(key)?.abort();
		this.#timers.delete(key);
	}

	async isTurnTerminal(ref: HostTurnRef): Promise<boolean> {
		await this.#pendingWrite;
		return isTerminal(this.requireTurn(ref).events);
	}

	async close(): Promise<void> {
		for (const timer of this.#timers.values()) timer.abort();
		this.#timers.clear();
		await this.#pendingWrite;
	}

	private requireTurn(ref: HostTurnRef): StoredTurn {
		return requireTurnFromState(this.#state, ref);
	}

	private schedulePendingCompletions(): void {
		for (const [key, turn] of Object.entries(this.#state.turns)) {
			if (!isTerminal(turn.events)) this.scheduleCompletion(key);
		}
	}

	private scheduleCompletion(key: string): void {
		this.#timers.get(key)?.abort();
		const controller = new AbortController();
		this.#timers.set(key, controller);
		void this.runCompletionTimer(key, controller);
	}

	private async runCompletionTimer(key: string, controller: AbortController): Promise<void> {
		try {
			await this.#pendingWrite;
			const dueAt = this.#state.turns[key]?.completion_due_at;
			if (dueAt === undefined || dueAt === null) return;
			await delay(Math.max(0, new Date(dueAt).getTime() - Date.now()), undefined, {
				signal: controller.signal,
			});
			await this.completeTurn(key);
		} catch (error) {
			if (!controller.signal.aborted) throw error;
		} finally {
			if (this.#timers.get(key) === controller) this.#timers.delete(key);
		}
	}

	private async completeTurn(key: string): Promise<void> {
		await this.mutate((state) => {
			const stored = state.turns[key];
			if (stored === undefined || isTerminal(stored.events)) return;
			appendUsageUnavailable(stored);
			stored.events.push({
				kind: "completed",
				turn: structuredClone(stored.turn),
				sequence: stored.events.length + 1,
				disposition:
					this.#descriptor.runtime.outcome === "ready"
						? { kind: "ready", evidence: [] }
						: {
								kind: "reply",
								message_type: "progress",
								message: "Persistent fake capsule processed this delivery.",
							},
			});
			stored.completion_due_at = null;
		});
	}

	private async mutate<T>(mutator: (state: FakeCapsuleState) => T): Promise<T> {
		let result!: T;
		const write = this.#pendingWrite.then(async () => {
			const next = structuredClone(this.#state);
			result = mutator(next);
			validateState(this.#descriptor, next);
			await writeDurableJson(this.#statePath, next, {
				fileMode: 0o600,
				directoryMode: 0o700,
			});
			this.#state = next;
		});
		this.#pendingWrite = write.catch(() => undefined);
		await write;
		return result;
	}
}

async function readSecureJson(path: string): Promise<unknown> {
	let handle: FileHandle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		throw new Error(`Cannot open capsule file: ${path}`, { cause: error });
	}
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) throw new Error(`Capsule file is not regular: ${path}`);
		if ((stats.mode & 0o777) !== 0o600)
			throw new Error(`Capsule file must have mode 0600: ${path}`);
		return JSON.parse(await handle.readFile("utf8"));
	} finally {
		await handle.close();
	}
}

async function readSecureJsonIfPresent(path: string): Promise<unknown | null> {
	try {
		return await readSecureJson(path);
	} catch (error) {
		if (errorCode((error as Error).cause) === "ENOENT") return null;
		throw error;
	}
}

function validateState(descriptor: CapsuleLaunchDescriptor, state: FakeCapsuleState): void {
	if (state.capsule_id !== descriptor.capsule_id) {
		throw new Error("Capsule state belongs to a different capsule generation");
	}
	if (state.session !== null) assertSameSessionInput(state.session, descriptor.session);
	let activeTurns = 0;
	for (const [key, stored] of Object.entries(state.turns)) {
		if (key !== executionKey(stored.input.deliveryId, stored.input.executionAttempt)) {
			throw new Error("Capsule turn is stored under the wrong execution key");
		}
		if (stored.input_sha256 !== digestStartTurnInput(stored.input)) {
			throw new Error("Capsule turn input digest does not match its persisted input");
		}
		if (state.session === null || !isDeepStrictEqual(stored.input.session, state.session)) {
			throw new Error("Capsule turn does not belong to its persisted session");
		}
		let stream = createHostEventStreamState({
			sessionId: stored.input.session.sessionId,
			missionId: stored.input.missionId,
			deliveryId: stored.input.deliveryId,
			executionAttempt: stored.input.executionAttempt,
			contractVersion: stored.input.contractVersion,
		});
		for (const event of stored.events) {
			stream = acceptHostEvent(stream, event, {
				...DEFAULT_HOST_EVENT_STREAM_POLICY,
				usage: "unavailable",
			}).state;
		}
		if (stream.phase === "terminal") {
			if (stored.completion_due_at !== null) {
				throw new Error("Terminal capsule turn still has a completion deadline");
			}
		} else {
			activeTurns += 1;
			if (stored.completion_due_at === null) {
				throw new Error("Active capsule turn is missing its completion deadline");
			}
		}
	}
	if (activeTurns > 1) throw new Error("Mission capsule contains multiple active turns");
}

function assertSameSessionInput(session: HostSessionRef, input: SessionInput): void {
	if (
		session.missionId !== input.missionId ||
		session.participantId !== input.participantId ||
		session.workspaceAlias !== input.workspaceAlias
	) {
		throw new CapsuleOperationError(
			"scope_mismatch",
			"Capsule session cannot be reused across Mission, participant, or workspace scope",
		);
	}
}

function requireTurnFromState(state: FakeCapsuleState, ref: HostTurnRef): StoredTurn {
	const stored = state.turns[executionKey(ref.deliveryId, ref.executionAttempt)];
	if (stored === undefined || !isDeepStrictEqual(stored.turn, ref)) {
		throw new CapsuleOperationError("not_found", `Capsule turn was not found: ${ref.turnId}`);
	}
	return stored;
}

function appendUsageUnavailable(stored: StoredTurn): void {
	if (stored.events.some((event) => event.kind === "usage")) return;
	stored.events.push({
		kind: "usage",
		turn: structuredClone(stored.turn),
		sequence: stored.events.length + 1,
		usage: { available: false, reason: "not_reported" },
	});
}

function isTerminal(events: readonly HostEvent[]): boolean {
	const last = events.at(-1);
	return last?.kind === "completed" || last?.kind === "failed" || last?.kind === "cancelled";
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String(error.code)
		: undefined;
}
