import type { HostTurnRef, HostUsage, StartTurnInput } from "@agentrelay/protocol";
import type { CodexAppServerClientEvent } from "./codex-app-server-client.js";
import type { CodexTurn } from "./codex-app-server-protocol.js";
import {
	normalizeCodexTerminal,
	normalizeCodexTurnUsage,
	reconcileCodexTurn,
} from "./codex-capsule-normalizer.js";
import type { CodexCapsuleTurnIntent } from "./codex-capsule-prompt.js";
import type {
	CodexCapsuleClient,
	CodexRunnerPatchCoordinator,
	CodexTerminalPatchAttestation,
} from "./codex-capsule-runner-contract.js";
import { matchesProviderTurn } from "./codex-capsule-runner-contract.js";
import type { CodexCapsuleStore } from "./codex-capsule-store.js";
import { CodexTerminalPatchPolicyMismatchError } from "./codex-dynamic-patch-tool.js";
import type { CodexProviderEventSource } from "./codex-provider-event-source.js";

export interface CodexTurnExecutorOptions {
	readonly store: CodexCapsuleStore;
	readonly client: CodexCapsuleClient;
	readonly providerEvents: CodexProviderEventSource;
	readonly cwd: string;
	readonly providerPollMs: number;
	readonly patchCoordinator?: CodexRunnerPatchCoordinator;
	readonly shutdownSignal: AbortSignal;
}

/** Owns one Codex turn's provider calls, reconciliation, notification reduction, and interrupt. */
export class CodexTurnExecutor {
	readonly #store: CodexCapsuleStore;
	readonly #client: CodexCapsuleClient;
	readonly #providerEvents: CodexProviderEventSource;
	readonly #cwd: string;
	readonly #providerPollMs: number;
	readonly #patchCoordinator: CodexRunnerPatchCoordinator | undefined;
	readonly #shutdownSignal: AbortSignal;
	// Membership is generation-local, so a durable barrier absent here predates this client.
	readonly #interruptsIssued = new Set<string>();
	readonly #interruptOperations = new Map<string, Promise<void>>();

	constructor(options: CodexTurnExecutorOptions) {
		this.#store = options.store;
		this.#client = options.client;
		this.#providerEvents = options.providerEvents;
		this.#cwd = options.cwd;
		this.#providerPollMs = options.providerPollMs;
		this.#patchCoordinator = options.patchCoordinator;
		this.#shutdownSignal = options.shutdownSignal;
	}

	async run(input: StartTurnInput, ref: HostTurnRef, threadId: string): Promise<void> {
		const claim = await this.#store.claimTurnStart(input);
		if (claim.kind === "accepted" && claim.terminal) return;
		if (claim.kind === "send") {
			const turn = await this.#client.startReadOnlyTurn({
				threadId,
				clientUserMessageId: claim.intent.clientUserMessageId,
				text: claim.intent.text,
				cwd: this.#cwd,
				outputSchema: claim.intent.outputSchema,
			});
			await this.#store.acceptTurn(input, turn.id);
		} else if (claim.kind === "reconcile") {
			await this.reconcileUnbound(input, ref, claim.intent, threadId);
			return;
		} else {
			const inherited = await this.#store.inspectTurn(ref, input);
			if (inherited.cancellationRequested) {
				await this.interrupt(ref);
				if (!(await this.#store.inspectTurn(ref, input)).terminal) {
					await this.waitForTerminal(input, ref, threadId);
				}
				return;
			}
			if (inherited.codexTurnId === null) {
				throw new Error("Codex accepted turn lost its durable provider binding");
			}
			await this.reconcileBoundAfterQuiescence(
				input,
				ref,
				inherited.intent,
				threadId,
				inherited.codexTurnId,
			);
			return;
		}
		const state = await this.#store.inspectTurn(ref, input);
		if (state.terminal) return;
		if (state.codexTurnId === null)
			throw new Error("Codex turn remained unbound after reconciliation");
		if (state.cancellationRequested) await this.interrupt(ref);
		await this.waitForTerminal(input, ref, threadId);
	}

	interrupt(ref: HostTurnRef): Promise<void> {
		const existing = this.#interruptOperations.get(ref.turnId);
		if (existing !== undefined) return existing;
		const operation = this.performInterrupt(ref);
		this.#interruptOperations.set(ref.turnId, operation);
		void operation
			.finally(() => {
				if (this.#interruptOperations.get(ref.turnId) === operation) {
					this.#interruptOperations.delete(ref.turnId);
				}
			})
			.catch(() => undefined);
		return operation;
	}

	private async performInterrupt(ref: HostTurnRef): Promise<void> {
		const claim = await this.#store.claimInterrupt(ref);
		if (claim.kind === "send") {
			this.#interruptsIssued.add(ref.turnId);
			await this.#client.interruptTurn(claim.threadId, claim.codexTurnId);
			return;
		}
		if (claim.kind === "reconcile" && !this.#interruptsIssued.has(ref.turnId)) {
			const input = await this.#store.inputForTurn(ref);
			const state = await this.#store.inspectTurn(ref, input);
			const match = await this.readMatchedTurn(state.intent, state.threadId);
			if (match !== null && match.status !== "inProgress") {
				await this.#store.acceptTurn(input, match.id);
				await this.finalize(input, ref, match);
				return;
			}
			if (state.codexTurnId === null) {
				throw new Error("Codex interrupt lost its durable provider binding");
			}
			this.assertMatchingInProgressTurn(match, state.codexTurnId);
			await this.#patchCoordinator?.assertNoPatchCallsForAbandonment(
				ref,
				state.threadId,
				state.codexTurnId,
			);
			await this.#store.recordUncertainInterruptAfterQuiescence(ref, input);
		}
	}

	private async reconcileUnbound(
		input: StartTurnInput,
		ref: HostTurnRef,
		intent: CodexCapsuleTurnIntent,
		threadId: string,
	): Promise<void> {
		const match = await this.readMatchedTurn(intent, threadId);
		if (match !== null && match.status !== "inProgress") {
			await this.#store.acceptTurn(input, match.id);
			await this.finalize(input, ref, match);
			return;
		}
		await this.#store.recordUnmatchedStartAfterQuiescence(ref, input);
	}

	private async reconcileBoundAfterQuiescence(
		input: StartTurnInput,
		ref: HostTurnRef,
		intent: CodexCapsuleTurnIntent,
		threadId: string,
		providerTurnId: string,
	): Promise<void> {
		const match = await this.readMatchedTurn(intent, threadId);
		if (match !== null && match.status !== "inProgress") {
			await this.#store.acceptTurn(input, match.id);
			await this.finalize(input, ref, match);
			return;
		}
		this.assertMatchingInProgressTurn(match, providerTurnId);
		await this.#patchCoordinator?.assertNoPatchCallsForAbandonment(ref, threadId, providerTurnId);
		await this.#store.recordTerminal(
			ref,
			{ available: false, reason: "not_reported" },
			{
				kind: "failed",
				failure: {
					class: "transient",
					message: "Codex turn outcome could not be recovered after provider shutdown",
				},
			},
		);
	}

	private assertMatchingInProgressTurn(match: CodexTurn | null, providerTurnId: string): void {
		if (match !== null && match.id !== providerTurnId) {
			throw new Error("Codex reconciliation matched a different provider turn");
		}
	}

	private async readMatchedTurn(
		intent: CodexCapsuleTurnIntent,
		threadId: string,
	): Promise<CodexTurn | null> {
		const result = reconcileCodexTurn(await this.#client.readThread(threadId), intent);
		return result.kind === "matched" ? result.turn : null;
	}

	private async waitForTerminal(
		input: StartTurnInput,
		ref: HostTurnRef,
		threadId: string,
	): Promise<void> {
		let latestUsage: HostUsage | undefined;
		while (true) {
			const state = await this.#store.inspectTurn(ref, input);
			if (state.terminal) return;
			const observed = await this.#providerEvents.poll(this.#providerPollMs, this.#shutdownSignal);
			if (observed.kind === "event") {
				const applied = await this.applyProviderEvent(input, ref, observed.event, latestUsage);
				latestUsage = applied.usage;
				if (applied.terminal) return;
				continue;
			}
			const match = await this.readMatchedTurn(state.intent, threadId);
			if (match !== null) {
				await this.#store.acceptTurn(input, match.id);
				if (match.status !== "inProgress") {
					await this.finalize(input, ref, match, latestUsage);
					return;
				}
			}
			if (observed.kind === "done") {
				throw new Error("Codex notification stream ended before the active turn became terminal");
			}
		}
	}

	private async applyProviderEvent(
		input: StartTurnInput,
		ref: HostTurnRef,
		event: CodexAppServerClientEvent,
		usage: HostUsage | undefined,
	): Promise<{ readonly usage: HostUsage | undefined; readonly terminal: boolean }> {
		const state = await this.#store.inspectTurn(ref, input);
		const notification = event.notification;
		if (!matchesProviderTurn(notification, state.threadId, state.codexTurnId!)) {
			return { usage, terminal: false };
		}
		if (notification.method === "thread/tokenUsage/updated") {
			return {
				usage: normalizeCodexTurnUsage(notification, state.threadId, state.codexTurnId!),
				terminal: false,
			};
		}
		if (notification.method !== "turn/completed") return { usage, terminal: false };
		await this.finalize(input, ref, notification.params.turn, usage);
		return { usage, terminal: true };
	}

	private async finalize(
		input: StartTurnInput,
		ref: HostTurnRef,
		turn: CodexTurn,
		usage: HostUsage = { available: false, reason: "not_reported" },
	): Promise<void> {
		const state = await this.#store.inspectTurn(ref, input);
		let patchAttestation: CodexTerminalPatchAttestation | null = null;
		if (this.#patchCoordinator !== undefined) {
			try {
				patchAttestation = await this.#patchCoordinator.attestTerminal(ref, state.threadId, turn);
			} catch (error) {
				if (!(error instanceof CodexTerminalPatchPolicyMismatchError)) throw error;
				await this.#store.recordTerminal(ref, usage, {
					kind: "failed",
					failure: {
						class: "policy_denied",
						message: "Codex patch outcome could not be attested",
					},
				});
				return;
			}
		}
		const outcome = normalizeCodexTerminal(turn, false, patchAttestation);
		await this.#store.recordTerminal(
			ref,
			usage,
			outcome,
			turn.status === "interrupted" &&
				patchAttestation?.fatalPatchFailure !== true &&
				outcome.kind === "failed" &&
				outcome.failure.class === "transient",
		);
	}
}
