import type { TrustFile } from "../trust.js";
import { computeOverlay } from "../trust.js";
import type { RuntimeAttentionRequest } from "./runtime.js";

export interface MailboxAttentionReference {
	eventId: string;
	threadId: string;
	senderHandle: string;
}

/**
 * Turn a mailbox reference into local runtime attention only when this exact
 * sender has explicit auto_pickup consent. Defaults and unknown-sender policy
 * cannot grant runtime pickup.
 */
export function planAutoPickup(
	trust: TrustFile,
	reference: MailboxAttentionReference,
): RuntimeAttentionRequest | null {
	const senderEntry = trust.teammates[reference.senderHandle];
	if (senderEntry?.auto_pickup !== true) return null;

	const decision = computeOverlay(trust, reference.senderHandle);
	if (decision.decision === "reject" || !decision.overlay.auto_pickup) return null;
	return {
		eventId: reference.eventId,
		threadId: reference.threadId,
	};
}
