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
import { z } from "zod";
import { executionKey } from "./capsule-correlation.js";
import { CapsuleOperationError } from "./capsule-operation-error.js";
import type { CapsuleRuntime } from "./capsule-runtime.js";
import {
	CODEX_CAPSULE_ADAPTER_INFO,
	type CodexCapsuleClient,
	type CodexCapsuleRunnerOptions,
	boundedRunnerMilliseconds,
	isTerminalHostEvent,
	sessionInputFromRef,
	validateCodexRunnerCwd,
} from "./codex-capsule-runner-contract.js";
import type { CodexCapsuleStore } from "./codex-capsule-store.js";
import { CodexProviderEventSource } from "./codex-provider-event-source.js";
import { CodexTurnExecutor } from "./codex-turn-executor.js";
import { raceWithUnrefTimeout } from "./unref-timer.js";

export {
	CODEX_CAPSULE_ADAPTER_INFO,
	type CodexCapsuleClient,
	type CodexCapsuleRunnerOptions,
	type CodexRecoveryAuthority,
} from "./codex-capsule-runner-contract.js";

/** Injected Codex orchestration inside one Mission Capsule; not wired to a production CLI. */
export class CodexCapsuleRunner implements CapsuleRuntime {
	readonly #store: CodexCapsuleStore;
	readonly #client: CodexCapsuleClient;
	readonly #cwd: string;
	readonly #eventPollMs: number;
	readonly #providerPollMs: number;
	readonly #zeroMatchReads: number;
	readonly #providerEvents: CodexProviderEventSource;
	readonly #turnExecutor: CodexTurnExecutor;
	readonly #retireGeneration: () => void;
	readonly #turnDrivers = new Map<string, Promise<void>>();
	readonly #shutdown = new AbortController();
	#sessionReadiness: Promise<HostSessionRef> | null = null;
	#threadId: string | null = null;
	#retirementRequested = false;
	#closing: Promise<void> | null = null;

	private constructor(options: CodexCapsuleRunnerOptions, client: CodexCapsuleClient) {
		this.#store = options.store;
		this.#client = client;
		this.#cwd = validateCodexRunnerCwd(options.cwd);
		this.#eventPollMs = boundedRunnerMilliseconds(options.eventPollMs ?? 20);
		this.#providerPollMs = boundedRunnerMilliseconds(options.providerPollMs ?? 500);
		this.#zeroMatchReads = z
			.number()
			.int()
			.min(1)
			.max(20)
			.parse(options.zeroMatchReads ?? 3);
		this.#retireGeneration = options.retireGeneration;
		this.#providerEvents = new CodexProviderEventSource(client);
		this.#turnExecutor = new CodexTurnExecutor({
			store: options.store,
			client,
			providerEvents: this.#providerEvents,
			cwd: this.#cwd,
			providerPollMs: this.#providerPollMs,
			zeroMatchReads: this.#zeroMatchReads,
			shutdownSignal: this.#shutdown.signal,
		});
	}

	static async open(options: CodexCapsuleRunnerOptions): Promise<CodexCapsuleRunner> {
		await options.recoveryAuthority.assertPreviousProviderProcessQuiescent(
			"provider_generation_start",
		);
		const client = await options.clientFactory();
		try {
			return new CodexCapsuleRunner(options, client);
		} catch (error) {
			await client.close().catch(() => undefined);
			throw error;
		}
	}

	async probe(): Promise<AdapterInfo> {
		return structuredClone(CODEX_CAPSULE_ADAPTER_INFO);
	}

	async ensureSession(inputValue: SessionInput): Promise<HostSessionRef> {
		this.assertOpen();
		const input = sessionInputSchema.parse(inputValue);
		if (!isDeepStrictEqual(input, await this.#store.sessionScope())) {
			throw new CapsuleOperationError("scope_mismatch", "Codex Capsule session scope changed");
		}
		this.#sessionReadiness ??= this.openSession();
		try {
			return await this.#sessionReadiness;
		} catch (error) {
			this.#sessionReadiness = null;
			this.retireAfterFatalFailure(error);
			throw error;
		}
	}

	async lookupTurn(deliveryId: string, executionAttempt: number): Promise<HostTurnRef | null> {
		this.assertOpen();
		try {
			return await this.#store.lookupTurn(deliveryId, executionAttempt);
		} catch (error) {
			this.retireAfterFatalFailure(error);
			throw error;
		}
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

	async cancelTurn(refValue: HostTurnRef): Promise<void> {
		this.assertOpen();
		const ref = hostTurnRefSchema.parse(refValue);
		try {
			const input = await this.#store.inputForTurn(ref);
			await this.#store.requestCancellation(ref);
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
	}

	close(): Promise<void> {
		this.#closing ??= this.performClose();
		return this.#closing;
	}

	private async performClose(): Promise<void> {
		const failures: unknown[] = [];
		this.#shutdown.abort();
		await captureFailure(this.#client.close(), failures);
		await Promise.allSettled(this.#turnDrivers.values());
		await captureFailure(this.#providerEvents.close(), failures);
		await captureFailure(this.#store.close(), failures);
		if (failures.length > 0) {
			throw new AggregateError(failures, "Codex Capsule runner shutdown failed");
		}
	}

	private async openSession(): Promise<HostSessionRef> {
		let claim = await this.#store.claimSessionStart();
		if (claim.kind === "reconcile") {
			await this.#store.resetUnboundSessionAfterQuiescence();
			claim = await this.#store.claimSessionStart();
		}
		if (claim.kind === "ready") {
			await this.#client.resumeThread(claim.threadId);
			this.#threadId = claim.threadId;
			return claim.session;
		}
		if (claim.kind !== "send") throw new Error("Codex session start did not become sendable");
		const started = await this.#client.startThread();
		const session = await this.#store.acceptSession(started.thread.id);
		this.#threadId = started.thread.id;
		return session;
	}

	private async *streamStart(input: StartTurnInput): AsyncIterable<HostEvent> {
		try {
			await this.ensureTurnSession(input);
			const ref = await this.#store.prepareTurn(input);
			yield* this.streamDurableTurn(input, ref, this.ensureTurnDriver(input, ref));
		} catch (error) {
			this.retireAfterFatalFailure(error);
			throw error;
		}
	}

	private async *streamRecovery(ref: HostTurnRef, input: StartTurnInput): AsyncIterable<HostEvent> {
		try {
			await this.ensureTurnSession(input);
			await this.#store.eventsForTurn(ref, input);
			yield* this.streamDurableTurn(input, ref, this.ensureTurnDriver(input, ref));
		} catch (error) {
			this.retireAfterFatalFailure(error);
			throw error;
		}
	}

	private async ensureTurnSession(input: StartTurnInput): Promise<void> {
		const session = await this.ensureSession(sessionInputFromRef(input.session));
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

	private assertOpen(): void {
		if (this.#retirementRequested || this.#closing !== null) {
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
