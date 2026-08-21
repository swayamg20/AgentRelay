import type {
	HostFailure,
	HostSessionRef,
	HostTurnRef,
	TurnDisposition,
} from "@agentrelay/protocol";
import type { CodexCapsuleTurnIntent } from "./codex-capsule-prompt.js";
import type { CodexDynamicPatchToolContract } from "./codex-dynamic-patch-tool-contract.js";
import type {
	CodexPatchAuthorityRecord,
	CodexPatchResult,
	CodexPatchToolCall,
} from "./codex-workspace-patch-contract.js";

export type CodexSessionStartClaim =
	| { readonly kind: "send" }
	| { readonly kind: "reconcile" }
	| { readonly kind: "ready"; readonly session: HostSessionRef; readonly threadId: string };

export type CodexTurnStartClaim =
	| { readonly kind: "send"; readonly intent: CodexCapsuleTurnIntent }
	| { readonly kind: "reconcile"; readonly intent: CodexCapsuleTurnIntent }
	| { readonly kind: "accepted"; readonly turn: HostTurnRef; readonly terminal: boolean };

export type CodexInterruptClaim =
	| { readonly kind: "send"; readonly threadId: string; readonly codexTurnId: string }
	| { readonly kind: "awaiting_provider" }
	| { readonly kind: "reconcile" }
	| { readonly kind: "terminal" };

export interface CodexTurnRuntimeState {
	readonly turn: HostTurnRef;
	readonly intent: CodexCapsuleTurnIntent;
	readonly phase: "prepared" | "start_maybe_sent" | "accepted" | "cancelling" | "terminal";
	readonly threadId: string;
	readonly codexTurnId: string | null;
	readonly cancellationRequested: boolean;
	readonly terminal: boolean;
}

export type CodexNormalizedTerminal =
	| { readonly kind: "completed"; readonly disposition: TurnDisposition }
	| { readonly kind: "failed"; readonly failure: HostFailure }
	| { readonly kind: "cancelled" };

export interface CodexPatchCallRequest {
	readonly providerThreadId: string;
	readonly providerTurnId: string;
	readonly callId: string;
	readonly patch: string;
	readonly authority: CodexPatchAuthorityRecord;
}

export type CodexPatchCallReceipt =
	| { readonly outcome: "applied"; readonly result: CodexPatchResult }
	| { readonly outcome: "rejected"; readonly source: "capsule_policy" | "mediator" }
	| { readonly outcome: "failed"; readonly classification: "fatal" }
	| { readonly outcome: "indeterminate" };

export type CodexPatchCallClaim =
	| {
			readonly kind: "pending";
			readonly call: CodexPatchToolCall;
			readonly replayed: boolean;
	  }
	| {
			readonly kind: "terminal";
			readonly receipt: CodexPatchCallReceipt;
			readonly replayed: boolean;
	  };

export interface CodexPatchCallAttestationRecord {
	readonly providerThreadId: string;
	readonly providerTurnId: string;
	readonly callId: string;
	readonly transactionId: string;
	readonly patchSha256: string;
	readonly patchBytes: number;
	readonly receipt: CodexPatchCallReceipt | null;
}

export interface CodexTurnPatchCalls {
	readonly threadId: string;
	readonly providerTurnId: string | null;
	readonly toolContract: CodexDynamicPatchToolContract | null;
	readonly calls: readonly CodexPatchCallAttestationRecord[];
}
