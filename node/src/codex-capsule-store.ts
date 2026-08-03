import { join } from "node:path";
import {
	type HostEvent,
	type HostSessionRef,
	type HostTurnRef,
	type HostUsage,
	type SessionInput,
	type StartTurnInput,
	hostExecutionAttemptSchema,
	hostTurnRefSchema,
	hostUsageSchema,
	startTurnInputSchema,
	uuidSchema,
} from "@agentrelay/protocol";
import { z } from "zod";
import { executionKey } from "./capsule-correlation.js";
import { assertSameInput, publicIntent, requireTurnByRef } from "./codex-capsule-records.js";
import {
	type CodexCapsuleIdentity,
	type CodexCapsuleState,
	cloneStoredEvents,
	createCodexCapsuleState,
	hostTurnFromStored,
	validateCodexCapsuleState,
} from "./codex-capsule-state.js";
import {
	acceptSession,
	acceptTurn,
	claimInterrupt,
	claimSessionStart,
	claimTurnStart,
	prepareTurn,
	recordTerminal,
	recordUncertainInterruptAfterQuiescence,
	recordUnmatchedStartAfterQuiescence,
	requestCancellation,
	resetUnboundSessionAfterQuiescence,
} from "./codex-capsule-transitions.js";
import type {
	CodexInterruptClaim,
	CodexNormalizedTerminal,
	CodexSessionStartClaim,
	CodexTurnRuntimeState,
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

	claimSessionStart(): Promise<CodexSessionStartClaim> {
		return this.mutate(claimSessionStart);
	}

	async sessionScope(): Promise<SessionInput> {
		await this.#pendingWrite;
		return structuredClone(this.#state.session.input);
	}

	async acceptSession(codexThreadIdValue: string): Promise<HostSessionRef> {
		const threadId = providerReferenceSchema.parse(codexThreadIdValue);
		return this.mutate((state) => acceptSession(state, threadId));
	}

	/** Permits a replacement empty thread only after the caller proves the old process is gone. */
	resetUnboundSessionAfterQuiescence(): Promise<void> {
		return this.mutate(resetUnboundSessionAfterQuiescence);
	}

	async prepareTurn(inputValue: StartTurnInput): Promise<HostTurnRef> {
		const input = startTurnInputSchema.parse(inputValue);
		return this.mutate((state) => prepareTurn(state, input, this.#now().toISOString()));
	}

	async claimTurnStart(inputValue: StartTurnInput): Promise<CodexTurnStartClaim> {
		const input = startTurnInputSchema.parse(inputValue);
		return this.mutate((state) => claimTurnStart(state, input));
	}

	async acceptTurn(inputValue: StartTurnInput, codexTurnIdValue: string): Promise<HostTurnRef> {
		const input = startTurnInputSchema.parse(inputValue);
		const codexTurnId = providerReferenceSchema.parse(codexTurnIdValue);
		return this.mutate((state) => acceptTurn(state, input, codexTurnId));
	}

	async lookupTurn(deliveryId: string, executionAttempt: number): Promise<HostTurnRef | null> {
		await this.#pendingWrite;
		const key = executionKey(
			uuidSchema.parse(deliveryId),
			hostExecutionAttemptSchema.parse(executionAttempt),
		);
		const turn = this.#state.turns[key];
		return turn === undefined ? null : hostTurnFromStored(turn);
	}

	async inspectTurn(
		refValue: HostTurnRef,
		expectedInputValue: StartTurnInput,
	): Promise<CodexTurnRuntimeState> {
		const ref = hostTurnRefSchema.parse(refValue);
		const expectedInput = startTurnInputSchema.parse(expectedInputValue);
		await this.#pendingWrite;
		const turn = requireTurnByRef(this.#state, ref);
		assertSameInput(turn, expectedInput);
		return {
			turn: hostTurnFromStored(turn),
			intent: publicIntent(turn),
			phase: turn.phase,
			threadId: this.#state.session.codex_thread_id!,
			codexTurnId: turn.codex_turn_id,
			cancellationRequested: turn.cancellation !== "none",
			terminal: turn.phase === "terminal",
		};
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

	async inputForTurn(refValue: HostTurnRef): Promise<StartTurnInput> {
		const ref = hostTurnRefSchema.parse(refValue);
		await this.#pendingWrite;
		return structuredClone(requireTurnByRef(this.#state, ref).input);
	}

	async requestCancellation(refValue: HostTurnRef): Promise<void> {
		const ref = hostTurnRefSchema.parse(refValue);
		await this.mutate((state) => requestCancellation(state, ref));
	}

	async claimInterrupt(refValue: HostTurnRef): Promise<CodexInterruptClaim> {
		const ref = hostTurnRefSchema.parse(refValue);
		return this.mutate((state) => claimInterrupt(state, ref));
	}

	async recordUncertainInterruptAfterQuiescence(
		refValue: HostTurnRef,
		expectedInputValue: StartTurnInput,
	): Promise<readonly HostEvent[]> {
		const ref = hostTurnRefSchema.parse(refValue);
		const expectedInput = startTurnInputSchema.parse(expectedInputValue);
		return this.mutate((state) =>
			recordUncertainInterruptAfterQuiescence(state, ref, expectedInput),
		);
	}

	async recordUnmatchedStartAfterQuiescence(
		refValue: HostTurnRef,
		expectedInputValue: StartTurnInput,
	): Promise<readonly HostEvent[]> {
		const ref = hostTurnRefSchema.parse(refValue);
		const expectedInput = startTurnInputSchema.parse(expectedInputValue);
		return this.mutate((state) => recordUnmatchedStartAfterQuiescence(state, ref, expectedInput));
	}

	async recordTerminal(
		refValue: HostTurnRef,
		usageValue: HostUsage,
		outcome: CodexNormalizedTerminal,
	): Promise<readonly HostEvent[]> {
		const ref = hostTurnRefSchema.parse(refValue);
		const usage = hostUsageSchema.parse(usageValue);
		return this.mutate((state) => recordTerminal(state, ref, usage, outcome));
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
