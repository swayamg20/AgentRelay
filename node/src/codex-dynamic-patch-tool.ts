import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { hostTurnRefSchema } from "@agentrelay/protocol";
import { uuidSchema } from "@agentrelay/protocol";
import { canonicalJson } from "./capsule-correlation.js";
import type { CapsuleRuntimeActivation } from "./capsule-runtime.js";
import {
	type CodexDynamicToolCallItem,
	type CodexTurn,
	MAX_CODEX_APP_SERVER_FRAME_BYTES,
	codexDynamicToolCallItemSchema,
	codexTurnSchema,
} from "./codex-app-server-protocol.js";
import type {
	CodexRunnerPatchCoordinator,
	CodexTerminalPatchAttestation,
} from "./codex-capsule-runner-contract.js";
import type { CodexCapsuleStore } from "./codex-capsule-store.js";
import type {
	CodexDynamicPatchToolCall,
	CodexDynamicPatchToolOutcome,
} from "./codex-dynamic-patch-tool-contract.js";
import {
	CODEX_DYNAMIC_PATCH_TOOL_CONTRACT,
	CODEX_DYNAMIC_PATCH_TOOL_NAME,
	CODEX_DYNAMIC_TOOL_NAMESPACE,
	codexDynamicPatchToolResponse,
	parseCodexDynamicPatchToolCallParams,
} from "./codex-dynamic-patch-tool-contract.js";
import {
	type CodexPatchAuthorityRecord,
	type CodexPatchResult,
	type CodexPatchToolCall,
	CodexWorkspacePatchError,
	codexPatchKey,
	codexPatchSha256,
	codexPatchTransactionId,
	parseCodexPatchToolCall,
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
export class CodexDynamicPatchToolCoordinator implements CodexRunnerPatchCoordinator {
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

	async attestTerminal(
		refValue: Parameters<CodexRunnerPatchCoordinator["attestTerminal"]>[0],
		threadId: string,
		turnValue: CodexTurn,
	): Promise<CodexTerminalPatchAttestation> {
		try {
			return await this.enqueue(async () => {
				await this.assertLiveAuthority();
				await this.ensureRecovered();
				const ref = hostTurnRefSchema.parse(refValue);
				const turn = codexTurnSchema.parse(turnValue);
				this.assertAuthority(ref);
				if (turn.status === "inProgress" || turn.itemsView !== "full") {
					throw new CodexDynamicPatchToolCoordinatorError();
				}

				const durable = await this.#store.patchCallsForTurn(ref, this.#authorityRecord);
				if (
					durable.threadId !== threadId ||
					durable.providerTurnId !== turn.id ||
					durable.toolContract !== CODEX_DYNAMIC_PATCH_TOOL_CONTRACT
				) {
					throw new CodexDynamicPatchToolCoordinatorError();
				}

				const providerHistory = terminalDynamicPatchItems(turn);
				let policyMismatch = providerHistory.policyMismatch;
				let fatalPatchFailure = false;
				const attestations: Array<{ readonly callId: string; readonly itemSha256: string }> = [];
				for (const record of durable.calls) {
					if (
						record.providerThreadId !== threadId ||
						record.providerTurnId !== turn.id ||
						record.receipt === null ||
						record.receipt.outcome === "indeterminate"
					) {
						throw new CodexDynamicPatchToolCoordinatorError();
					}
					const candidates = providerHistory.calls.get(record.callId);
					if (candidates === undefined) throw new CodexDynamicPatchToolCoordinatorError();
					const exact = candidates.flatMap((item) => {
						try {
							const call = parseCodexDynamicPatchToolCallParams({
								threadId,
								turnId: turn.id,
								callId: item.id,
								namespace: item.namespace,
								tool: item.tool,
								arguments: item.arguments,
							});
							const mediatedCall = parseCodexPatchToolCall({
								capsuleId: this.#capsuleId,
								providerThreadId: call.threadId,
								providerTurnId: call.turnId,
								callId: call.callId,
								hostTurn: ref,
								patch: call.patch,
							});
							return record.transactionId ===
								codexPatchTransactionId(codexPatchKey(mediatedCall)) &&
								record.patchSha256 === codexPatchSha256(call.patch) &&
								record.patchBytes === Buffer.byteLength(call.patch, "utf8")
								? [{ item, mediatedCall }]
								: [];
						} catch {
							return [];
						}
					});
					if (exact.length === 0 || exact[0] === undefined) {
						throw new CodexDynamicPatchToolCoordinatorError();
					}
					if (candidates.length !== 1 || exact.length !== 1) policyMismatch = true;
					const { item, mediatedCall } = exact[0];
					const inspection = await this.#mediator.inspect(mediatedCall, this.#authority);
					if (record.receipt.outcome === "applied") {
						if (
							inspection.state !== "committed" ||
							!isDeepStrictEqual(inspection.result, record.receipt.result)
						) {
							throw new CodexDynamicPatchToolCoordinatorError();
						}
					} else if (record.receipt.outcome === "rejected") {
						const exactRejectionState =
							record.receipt.source === "capsule_policy" ? "absent" : "rejected";
						if (inspection.state !== exactRejectionState) {
							throw new CodexDynamicPatchToolCoordinatorError();
						}
					} else {
						if (inspection.state !== "absent") {
							throw new CodexDynamicPatchToolCoordinatorError();
						}
						fatalPatchFailure = true;
					}
					if (
						turn.status === "completed" &&
						!hasExactProviderResponse(
							item,
							record.receipt.outcome === "applied" ? "applied" : "rejected",
						)
					) {
						policyMismatch = true;
					}
					attestations.push({
						callId: item.id,
						itemSha256: dynamicToolItemSha256(item),
					});
				}
				if (providerHistory.calls.size !== durable.calls.length) policyMismatch = true;
				if (policyMismatch) throw new CodexTerminalPatchPolicyMismatchError();
				return Object.freeze({
					providerTurnId: turn.id,
					fatalPatchFailure,
					calls: Object.freeze(
						attestations
							.sort((left, right) => left.callId.localeCompare(right.callId))
							.map((entry) => Object.freeze(entry)),
					),
				});
			});
		} catch (error) {
			if (error instanceof CodexTerminalPatchPolicyMismatchError) throw error;
			throw new CodexDynamicPatchToolCoordinatorError();
		}
	}

	async assertNoPatchCallsForAbandonment(
		refValue: Parameters<CodexRunnerPatchCoordinator["assertNoPatchCallsForAbandonment"]>[0],
		threadId: string,
		providerTurnId: string,
	): Promise<void> {
		try {
			await this.enqueue(async () => {
				await this.assertLiveAuthority();
				await this.ensureRecovered();
				const ref = hostTurnRefSchema.parse(refValue);
				this.assertAuthority(ref);
				const durable = await this.#store.patchCallsForTurn(ref, this.#authorityRecord);
				if (
					durable.threadId !== threadId ||
					durable.providerTurnId !== providerTurnId ||
					durable.toolContract !== CODEX_DYNAMIC_PATCH_TOOL_CONTRACT ||
					durable.calls.length !== 0
				) {
					throw new CodexDynamicPatchToolCoordinatorError();
				}
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
				source: "mediator",
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

	private assertAuthority(ref: Parameters<CodexRunnerPatchCoordinator["attestTerminal"]>[0]): void {
		if (
			ref.missionId !== this.#authority.grant.mission_id ||
			ref.deliveryId !== this.#authorityRecord.delivery_id ||
			ref.executionAttempt !== this.#authorityRecord.execution_attempt
		) {
			throw new CodexDynamicPatchToolCoordinatorError();
		}
	}

	private async assertLiveAuthority(): Promise<void> {
		this.#authority.signal.throwIfAborted();
		await this.#authority.performWorkspaceRead(() => undefined);
		this.#authority.signal.throwIfAborted();
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

export class CodexTerminalPatchPolicyMismatchError extends Error {
	constructor() {
		super("Codex terminal patch history violated the AgentRelay policy contract");
		this.name = "CodexTerminalPatchPolicyMismatchError";
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

function terminalDynamicPatchItems(turn: CodexTurn): {
	readonly calls: ReadonlyMap<string, readonly CodexDynamicToolCallItem[]>;
	readonly policyMismatch: boolean;
} {
	const calls = new Map<string, CodexDynamicToolCallItem[]>();
	let policyMismatch = false;
	for (const item of turn.items) {
		if (item.type === "commandExecution" || item.type === "fileChange") {
			policyMismatch = true;
			continue;
		}
		if (item.type !== "dynamicToolCall") continue;
		const parsed = codexDynamicToolCallItemSchema.safeParse(item);
		if (!parsed.success) {
			policyMismatch = true;
			continue;
		}
		const existing = calls.get(parsed.data.id);
		if (existing === undefined) {
			calls.set(parsed.data.id, [parsed.data]);
		} else {
			policyMismatch = true;
			existing.push(parsed.data);
		}
	}
	return { calls, policyMismatch };
}

function hasExactProviderResponse(
	item: CodexDynamicToolCallItem,
	outcome: "applied" | "rejected",
): boolean {
	const expected = codexDynamicPatchToolResponse(outcome);
	return !(
		item.namespace !== CODEX_DYNAMIC_TOOL_NAMESPACE ||
		item.tool !== CODEX_DYNAMIC_PATCH_TOOL_NAME ||
		item.status !== (outcome === "applied" ? "completed" : "failed") ||
		item.durationMs === null ||
		item.success !== expected.success ||
		!isDeepStrictEqual(item.contentItems, expected.contentItems)
	);
}

export function dynamicToolItemSha256(item: CodexDynamicToolCallItem): string {
	const encoded = canonicalJson(codexDynamicToolCallItemSchema.parse(item));
	if (Buffer.byteLength(encoded, "utf8") > MAX_CODEX_APP_SERVER_FRAME_BYTES) {
		throw new CodexDynamicPatchToolCoordinatorError();
	}
	return createHash("sha256").update(encoded, "utf8").digest("hex");
}
