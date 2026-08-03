import type {
	HostFailure,
	HostSessionRef,
	HostTurnRef,
	TurnDisposition,
} from "@agentrelay/protocol";
import type { CodexCapsuleTurnIntent } from "./codex-capsule-prompt.js";

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
	| { readonly kind: "reconcile" }
	| { readonly kind: "terminal" };

export type CodexNormalizedTerminal =
	| { readonly kind: "completed"; readonly disposition: TurnDisposition }
	| { readonly kind: "failed"; readonly failure: HostFailure }
	| { readonly kind: "cancelled" };
