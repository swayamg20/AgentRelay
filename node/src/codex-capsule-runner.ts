import { isDeepStrictEqual } from "node:util";
import {
	type AdapterInfo,
	type HostEvent,
	type HostSessionRef,
	type HostTurnRef,
	type SessionInput,
	type StartTurnInput,
	hostTurnRefSchema,
	sessionInputSchema,
	startTurnInputSchema,
} from "@agentrelay/protocol";
import { executionKey } from "./capsule-correlation.js";
import { CapsuleOperationError } from "./capsule-operation-error.js";
import type { CapsuleRuntime } from "./capsule-runtime.js";
import {
	CODEX_CAPSULE_ADAPTER_INFO,
	type CodexCapsuleClient,
	type CodexCapsuleRunnerOptions,
	type CodexProviderGeneration,
	CodexProviderTerminationUnprovenError,
	boundedRunnerMilliseconds,
	isTerminalHostEvent,
	sessionInputFromRef,
	validateCodexRunnerCwd,
} from "./codex-capsule-runner-contract.js";
import type { CodexCapsuleStore } from "./codex-capsule-store.js";
import { CODEX_DYNAMIC_PATCH_TOOL_CONTRACT } from "./codex-dynamic-patch-tool-contract.js";
import { CodexProviderEventSource } from "./codex-provider-event-source.js";
import { CodexTurnExecutor } from "./codex-turn-executor.js";
import { raceWithUnrefTimeout } from "./unref-timer.js";

export {
	CODEX_CAPSULE_ADAPTER_INFO,
	type CodexCapsuleClient,
	type CodexCapsuleRunnerOptions,
	type CodexProviderGeneration,
	type CodexProviderGuardian,
	type CodexProviderTermination,
	type CodexProviderTerminationReason,
	CodexProviderTerminationUnprovenError,
	type CodexRunnerPatchCoordinator,
	type CodexTerminalPatchAttestation,
} from "./codex-capsule-runner-contract.js";

/** Codex orchestration inside one authority-activated Mission Capsule. */
export class CodexCapsuleRunner implements CapsuleRuntime {
	readonly #store: CodexCapsuleStore;
	readonly #generation: CodexProviderGeneration;
	readonly #client: CodexCapsuleClient;
	readonly #cwd: string;
	readonly #eventPollMs: number;
	readonly #providerPollMs: number;
	readonly #patchCoordinator: CodexCapsuleRunnerOptions["patchCoordinator"];
	readonly #providerEvents: CodexProviderEventSource;
	readonly #turnExecutor: CodexTurnExecutor;
	readonly #retireGeneration: () => void;
	readonly #activeOperations = new Set<Promise<void>>();
	readonly #turnDrivers = new Map<string, Promise<void>>();
	readonly #shutdown = new AbortController();
	#sessionReadiness: Promise<HostSessionRef> | null = null;
	#threadId: string | null = null;
	#retirementRequested = false;
	#admissionClosed = false;
	#closing: Promise<void> | null = null;

	private constructor(options: CodexCapsuleRunnerOptions, generation: CodexProviderGeneration) {
		this.#store = options.store;
		this.#generation = generation;
		this.#client = generation.client;
		this.#cwd = validateCodexRunnerCwd(options.cwd);
		this.#eventPollMs = boundedRunnerMilliseconds(options.eventPollMs ?? 20);
		this.#providerPollMs = boundedRunnerMilliseconds(options.providerPollMs ?? 500);
		this.#patchCoordinator = options.patchCoordinator;
		this.#retireGeneration = options.retireGeneration;
		this.#providerEvents = new CodexProviderEventSource(this.#client);
		this.#turnExecutor = new CodexTurnExecutor({
			store: options.store,
			client: this.#client,
			providerEvents: this.#providerEvents,
			cwd: this.#cwd,
			providerPollMs: this.#providerPollMs,
			patchCoordinator: this.#patchCoordinator,
			shutdownSignal: this.#shutdown.signal,
		});
		this.observeProviderTermination();
	}

	static async open(options: CodexCapsuleRunnerOptions): Promise<CodexCapsuleRunner> {
		const generation = await options.guardian.openGeneration();
		try {
			return new CodexCapsuleRunner(options, generation);
		} catch (error) {
			try {
				await generation.terminate("startup_failure");
			} catch (teardownError) {
				throw new CodexProviderTerminationUnprovenError(
					[teardownError, error],
					"Codex Capsule runner startup teardown could not be proven",
					generation,
				);
			}
			throw error;
		}
	}

	async probe(): Promise<AdapterInfo> {
		return structuredClone(CODEX_CAPSULE_ADAPTER_INFO);
	}

	ensureSession(inputValue: SessionInput): Promise<HostSessionRef> {
		return this.runAdmittedOperation(() =>
			this.ensureSessionInternal(sessionInputSchema.parse(inputValue)),
		);
	}

	private async ensureSessionInternal(input: SessionInput): Promise<HostSessionRef> {
		this.assertProviderAvailable();
		if (!isDeepStrictEqual(input, await this.#store.sessionScope())) {
			throw new CapsuleOperationError("scope_mismatch", "Codex Capsule session scope changed");
		}
		this.assertProviderAvailable();
		this.#sessionReadiness ??= this.openSession();
		try {
			return await this.#sessionReadiness;
		} catch (error) {
			this.#sessionReadiness = null;
			this.retireAfterFatalFailure(error);
			throw error;
		}
	}

	lookupTurn(deliveryId: string, executionAttempt: number): Promise<HostTurnRef | null> {
		return this.runAdmittedOperation(async () => {
			try {
				return await this.#store.lookupTurn(deliveryId, executionAttempt);
			} catch (error) {
				this.retireAfterFatalFailure(error);
				throw error;
			}
		});
	}

	startTurn(inputValue: StartTurnInput): AsyncIterable<HostEvent> {
		this.assertOpen();
		return this.streamStart(startTurnInputSchema.parse(inputValue));
	}

	recoverTurn(refValue: HostTurnRef, inputValue: StartTurnInput): AsyncIterable<HostEvent> {
		this.assertOpen();
		return this.streamRecovery(
			hostTurnRefSchema.parse(refValue),
			startTurnInputSchema.parse(inputValue),
		);
	}

	cancelTurn(refValue: HostTurnRef): Promise<void> {
		return this.runAdmittedOperation(async () => {
			try {
				const ref = hostTurnRefSchema.parse(refValue);
				this.assertProviderAvailable();
				const input = await this.#store.inputForTurn(ref);
				this.assertProviderAvailable();
				await this.#store.requestCancellation(ref);
				this.assertProviderAvailable();
				const driver = this.ensureTurnDriver(input, ref);
				try {
					await this.#turnExecutor.interrupt(ref);
				} finally {
					void driver.catch(() => undefined);
				}
			} catch (error) {
				this.retireAfterFatalFailure(error);
				throw error;
			}
		});
	}

	close(): Promise<void> {
		if (this.#closing === null) {
			this.#admissionClosed = true;
			this.#closing = this.performClose();
		}
		return this.#closing;
	}

	private async performClose(): Promise<void> {
		this.#shutdown.abort();
		try {
			await this.#generation.terminate("capsule_shutdown");
		} catch (error) {
			throw new CodexProviderTerminationUnprovenError(
				[error],
				"Codex provider shutdown could not be proven",
				this.#generation,
			);
		}
		const failures: unknown[] = [];
		await Promise.allSettled(this.#activeOperations);
		await Promise.allSettled(this.#turnDrivers.values());
		await captureFailure(this.#providerEvents.close(), failures);
		if (this.#patchCoordinator !== undefined) {
			try {
				await this.#patchCoordinator.close();
			} catch (error) {
				if (failures.length === 0) throw error;
				throw new AggregateError(
					[error, ...failures],
					"Codex patch coordinator shutdown could not be proven",
				);
			}
		}
		await captureFailure(this.#store.close(), failures);
		if (failures.length > 0) {
			throw new AggregateError(failures, "Codex Capsule runner shutdown failed");
		}
	}

	private observeProviderTermination(): void {
		void this.#generation.termination.then(
			() => this.retireAfterFatalFailure(new Error("Codex provider generation terminated")),
			() =>
				this.retireAfterFatalFailure(new Error("Codex provider termination was not observable")),
		);
	}

	private async openSession(): Promise<HostSessionRef> {
		this.assertProviderAvailable();
		let claim = await this.#store.claimSessionStart();
		this.assertProviderAvailable();
		if (claim.kind === "reconcile") {
			await this.#store.resetUnboundSessionAfterQuiescence();
			this.assertProviderAvailable();
			claim = await this.#store.claimSessionStart();
			this.assertProviderAvailable();
		}
		if (claim.kind === "ready") {
			await this.#client.resumeThread(claim.threadId);
			this.assertProviderAvailable();
			this.#threadId = claim.threadId;
			return claim.session;
		}
		if (claim.kind !== "send") throw new Error("Codex session start did not become sendable");
		const started = await this.#client.startThread();
		this.assertProviderAvailable();
		const session = await this.#store.acceptSession(started.thread.id);
		this.assertProviderAvailable();
		this.#threadId = started.thread.id;
		return session;
	}

	private async *streamStart(input: StartTurnInput): AsyncIterable<HostEvent> {
		try {
			const registered = await this.runAdmittedOperation(async () => {
				await this.ensureTurnSession(input);
				this.assertProviderAvailable();
				const ref = await this.#store.prepareTurn(
					input,
					this.#patchCoordinator === undefined ? null : CODEX_DYNAMIC_PATCH_TOOL_CONTRACT,
				);
				this.assertProviderAvailable();
				return { ref, driver: this.ensureTurnDriver(input, ref) };
			});
			yield* this.streamDurableTurn(input, registered.ref, registered.driver);
		} catch (error) {
			this.retireAfterFatalFailure(error);
			throw error;
		}
	}

	private async *streamRecovery(ref: HostTurnRef, input: StartTurnInput): AsyncIterable<HostEvent> {
		try {
			const registered = await this.runAdmittedOperation(async () => {
				await this.ensureTurnSession(input);
				this.assertProviderAvailable();
				await this.#store.eventsForTurn(ref, input);
				this.assertProviderAvailable();
				return { driver: this.ensureTurnDriver(input, ref) };
			});
			yield* this.streamDurableTurn(input, ref, registered.driver);
		} catch (error) {
			this.retireAfterFatalFailure(error);
			throw error;
		}
	}

	private async ensureTurnSession(input: StartTurnInput): Promise<void> {
		const session = await this.ensureSessionInternal(sessionInputFromRef(input.session));
		if (!isDeepStrictEqual(session, input.session)) {
			throw new CapsuleOperationError("scope_mismatch", "Codex turn session changed");
		}
	}

	private ensureTurnDriver(input: StartTurnInput, ref: HostTurnRef): Promise<void> {
		const key = executionKey(input.deliveryId, input.executionAttempt);
		const existing = this.#turnDrivers.get(key);
		if (existing !== undefined) return existing;
		const driver = this.ensureTurnSession(input)
			.then(() => this.#turnExecutor.run(input, ref, this.requireThreadId()))
			.finally(() => {
				if (this.#turnDrivers.get(key) === driver) this.#turnDrivers.delete(key);
			});
		this.#turnDrivers.set(key, driver);
		void driver.catch((error) => this.retireAfterFatalFailure(error));
		return driver;
	}

	private async *streamDurableTurn(
		input: StartTurnInput,
		ref: HostTurnRef,
		driver: Promise<void>,
	): AsyncIterable<HostEvent> {
		let sent = 0;
		while (true) {
			const events = await this.#store.eventsForTurn(ref, input);
			for (const event of events.slice(sent)) {
				yield event;
				sent += 1;
			}
			if (isTerminalHostEvent(events.at(-1))) return;
			const outcome = await raceWithUnrefTimeout(driver, this.#eventPollMs, this.#shutdown.signal);
			if (outcome.kind === "value") {
				const finalEvents = await this.#store.eventsForTurn(ref, input);
				if (!isTerminalHostEvent(finalEvents.at(-1))) {
					throw new Error("Codex turn driver ended without a durable terminal event");
				}
			}
		}
	}

	private requireThreadId(): string {
		if (this.#threadId === null) throw new Error("Codex Capsule session is not ready");
		return this.#threadId;
	}

	private retireAfterFatalFailure(error: unknown): void {
		if (
			error instanceof CapsuleOperationError ||
			this.#retirementRequested ||
			this.#closing !== null
		) {
			return;
		}
		this.#retirementRequested = true;
		try {
			this.#retireGeneration();
		} catch {
			void this.close().catch(() => undefined);
		}
	}

	private runAdmittedOperation<T>(operation: () => Promise<T>): Promise<T> {
		try {
			this.assertOpen();
		} catch (error) {
			return Promise.reject(error);
		}
		const result = Promise.resolve().then(operation);
		const completion = result.then(
			() => undefined,
			() => undefined,
		);
		this.#activeOperations.add(completion);
		void completion.then(() => this.#activeOperations.delete(completion));
		return result;
	}

	private assertProviderAvailable(): void {
		this.#shutdown.signal.throwIfAborted();
	}

	private assertOpen(): void {
		if (this.#retirementRequested || this.#admissionClosed || this.#closing !== null) {
			throw new Error("Codex Capsule runner is closed");
		}
	}
}

async function captureFailure(operation: Promise<unknown>, failures: unknown[]): Promise<void> {
	try {
		await operation;
	} catch (error) {
		failures.push(error);
	}
}
