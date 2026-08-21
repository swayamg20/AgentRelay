import { uuidSchema } from "@agentrelay/protocol";
import type { CapsuleRuntimeActivation } from "./capsule-runtime.js";
import type { CodexCapsuleStore } from "./codex-capsule-store.js";
import type {
	CodexDynamicPatchToolCall,
	CodexDynamicPatchToolHandler,
	CodexDynamicPatchToolOutcome,
} from "./codex-dynamic-patch-tool-contract.js";
import {
	type CodexPatchAuthorityRecord,
	type CodexPatchResult,
	type CodexPatchToolCall,
	CodexWorkspacePatchError,
	codexPatchKey,
	codexPatchTransactionId,
} from "./codex-workspace-patch-contract.js";
import {
	type CodexPatchInspection,
	type CodexWorkspacePatchMediator,
	codexPatchAuthorityRecord,
} from "./codex-workspace-patch-transaction.js";

const COORDINATION_FAILURE_MESSAGE = "AgentRelay patch tool coordination failed";

export interface CodexDynamicPatchToolCoordinatorOptions {
	readonly capsuleId: string;
	readonly store: CodexCapsuleStore;
	readonly mediator: CodexWorkspacePatchMediator;
	readonly authority: CapsuleRuntimeActivation;
}

/**
 * Durable Capsule-side barrier between one provider tool request and workspace mutation.
 *
 * The coordinator deliberately has no Codex client reference: app-server input is paused while
 * its request handler runs, so a nested provider call would deadlock that transport.
 */
export class CodexDynamicPatchToolCoordinator implements CodexDynamicPatchToolHandler {
	readonly #capsuleId: string;
	readonly #store: CodexCapsuleStore;
	readonly #mediator: CodexWorkspacePatchMediator;
	readonly #authority: CapsuleRuntimeActivation;
	readonly #authorityRecord: CodexPatchAuthorityRecord;
	#tail: Promise<void> = Promise.resolve();
	#recovered = false;
	#closing = false;
	#closePromise: Promise<void> | null = null;

	constructor(options: CodexDynamicPatchToolCoordinatorOptions) {
		this.#capsuleId = uuidSchema.parse(options.capsuleId);
		this.#store = options.store;
		this.#mediator = options.mediator;
		this.#authority = options.authority;
		this.#authorityRecord = codexPatchAuthorityRecord(options.authority);
	}

	async recover(): Promise<void> {
		try {
			await this.enqueue(() => this.ensureRecovered());
		} catch {
			this.#recovered = false;
			throw new CodexDynamicPatchToolCoordinatorError();
		}
	}

	async handle(
		call: CodexDynamicPatchToolCall,
		signal: AbortSignal,
	): Promise<CodexDynamicPatchToolOutcome> {
		try {
			return await this.enqueue(async () => {
				signal.throwIfAborted();
				const request = {
					providerThreadId: call.threadId,
					providerTurnId: call.turnId,
					callId: call.callId,
					patch: call.patch,
					authority: this.#authorityRecord,
				};
				const existing = await this.#store.inspectPatchCall(request);
				if (existing?.kind === "terminal") return outcomeFromReceipt(existing.receipt);
				if (existing?.kind === "pending") {
					this.assertCapsule(existing.call);
					if (this.#recovered) return this.resolvePending(existing.call);
					await this.ensureRecovered();
					const reconciled = await this.#store.inspectPatchCall(request);
					if (reconciled?.kind !== "terminal") {
						throw new CodexDynamicPatchToolCoordinatorError();
					}
					return outcomeFromReceipt(reconciled.receipt);
				}

				await this.ensureRecovered();
				signal.throwIfAborted();
				const claim = await this.#store.claimPatchCall(request);
				if (claim.kind === "terminal") return outcomeFromReceipt(claim.receipt);
				this.assertCapsule(claim.call);
				// Once this request is durable, provider teardown cannot revoke the request itself.
				// The exact runtime authority remains the write fence inside the mediator.
				return this.resolvePending(claim.call);
			});
		} catch {
			this.#recovered = false;
			throw new CodexDynamicPatchToolCoordinatorError();
		}
	}

	close(): Promise<void> {
		if (this.#closePromise !== null) return this.#closePromise;
		this.#closing = true;
		this.#closePromise = this.#tail
			.then(() => this.#mediator.close())
			.catch(() => {
				throw new CodexDynamicPatchToolCoordinatorError();
			});
		return this.#closePromise;
	}

	private async ensureRecovered(): Promise<void> {
		if (this.#recovered) return;
		const pending = await this.#store.pendingPatchCalls(this.#authorityRecord);
		let recovered: readonly CodexPatchResult[];
		try {
			recovered = await this.#mediator.recover(this.#authority);
		} catch (error) {
			const call = pending.find((candidate) => indeterminateMatches(error, candidate));
			if (call === undefined) throw error;
			const inspection = await this.#mediator.inspect(call, this.#authority);
			if (inspection.state !== "indeterminate") throw error;
			await this.persistInspection(call, inspection);
			return;
		}
		this.#recovered = true;
		const pendingByTransaction = new Map(
			pending.map((call) => [codexPatchTransactionId(codexPatchKey(call)), call] as const),
		);
		for (const result of recovered) {
			const call = pendingByTransaction.get(result.transactionId);
			if (call === undefined) {
				throw new CodexDynamicPatchToolCoordinatorError();
			}
			await this.#store.recordPatchCallReceipt(call, this.#authorityRecord, {
				outcome: "applied",
				result,
			});
			pendingByTransaction.delete(result.transactionId);
		}
		for (const call of pendingByTransaction.values()) {
			this.assertCapsule(call);
			await this.resolvePending(call);
		}
	}

	private async resolvePending(call: CodexPatchToolCall): Promise<CodexDynamicPatchToolOutcome> {
		const inspection = await this.#mediator.inspect(call, this.#authority);
		if (inspection.state !== "absent") return this.persistInspection(call, inspection);

		try {
			const result = await this.#mediator.apply(call, this.#authority);
			await this.#store.recordPatchCallReceipt(call, this.#authorityRecord, {
				outcome: "applied",
				result,
			});
			return "applied";
		} catch {
			let recovered: CodexPatchInspection;
			try {
				await this.#mediator.recover(this.#authority);
				recovered = await this.#mediator.inspect(call, this.#authority);
			} catch (error) {
				if (!indeterminateMatches(error, call)) throw error;
				recovered = await this.#mediator.inspect(call, this.#authority);
				if (recovered.state !== "indeterminate") throw error;
			}
			if (recovered.state === "absent") {
				await this.#store.recordPatchCallReceipt(call, this.#authorityRecord, {
					outcome: "failed",
					classification: "fatal",
				});
				return "fatal_rejected";
			}
			return this.persistInspection(call, recovered);
		}
	}

	private async persistInspection(
		call: CodexPatchToolCall,
		inspection: Exclude<CodexPatchInspection, { readonly state: "absent" }>,
	): Promise<CodexDynamicPatchToolOutcome> {
		if (inspection.state === "committed") {
			await this.#store.recordPatchCallReceipt(call, this.#authorityRecord, {
				outcome: "applied",
				result: inspection.result,
			});
			return "applied";
		}
		if (inspection.state === "rejected") {
			await this.#store.recordPatchCallReceipt(call, this.#authorityRecord, {
				outcome: "rejected",
			});
			return "rejected";
		}
		await this.#store.recordPatchCallReceipt(call, this.#authorityRecord, {
			outcome: "indeterminate",
		});
		throw new CodexDynamicPatchToolIndeterminateError();
	}

	private assertCapsule(call: CodexPatchToolCall): void {
		if (call.capsuleId !== this.#capsuleId) throw new CodexDynamicPatchToolCoordinatorError();
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		if (this.#closing) return Promise.reject(new CodexDynamicPatchToolCoordinatorError());
		const result = this.#tail.then(operation);
		this.#tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

export class CodexDynamicPatchToolCoordinatorError extends Error {
	constructor() {
		super(COORDINATION_FAILURE_MESSAGE);
		this.name = "CodexDynamicPatchToolCoordinatorError";
	}
}

class CodexDynamicPatchToolIndeterminateError extends Error {}

function outcomeFromReceipt(receipt: {
	readonly outcome: "applied" | "rejected" | "failed" | "indeterminate";
}): CodexDynamicPatchToolOutcome {
	if (receipt.outcome === "failed") return "fatal_rejected";
	if (receipt.outcome === "indeterminate") throw new CodexDynamicPatchToolIndeterminateError();
	return receipt.outcome;
}

function indeterminateMatches(error: unknown, call: CodexPatchToolCall): boolean {
	return (
		error instanceof CodexWorkspacePatchError &&
		error.code === "indeterminate" &&
		error.transactionId === codexPatchTransactionId(codexPatchKey(call))
	);
}
