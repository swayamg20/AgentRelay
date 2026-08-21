import { isAbsolute, normalize } from "node:path";
import type {
	AdapterInfo,
	HostEvent,
	HostSessionRef,
	HostTurnRef,
	SessionInput,
} from "@agentrelay/protocol";
import { adapterInfoSchema } from "@agentrelay/protocol";
import { z } from "zod";
import type { CodexAppServerClientEvent, StartCodexTurnInput } from "./codex-app-server-client.js";
import type {
	CodexThread,
	CodexThreadStartResult,
	CodexTurn,
} from "./codex-app-server-protocol.js";
import type { CodexCapsuleStore } from "./codex-capsule-store.js";
import type { CodexDynamicPatchToolHandler } from "./codex-dynamic-patch-tool-contract.js";

export const CODEX_CAPSULE_ADAPTER_INFO: AdapterInfo = adapterInfoSchema.parse({
	name: "capsule-codex",
	version: "0.4.0",
	capabilities: { cancellation: true, recovery: true, usage: "turn_cumulative" },
});

export interface CodexCapsuleClient {
	startThread(): Promise<CodexThreadStartResult>;
	resumeThread(threadId: string): Promise<CodexThreadStartResult>;
	readThread(threadId: string): Promise<CodexThread>;
	startReadOnlyTurn(input: StartCodexTurnInput): Promise<CodexTurn>;
	interruptTurn(threadId: string, turnId: string): Promise<void>;
	events(): AsyncIterable<CodexAppServerClientEvent>;
}

export type CodexProviderTerminationReason =
	| "capsule_shutdown"
	| "startup_failure"
	| "provider_failure"
	| "authority_revoked"
	| "deadline_exceeded";

export interface CodexProviderTermination {
	readonly kind: "stopped" | "crashed" | "unresponsive";
}

export interface CodexProviderGeneration {
	readonly generationId: string;
	readonly client: CodexCapsuleClient;
	readonly termination: Promise<CodexProviderTermination>;
	terminate(reason: CodexProviderTerminationReason): Promise<void>;
}

export interface CodexProviderGuardian {
	openGeneration(): Promise<CodexProviderGeneration>;
}

export interface CodexTerminalPatchAttestation {
	readonly providerTurnId: string;
	readonly fatalPatchFailure: boolean;
	readonly calls: readonly Readonly<{
		readonly callId: string;
		readonly itemSha256: string;
	}>[];
}

export interface CodexRunnerPatchCoordinator extends CodexDynamicPatchToolHandler {
	recover(): Promise<void>;
	assertNoPatchCallsForAbandonment(
		ref: HostTurnRef,
		threadId: string,
		providerTurnId: string,
	): Promise<void>;
	attestTerminal(
		ref: HostTurnRef,
		threadId: string,
		turn: CodexTurn,
	): Promise<CodexTerminalPatchAttestation>;
	close(): Promise<void>;
}

/** Marks a provider teardown whose quiescence proof failed before downstream state was safe to close. */
export class CodexProviderTerminationUnprovenError extends AggregateError {
	readonly #owner: object;

	constructor(errors: Iterable<unknown>, message: string, owner: object) {
		super(errors, message);
		this.name = "CodexProviderTerminationUnprovenError";
		this.#owner = owner;
	}

	get owner(): object {
		return this.#owner;
	}
}

export interface CodexCapsuleRunnerOptions {
	readonly store: CodexCapsuleStore;
	readonly cwd: string;
	readonly guardian: CodexProviderGuardian;
	readonly patchCoordinator?: CodexRunnerPatchCoordinator;
	/** Retires the owning Capsule without exposing a provider failure over the wire. */
	readonly retireGeneration: () => void;
	readonly eventPollMs?: number;
	readonly providerPollMs?: number;
}

export function sessionInputFromRef(ref: HostSessionRef): SessionInput {
	return {
		missionId: ref.missionId,
		participantId: ref.participantId,
		workspaceAlias: ref.workspaceAlias,
	};
}

export function matchesProviderTurn(
	notification: CodexAppServerClientEvent["notification"],
	threadId: string,
	turnId: string,
): boolean {
	if (notification.params.threadId !== threadId) return false;
	return notification.method === "turn/started" || notification.method === "turn/completed"
		? notification.params.turn.id === turnId
		: notification.params.turnId === turnId;
}

export function isTerminalHostEvent(event: HostEvent | undefined): boolean {
	return event?.kind === "completed" || event?.kind === "failed" || event?.kind === "cancelled";
}

export function validateCodexRunnerCwd(path: string): string {
	if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0")) {
		throw new Error("Codex Capsule working directory must be absolute and normalized");
	}
	return path;
}

export function boundedRunnerMilliseconds(value: number): number {
	return z.number().int().min(1).max(60_000).parse(value);
}
