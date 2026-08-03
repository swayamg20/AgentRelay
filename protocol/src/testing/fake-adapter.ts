import { isDeepStrictEqual } from "node:util";
import {
	type AdapterInfo,
	type AgentHostAdapter,
	DEFAULT_HOST_EVENT_STREAM_POLICY,
	type HostEvent,
	type HostEventStreamPolicy,
	type HostEventStreamState,
	type HostFailure,
	type HostPermissionActivity,
	type HostSessionRef,
	type HostToolActivity,
	type HostTurnRef,
	type HostUsage,
	type SessionInput,
	type StartTurnInput,
	acceptHostEvent,
	adapterInfoSchema,
	createHostEventStreamState,
	hostExecutionAttemptSchema,
	hostSessionRefSchema,
	hostTurnRefSchema,
	sessionInputSchema,
	startTurnInputSchema,
} from "../adapter.js";
import { type ArtifactRef, type TurnDisposition, uuidSchema } from "../schemas.js";

export type FakeTurnProgress =
	| { readonly kind: "output"; readonly text: string }
	| { readonly kind: "tool"; readonly activity: HostToolActivity }
	| { readonly kind: "permission"; readonly activity: HostPermissionActivity }
	| { readonly kind: "artifact"; readonly artifact: ArtifactRef }
	| { readonly kind: "usage"; readonly usage: HostUsage };

export type FakeTurnOutcome =
	| { readonly kind: "pending"; readonly events?: readonly FakeTurnProgress[] }
	| {
			readonly kind: "completed";
			readonly events?: readonly FakeTurnProgress[];
			readonly disposition: TurnDisposition;
	  }
	| {
			readonly kind: "failed";
			readonly events?: readonly FakeTurnProgress[];
			readonly failure: HostFailure;
	  };

export interface FakeAdapterCounters {
	readonly probeCalls: number;
	readonly ensureSessionCalls: number;
	readonly sessionsCreated: number;
	readonly startTurnCalls: number;
	readonly turnsCreated: number;
	readonly recoverTurnCalls: number;
	readonly cancelTurnCalls: number;
	readonly turnsCancelled: number;
}

interface StoredTurn {
	readonly input: StartTurnInput;
	readonly ref: HostTurnRef;
	readonly events: HostEvent[];
	readonly policy: HostEventStreamPolicy;
	streamState: HostEventStreamState;
}

const DEFAULT_INFO: AdapterInfo = {
	name: "fake",
	version: "1.0.0",
	capabilities: {
		cancellation: true,
		recovery: true,
		usage: "turn_cumulative",
	},
};

/** Deterministic in-memory adapter for coordinator and Node tests. */
export class FakeAgentHostAdapter implements AgentHostAdapter {
	readonly #info: AdapterInfo;
	readonly #outcomes: FakeTurnOutcome[] = [];
	#defaultOutcome: FakeTurnOutcome = { kind: "pending" };
	readonly #sessionsByKey = new Map<string, HostSessionRef>();
	readonly #turnsByExecution = new Map<string, StoredTurn>();
	readonly #turnsById = new Map<string, StoredTurn>();
	#probeCalls = 0;
	#ensureSessionCalls = 0;
	#sessionsCreated = 0;
	#startTurnCalls = 0;
	#turnsCreated = 0;
	#recoverTurnCalls = 0;
	#cancelTurnCalls = 0;
	#turnsCancelled = 0;

	constructor(info: AdapterInfo = DEFAULT_INFO) {
		this.#info = adapterInfoSchema.parse(info);
	}

	get counters(): FakeAdapterCounters {
		return {
			probeCalls: this.#probeCalls,
			ensureSessionCalls: this.#ensureSessionCalls,
			sessionsCreated: this.#sessionsCreated,
			startTurnCalls: this.#startTurnCalls,
			turnsCreated: this.#turnsCreated,
			recoverTurnCalls: this.#recoverTurnCalls,
			cancelTurnCalls: this.#cancelTurnCalls,
			turnsCancelled: this.#turnsCancelled,
		};
	}

	queueOutcome(outcome: FakeTurnOutcome): void {
		this.#outcomes.push(structuredClone(outcome));
	}

	setDefaultOutcome(outcome: FakeTurnOutcome): void {
		this.#defaultOutcome = structuredClone(outcome);
	}

	eventsFor(deliveryId: string, executionAttempt: number): readonly HostEvent[] {
		return structuredClone(this.requireTurnByExecution(deliveryId, executionAttempt).events);
	}

	completeTurn(deliveryId: string, executionAttempt: number, disposition: TurnDisposition): void {
		const turn = this.requirePendingTurn(deliveryId, executionAttempt);
		ensureUsageEvent(turn);
		appendEvent(turn, {
			kind: "completed",
			turn: turn.ref,
			disposition: structuredClone(disposition),
		});
	}

	failTurn(deliveryId: string, executionAttempt: number, failure: HostFailure): void {
		const turn = this.requirePendingTurn(deliveryId, executionAttempt);
		ensureUsageEvent(turn);
		appendEvent(turn, { kind: "failed", turn: turn.ref, failure: structuredClone(failure) });
	}

	async probe(): Promise<AdapterInfo> {
		this.#probeCalls += 1;
		return structuredClone(this.#info);
	}

	async ensureSession(input: SessionInput): Promise<HostSessionRef> {
		this.#ensureSessionCalls += 1;
		const validated = sessionInputSchema.parse(input);
		const key = sessionKey(validated);
		const existing = this.#sessionsByKey.get(key);
		if (existing) {
			return { ...existing };
		}

		this.#sessionsCreated += 1;
		const session = hostSessionRefSchema.parse({
			...validated,
			sessionId: `fake-session-${this.#sessionsCreated}`,
		});
		this.#sessionsByKey.set(key, session);
		return structuredClone(session);
	}

	async lookupTurn(deliveryId: string, executionAttempt: number): Promise<HostTurnRef | null> {
		const validated = uuidSchema.parse(deliveryId);
		const attempt = hostExecutionAttemptSchema.parse(executionAttempt);
		const ref = this.#turnsByExecution.get(executionKey(validated, attempt))?.ref;
		return ref ? structuredClone(ref) : null;
	}

	startTurn(input: StartTurnInput): AsyncIterable<HostEvent> {
		this.#startTurnCalls += 1;
		const validated = startTurnInputSchema.parse(input);
		const key = executionKey(validated.deliveryId, validated.executionAttempt);
		const existing = this.#turnsByExecution.get(key);
		if (existing) {
			assertSameCorrelation(existing.input, validated);
			return replay(existing.events);
		}

		this.assertKnownSession(validated);
		const turnNumber = this.#turnsCreated + 1;
		const ref = hostTurnRefSchema.parse({
			turnId: `fake-turn-${turnNumber}`,
			sessionId: validated.session.sessionId,
			missionId: validated.missionId,
			deliveryId: validated.deliveryId,
			executionAttempt: validated.executionAttempt,
			contractVersion: validated.contractVersion,
		});
		const stored: StoredTurn = {
			input: structuredClone(validated),
			ref,
			events: [],
			policy: {
				...DEFAULT_HOST_EVENT_STREAM_POLICY,
				usage: this.#info.capabilities.usage,
			},
			streamState: createHostEventStreamState(ref),
		};
		appendEvent(stored, { kind: "accepted", turn: ref });
		this.#turnsCreated = turnNumber;
		this.#turnsByExecution.set(key, stored);
		this.#turnsById.set(ref.turnId, stored);

		const outcome = this.#outcomes.shift() ?? structuredClone(this.#defaultOutcome);
		appendProgressEvents(stored, outcome.events ?? []);
		if (outcome.kind === "completed") {
			ensureUsageEvent(stored);
			appendEvent(stored, { kind: "completed", turn: ref, disposition: outcome.disposition });
		} else if (outcome.kind === "failed") {
			ensureUsageEvent(stored);
			appendEvent(stored, { kind: "failed", turn: ref, failure: outcome.failure });
		}

		return replay(stored.events);
	}

	recoverTurn(ref: HostTurnRef, expectedInput: StartTurnInput): AsyncIterable<HostEvent> {
		this.#recoverTurnCalls += 1;
		const stored = this.requireTurnByRef(hostTurnRefSchema.parse(ref));
		assertSameCorrelation(stored.input, startTurnInputSchema.parse(expectedInput));
		return replay(stored.events);
	}

	async cancelTurn(ref: HostTurnRef): Promise<void> {
		this.#cancelTurnCalls += 1;
		const stored = this.requireTurnByRef(hostTurnRefSchema.parse(ref));
		if (isTerminal(stored.events)) {
			return;
		}

		ensureUsageEvent(stored);
		appendEvent(stored, { kind: "cancelled", turn: stored.ref });
		this.#turnsCancelled += 1;
	}

	private assertKnownSession(input: StartTurnInput): void {
		const session = this.#sessionsByKey.get(sessionKey(input.session));
		if (!session || session.sessionId !== input.session.sessionId) {
			throw new Error(`unknown fake host session: ${input.session.sessionId}`);
		}
		if (input.missionId !== input.session.missionId) {
			throw new Error("turn missionId does not match its host session");
		}
	}

	private requirePendingTurn(deliveryId: string, executionAttempt: number): StoredTurn {
		const turn = this.requireTurnByExecution(deliveryId, executionAttempt);
		if (isTerminal(turn.events)) {
			throw new Error(`fake host turn is already terminal: ${deliveryId}:${executionAttempt}`);
		}
		return turn;
	}

	private requireTurnByExecution(deliveryId: string, executionAttempt: number): StoredTurn {
		const validated = uuidSchema.parse(deliveryId);
		const attempt = hostExecutionAttemptSchema.parse(executionAttempt);
		const turn = this.#turnsByExecution.get(executionKey(validated, attempt));
		if (!turn) {
			throw new Error(`unknown fake host execution: ${deliveryId}:${executionAttempt}`);
		}
		return turn;
	}

	private requireTurnByRef(ref: HostTurnRef): StoredTurn {
		const turn = this.#turnsById.get(ref.turnId);
		if (
			!turn ||
			turn.ref.deliveryId !== ref.deliveryId ||
			turn.ref.executionAttempt !== ref.executionAttempt ||
			turn.ref.sessionId !== ref.sessionId ||
			turn.ref.missionId !== ref.missionId ||
			turn.ref.contractVersion !== ref.contractVersion
		) {
			throw new Error(`unknown fake host turn: ${ref.turnId}`);
		}
		return turn;
	}
}

function sessionKey(input: SessionInput): string {
	return JSON.stringify([input.missionId, input.participantId, input.workspaceAlias]);
}

function executionKey(deliveryId: string, executionAttempt: number): string {
	return JSON.stringify([deliveryId, executionAttempt]);
}

function assertSameCorrelation(existing: StartTurnInput, duplicate: StartTurnInput): void {
	if (!isDeepStrictEqual(existing, duplicate)) {
		throw new Error(
			`host execution reused with different turn correlation: ${duplicate.deliveryId}:${duplicate.executionAttempt}`,
		);
	}
}

function isTerminal(events: readonly HostEvent[]): boolean {
	const last = events.at(-1);
	return last?.kind === "completed" || last?.kind === "failed" || last?.kind === "cancelled";
}

function replay(events: readonly HostEvent[]): AsyncIterable<HostEvent> {
	const snapshot = structuredClone(events);
	return (async function* replaySnapshot(): AsyncIterable<HostEvent> {
		for (const event of snapshot) {
			yield structuredClone(event);
		}
	})();
}

function appendProgressEvents(turn: StoredTurn, progress: readonly FakeTurnProgress[]): void {
	for (const event of progress) {
		if (event.kind === "output") {
			appendEvent(turn, {
				kind: "output",
				turn: turn.ref,
				text: event.text,
			});
		} else if (event.kind === "tool") {
			appendEvent(turn, { kind: "tool", turn: turn.ref, activity: event.activity });
		} else if (event.kind === "permission") {
			appendEvent(turn, { kind: "permission", turn: turn.ref, activity: event.activity });
		} else if (event.kind === "artifact") {
			appendEvent(turn, { kind: "artifact", turn: turn.ref, artifact: event.artifact });
		} else {
			appendEvent(turn, { kind: "usage", turn: turn.ref, usage: event.usage });
		}
	}
}

function ensureUsageEvent(turn: StoredTurn): void {
	if (turn.streamState.usage === null) {
		appendEvent(turn, {
			kind: "usage",
			turn: turn.ref,
			usage: { available: false, reason: "not_reported" },
		});
	}
}

type UnsequencedHostEvent<T = HostEvent> = T extends HostEvent ? Omit<T, "sequence"> : never;

function appendEvent(turn: StoredTurn, event: UnsequencedHostEvent): void {
	const accepted = acceptHostEvent(
		turn.streamState,
		{
			...event,
			sequence: turn.events.length + 1,
		},
		turn.policy,
	);
	turn.events.push(accepted.event);
	turn.streamState = accepted.state;
}
