export type NotificationKind =
	| "notify.handoff.created"
	| "notify.message.appended"
	| "notify.handoff.completed"
	| "notify.handoff.cancelled";

export interface NotificationJob {
	kind: NotificationKind;
	recipientAgentId: string; // who should be notified
	threadId: string;
	senderHandle: string;
	senderName: string;
	summary: string; // first 240 chars rendered in the block kit
	publicUrl: string; // relay public URL for deep link
	enqueuedAt: number;
}

export interface DispatchOutcome {
	ok: boolean;
	attempts: number;
	durationMs: number;
	reason?: string;
	status?: number;
}
