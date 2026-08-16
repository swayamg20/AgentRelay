import { join } from "node:path";
import { uuidSchema } from "@agentrelay/protocol";
import { z } from "zod";
import {
	ensurePrivateStateDirectory,
	readPrivateJsonIfPresent,
	writePrivateJson,
} from "./private-state-file.js";

export const CODEX_PROVIDER_GENERATION_FILE = "provider-generation.json";

export const CODEX_PROVIDER_STOP_CAUSES = [
	"capsule_shutdown",
	"startup_failure",
	"provider_failure",
	"provider_unresponsive",
	"authority_revoked",
	"deadline_exceeded",
	"owner_lost",
	"heartbeat_timeout",
	"host_reboot",
] as const;

export type CodexProviderStopCause = (typeof CODEX_PROVIDER_STOP_CAUSES)[number];
export type CodexProviderObservation = "stopped" | "crashed" | "unresponsive";

export function observationForProviderStopCause(
	cause: CodexProviderStopCause,
): CodexProviderObservation {
	if (
		cause === "deadline_exceeded" ||
		cause === "heartbeat_timeout" ||
		cause === "provider_unresponsive"
	) {
		return "unresponsive";
	}
	if (cause === "provider_failure" || cause === "startup_failure" || cause === "host_reboot") {
		return "crashed";
	}
	return "stopped";
}

const timestampSchema = z.string().datetime({ offset: true });

const providerGenerationStateSchema = z
	.object({
		schema_version: z.literal(1),
		capsule_id: uuidSchema,
		generation_id: uuidSchema,
		boot_session_id: uuidSchema,
		phase: z.enum(["spawn_maybe_started", "running", "stop_requested", "quiescent"]),
		started_at: timestampSchema,
		deadline_at: timestampSchema,
		updated_at: timestampSchema,
		last_heartbeat_at: timestampSchema.nullable(),
		stop_cause: z.enum(CODEX_PROVIDER_STOP_CAUSES).nullable(),
		observation: z.enum(["stopped", "crashed", "unresponsive"]).nullable(),
	})
	.strict();

export type CodexProviderGenerationState = z.infer<typeof providerGenerationStateSchema>;

/** Private, bounded lifecycle evidence. Kernel ownership remains the authority. */
export class CodexProviderGenerationStore {
	readonly #path: string;
	readonly #capsuleId: string;
	readonly #now: () => Date;
	#pendingWrite: Promise<void> = Promise.resolve();

	private constructor(path: string, capsuleId: string, now: () => Date) {
		this.#path = path;
		this.#capsuleId = capsuleId;
		this.#now = now;
	}

	static async open(
		directory: string,
		capsuleIdValue: string,
		now: () => Date = () => new Date(),
	): Promise<CodexProviderGenerationStore> {
		const capsuleId = uuidSchema.parse(capsuleIdValue);
		await ensurePrivateStateDirectory(directory);
		return new CodexProviderGenerationStore(
			join(directory, CODEX_PROVIDER_GENERATION_FILE),
			capsuleId,
			now,
		);
	}

	async begin(
		generationIdValue: string,
		bootSessionIdValue: string,
		deadlineAtMs: number,
	): Promise<CodexProviderGenerationState> {
		const generationId = uuidSchema.parse(generationIdValue);
		const bootSessionId = uuidSchema.parse(bootSessionIdValue);
		const deadlineAt = new Date(deadlineAtMs).toISOString();
		const write = this.#pendingWrite.then(async () => {
			const previous = await this.readIfPresent();
			if (previous !== null && previous.phase !== "quiescent") {
				if (previous.boot_session_id === bootSessionId) {
					throw new Error("Previous Codex provider generation is not durably quiescent");
				}
				const rebootedAt = this.#now().toISOString();
				previous.phase = "quiescent";
				previous.stop_cause ??= "host_reboot";
				previous.observation ??= "crashed";
				previous.updated_at = rebootedAt;
				await writePrivateJson(this.#path, providerGenerationStateSchema.parse(previous));
			}
			const timestamp = this.#now().toISOString();
			const state = providerGenerationStateSchema.parse({
				schema_version: 1,
				capsule_id: this.#capsuleId,
				generation_id: generationId,
				boot_session_id: bootSessionId,
				phase: "spawn_maybe_started",
				started_at: timestamp,
				deadline_at: deadlineAt,
				updated_at: timestamp,
				last_heartbeat_at: null,
				stop_cause: null,
				observation: null,
			});
			await writePrivateJson(this.#path, state);
			return structuredClone(state);
		});
		this.#pendingWrite = write.then(
			() => undefined,
			() => undefined,
		);
		return write;
	}

	markRunning(generationId: string): Promise<void> {
		return this.mutate(generationId, (state, timestamp) => {
			if (state.phase !== "spawn_maybe_started") {
				throw new Error("Codex provider generation cannot become running from its current phase");
			}
			state.phase = "running";
			state.last_heartbeat_at = timestamp;
		});
	}

	recordHeartbeat(generationId: string): Promise<void> {
		return this.mutate(generationId, (state, timestamp) => {
			if (state.phase !== "running") return;
			state.last_heartbeat_at = timestamp;
		});
	}

	requestStop(generationId: string, cause: CodexProviderStopCause): Promise<void> {
		return this.mutate(generationId, (state) => {
			if (state.phase === "quiescent") return;
			state.phase = "stop_requested";
			state.stop_cause ??= cause;
		});
	}

	markQuiescent(
		generationId: string,
		cause: CodexProviderStopCause,
		observation: CodexProviderObservation,
	): Promise<void> {
		return this.mutate(generationId, (state) => {
			state.phase = "quiescent";
			state.stop_cause ??= cause;
			state.observation ??= observation;
		});
	}

	async snapshot(): Promise<CodexProviderGenerationState | null> {
		await this.#pendingWrite;
		return this.readIfPresent();
	}

	async markQuiescentIfCurrent(
		generationIdValue: string,
		cause: CodexProviderStopCause,
		observation: CodexProviderObservation,
	): Promise<boolean> {
		const generationId = uuidSchema.parse(generationIdValue);
		let updated = false;
		const write = this.#pendingWrite.then(async () => {
			const state = await this.readIfPresent();
			if (state === null || state.generation_id !== generationId) return;
			const timestamp = this.#now().toISOString();
			state.phase = "quiescent";
			state.stop_cause ??= cause;
			state.observation ??= observation;
			state.updated_at = timestamp;
			await writePrivateJson(this.#path, providerGenerationStateSchema.parse(state));
			updated = true;
		});
		this.#pendingWrite = write.catch(() => undefined);
		await write;
		return updated;
	}

	/** Called by the surviving reaper after process-group absence has been proven. */
	async finalizeQuiescentAsCurrent(
		generationIdValue: string,
		cause: CodexProviderStopCause,
	): Promise<CodexProviderGenerationState | null> {
		const generationId = uuidSchema.parse(generationIdValue);
		let finalized: CodexProviderGenerationState | null = null;
		const write = this.#pendingWrite.then(async () => {
			const state = await this.readIfPresent();
			if (state === null || state.generation_id !== generationId) return;
			const timestamp = this.#now().toISOString();
			state.phase = "quiescent";
			state.stop_cause = cause;
			state.observation = observationForProviderStopCause(cause);
			state.updated_at = timestamp;
			const parsed = providerGenerationStateSchema.parse(state);
			await writePrivateJson(this.#path, parsed);
			finalized = structuredClone(parsed);
		});
		this.#pendingWrite = write.catch(() => undefined);
		await write;
		return finalized;
	}

	private async mutate(
		generationIdValue: string,
		mutator: (state: CodexProviderGenerationState, timestamp: string) => void,
	): Promise<void> {
		const generationId = uuidSchema.parse(generationIdValue);
		const write = this.#pendingWrite.then(async () => {
			const state = await this.requireGeneration(generationId);
			const timestamp = this.#now().toISOString();
			mutator(state, timestamp);
			state.updated_at = timestamp;
			await writePrivateJson(this.#path, providerGenerationStateSchema.parse(state));
		});
		this.#pendingWrite = write.catch(() => undefined);
		await write;
	}

	private async requireGeneration(generationId: string): Promise<CodexProviderGenerationState> {
		const state = await this.readIfPresent();
		if (state === null || state.generation_id !== generationId) {
			throw new Error("Codex provider generation identity changed");
		}
		return state;
	}

	private async readIfPresent(): Promise<CodexProviderGenerationState | null> {
		const decoded = await readPrivateJsonIfPresent(this.#path);
		if (decoded === null) return null;
		const state = providerGenerationStateSchema.parse(decoded);
		if (state.capsule_id !== this.#capsuleId) {
			throw new Error("Codex provider generation belongs to another Capsule");
		}
		return state;
	}
}
