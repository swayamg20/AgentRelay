import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type HostEvent,
	type HostSessionRef,
	type HostTurnRef,
	type HostUsage,
	type StartTurnInput,
	hostExecutionAttemptSchema,
	hostTurnRefSchema,
	hostUsageSchema,
	startTurnInputSchema,
	uuidSchema,
} from "@agentrelay/protocol";
import { z } from "zod";
import { digestStartTurnInput, executionKey } from "./capsule-correlation.js";
import { CapsuleOperationError } from "./capsule-operation-error.js";
import { buildCodexCapsuleTurnIntent } from "./codex-capsule-prompt.js";
import {
	assertSameInput,
	conflict,
	parseTerminal,
	publicIntent,
	replayTerminalEvents,
	requireReadySession,
	requireTurnByInput,
	requireTurnByRef,
	storedIntent,
} from "./codex-capsule-records.js";
import {
	type CodexCapsuleIdentity,
	type CodexCapsuleState,
	cloneStoredEvents,
	createCodexCapsuleState,
	hostSessionFromState,
	hostTurnFromStored,
	validateCodexCapsuleState,
} from "./codex-capsule-state.js";
import type {
	CodexInterruptClaim,
	CodexNormalizedTerminal,
	CodexSessionStartClaim,
	CodexTurnStartClaim,
} from "./codex-capsule-types.js";
import {
	ensurePrivateStateDirectory,
	readPrivateJsonIfPresent,
	writePrivateJson,
} from "./private-state-file.js";

export const CODEX_CAPSULE_STATE_FILE = "state.json";
const providerReferenceSchema = z.string().min(1).max(1_024);

/** Durable at-most-once barriers and normalized replay for one Codex Mission Capsule. */
export class CodexCapsuleStore {
	readonly #statePath: string;
	readonly #identity: CodexCapsuleIdentity;
	readonly #now: () => Date;
	#state: CodexCapsuleState;
	#pendingWrite: Promise<void> = Promise.resolve();

	private constructor(
		statePath: string,
		identity: CodexCapsuleIdentity,
		state: CodexCapsuleState,
		now: () => Date,
	) {
		this.#statePath = statePath;
		this.#identity = identity;
		this.#state = state;
		this.#now = now;
	}

	static async open(
		directory: string,
		identity: CodexCapsuleIdentity,
		now: () => Date = () => new Date(),
	): Promise<CodexCapsuleStore> {
		await ensurePrivateStateDirectory(directory);
		const statePath = join(directory, CODEX_CAPSULE_STATE_FILE);
		const decoded = await readPrivateJsonIfPresent(statePath);
		const state =
			decoded === null
				? createCodexCapsuleState(identity, now())
				: validateCodexCapsuleState(identity, decoded);
		if (decoded === null) await writePrivateJson(statePath, state);
		return new CodexCapsuleStore(statePath, identity, state, now);
	}

	async claimSessionStart(): Promise<CodexSessionStartClaim> {
		return this.mutate((state) => {
			if (state.session.phase === "ready") {
				return {
					kind: "ready" as const,
					session: hostSessionFromState(state),
					threadId: state.session.codex_thread_id!,
				};
			}
			if (state.session.phase === "start_maybe_sent") return { kind: "reconcile" as const };
			state.session.phase = "start_maybe_sent";
			return { kind: "send" as const };
		});
	}

	async acceptSession(codexThreadIdValue: string): Promise<HostSessionRef> {
		const codexThreadId = providerReferenceSchema.parse(codexThreadIdValue);
		return this.mutate((state) => {
			if (state.session.phase === "ready") {
				if (state.session.codex_thread_id !== codexThreadId) {
					throw conflict("Codex Capsule session is already bound to another thread");
				}
				return hostSessionFromState(state);
			}
			if (state.session.phase !== "start_maybe_sent") {
				throw conflict("Codex Capsule thread acceptance is missing its start barrier");
			}
			state.session.phase = "ready";
			state.session.codex_thread_id = codexThreadId;
			return hostSessionFromState(state);
		});
	}

	async prepareTurn(inputValue: StartTurnInput): Promise<void> {
		const input = startTurnInputSchema.parse(inputValue);
		const providerIntent = buildCodexCapsuleTurnIntent(input);
		await this.mutate((state) => {
			const session = requireReadySession(state);
			if (!isDeepStrictEqual(input.session, session)) {
				throw new CapsuleOperationError("scope_mismatch", "Turn does not match the Codex session");
			}
			const key = executionKey(input.deliveryId, input.executionAttempt);
			const existing = state.turns[key];
			if (existing !== undefined) {
				assertSameInput(existing, input);
				return;
			}
			if (Object.values(state.turns).some((turn) => turn.phase !== "terminal")) {
				throw conflict("Codex Capsule already has an active turn");
			}
			const timestamp = this.#now().toISOString();
			state.turns[key] = {
				input: structuredClone(input),
				input_sha256: digestStartTurnInput(input),
				host_turn_id: `capsule-turn-${randomUUID()}`,
				phase: "prepared",
				codex_turn_id: null,
				provider_intent: storedIntent(providerIntent),
				cancellation: "none",
				events: [],
				created_at: timestamp,
				updated_at: timestamp,
			};
		});
	}

	async claimTurnStart(inputValue: StartTurnInput): Promise<CodexTurnStartClaim> {
		const input = startTurnInputSchema.parse(inputValue);
		return this.mutate((state) => {
			const turn = requireTurnByInput(state, input);
			if (turn.phase === "prepared") {
				turn.phase = "start_maybe_sent";
				return { kind: "send" as const, intent: publicIntent(turn) };
			}
			if (turn.phase === "start_maybe_sent") {
				return { kind: "reconcile" as const, intent: publicIntent(turn) };
			}
			return {
				kind: "accepted" as const,
				turn: hostTurnFromStored(turn),
				terminal: turn.phase === "terminal",
			};
		});
	}

	async acceptTurn(inputValue: StartTurnInput, codexTurnIdValue: string): Promise<HostTurnRef> {
		const input = startTurnInputSchema.parse(inputValue);
		const codexTurnId = providerReferenceSchema.parse(codexTurnIdValue);
		return this.mutate((state) => {
			const turn = requireTurnByInput(state, input);
			if (["accepted", "cancelling", "terminal"].includes(turn.phase)) {
				if (turn.codex_turn_id !== codexTurnId) {
					throw conflict("Codex execution is already bound to another provider turn");
				}
				return hostTurnFromStored(turn);
			}
			if (turn.phase !== "start_maybe_sent") {
				throw conflict("Codex turn acceptance is missing its at-most-once start barrier");
			}
			const ref = hostTurnFromStored(turn);
			turn.codex_turn_id = codexTurnId;
			turn.phase = "accepted";
			turn.events = [{ kind: "accepted", turn: ref, sequence: 1 }];
			return ref;
		});
	}

	async lookupTurn(deliveryId: string, executionAttempt: number): Promise<HostTurnRef | null> {
		await this.#pendingWrite;
		const key = executionKey(
			uuidSchema.parse(deliveryId),
			hostExecutionAttemptSchema.parse(executionAttempt),
		);
		const turn = this.#state.turns[key];
		return turn === undefined || turn.codex_turn_id === null ? null : hostTurnFromStored(turn);
	}

	async eventsForTurn(
		refValue: HostTurnRef,
		expectedInputValue: StartTurnInput,
	): Promise<readonly HostEvent[]> {
		const ref = hostTurnRefSchema.parse(refValue);
		const expectedInput = startTurnInputSchema.parse(expectedInputValue);
		await this.#pendingWrite;
		const turn = requireTurnByRef(this.#state, ref);
		assertSameInput(turn, expectedInput);
		return cloneStoredEvents(turn);
	}

	async requestCancellation(refValue: HostTurnRef): Promise<void> {
		const ref = hostTurnRefSchema.parse(refValue);
		await this.mutate((state) => {
			const turn = requireTurnByRef(state, ref);
			if (turn.phase === "terminal" || turn.phase === "cancelling") return;
			if (turn.phase !== "accepted") throw conflict("Codex turn is not cancellable");
			turn.phase = "cancelling";
			turn.cancellation = "requested";
		});
	}

	async claimInterrupt(refValue: HostTurnRef): Promise<CodexInterruptClaim> {
		const ref = hostTurnRefSchema.parse(refValue);
		return this.mutate((state) => {
			const turn = requireTurnByRef(state, ref);
			if (turn.phase === "terminal") return { kind: "terminal" as const };
			if (turn.phase !== "cancelling") throw conflict("Codex cancellation was not requested");
			if (turn.cancellation === "interrupt_maybe_sent") {
				return { kind: "reconcile" as const };
			}
			turn.cancellation = "interrupt_maybe_sent";
			return {
				kind: "send" as const,
				threadId: state.session.codex_thread_id!,
				codexTurnId: turn.codex_turn_id!,
			};
		});
	}

	async recordTerminal(
		refValue: HostTurnRef,
		usageValue: HostUsage,
		outcomeValue: CodexNormalizedTerminal,
	): Promise<readonly HostEvent[]> {
		const ref = hostTurnRefSchema.parse(refValue);
		const usage = hostUsageSchema.parse(usageValue);
		const outcome = parseTerminal(outcomeValue);
		return this.mutate((state) => {
			const turn = requireTurnByRef(state, ref);
			if (turn.phase === "terminal") return replayTerminalEvents(turn, usage, outcome);
			if (outcome.kind === "cancelled" && turn.phase !== "cancelling") {
				throw conflict("Codex cancellation lacks a durable local cancellation intent");
			}
			if (turn.phase !== "accepted" && turn.phase !== "cancelling") {
				throw conflict("Codex terminal result arrived before durable acceptance");
			}
			turn.events.push({
				kind: "usage",
				turn: ref,
				sequence: turn.events.length + 1,
				usage,
			});
			turn.events.push({ ...outcome, turn: ref, sequence: turn.events.length + 1 });
			turn.phase = "terminal";
			return cloneStoredEvents(turn);
		});
	}

	async close(): Promise<void> {
		await this.#pendingWrite;
	}

	private async mutate<T>(mutator: (state: CodexCapsuleState) => T): Promise<T> {
		let result!: T;
		const write = this.#pendingWrite.then(async () => {
			const next = structuredClone(this.#state);
			result = mutator(next);
			const timestamp = this.#now().toISOString();
			next.updated_at = timestamp;
			for (const turn of Object.values(next.turns)) turn.updated_at = timestamp;
			const validated = validateCodexCapsuleState(this.#identity, next);
			await writePrivateJson(this.#statePath, validated);
			this.#state = validated;
		});
		this.#pendingWrite = write.catch(() => undefined);
		await write;
		return result;
	}
}
