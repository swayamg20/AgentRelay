import type {
	AdapterInfo,
	HostEvent,
	HostSessionRef,
	HostTurnRef,
	SessionInput,
	StartTurnInput,
} from "@agentrelay/protocol";
import { CAPSULE_ADAPTER_INFO } from "./capsule-protocol.js";
import type {
	CapsuleRuntime,
	CapsuleRuntimeActivation,
	CapsuleRuntimeController,
} from "./capsule-runtime.js";
import type { FakeCapsuleStore } from "./fake-capsule-store.js";
import { waitUnref } from "./unref-timer.js";

const STREAM_POLL_MS = 20;

/** Adapts the deterministic durable fake store to the runtime-neutral Capsule boundary. */
export class FakeCapsuleRuntime implements CapsuleRuntime {
	readonly #store: FakeCapsuleStore;

	constructor(store: FakeCapsuleStore) {
		this.#store = store;
	}

	async probe(): Promise<AdapterInfo> {
		return structuredClone(CAPSULE_ADAPTER_INFO);
	}

	ensureSession(input: SessionInput): Promise<HostSessionRef> {
		return this.#store.ensureSession(input);
	}

	lookupTurn(deliveryId: string, executionAttempt: number): Promise<HostTurnRef | null> {
		return this.#store.lookupTurn(deliveryId, executionAttempt);
	}

	async *startTurn(input: StartTurnInput): AsyncIterable<HostEvent> {
		const turn = await this.#store.startTurn(input);
		yield* this.streamTurn(turn, input);
	}

	async *recoverTurn(ref: HostTurnRef, expectedInput: StartTurnInput): AsyncIterable<HostEvent> {
		await this.#store.eventsForTurn(ref, expectedInput);
		yield* this.streamTurn(ref, expectedInput);
	}

	cancelTurn(ref: HostTurnRef): Promise<void> {
		return this.#store.cancelTurn(ref);
	}

	close(): Promise<void> {
		return this.#store.close();
	}

	private async *streamTurn(
		turn: HostTurnRef,
		expectedInput: StartTurnInput,
	): AsyncIterable<HostEvent> {
		let sent = 0;
		while (true) {
			const events = await this.#store.eventsForTurn(turn, expectedInput);
			for (const event of events.slice(sent)) {
				yield event;
				sent += 1;
			}
			if (await this.#store.isTurnTerminal(turn)) return;
			await waitUnref(STREAM_POLL_MS);
		}
	}
}

/** Passive compatibility controller for the deterministic fake Capsule runtime. */
export class FakeCapsuleRuntimeController implements CapsuleRuntimeController {
	readonly #runtime: FakeCapsuleRuntime;
	#closing: Promise<void> | null = null;

	constructor(store: FakeCapsuleStore) {
		this.#runtime = new FakeCapsuleRuntime(store);
	}

	probe(): Promise<AdapterInfo> {
		return this.#runtime.probe();
	}

	lookupTurn(deliveryId: string, executionAttempt: number): Promise<HostTurnRef | null> {
		return this.#runtime.lookupTurn(deliveryId, executionAttempt);
	}

	async activate(_authority: CapsuleRuntimeActivation): Promise<CapsuleRuntime> {
		return this.#runtime;
	}

	close(): Promise<void> {
		this.#closing ??= this.#runtime.close();
		return this.#closing;
	}
}
