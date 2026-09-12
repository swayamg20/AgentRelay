import { z } from "zod";

export const MAX_LIVE_INPUT_BYTES = 32_768;
export const liveReplySchema = z.string().trim().min(1).max(4_000).nullable();
export const liveScopeSchema = z
	.object({
		relayUrl: z.string().url(),
		agentId: z.string().uuid(),
		localHandle: z.string().min(1).max(120),
		peerHandle: z.string().min(1).max(120),
		threadId: z.string().uuid(),
	})
	.strict()
	.refine((scope) => scope.localHandle !== scope.peerHandle, "A live peer must be another agent");
export type LiveScope = z.infer<typeof liveScopeSchema>;

export const hostReceiptSchema = z
	.object({
		threadId: z.string().min(1).max(200),
		turnId: z.string().min(1).max(200),
	})
	.strict();
export type LiveHostReceipt = z.infer<typeof hostReceiptSchema>;

const pendingBase = z.object({
	messageId: z.string().uuid(),
	sequence: z.number().int().positive(),
	idempotencyKey: z.string().uuid(),
	inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const liveJournalSchema = z
	.object({
		version: z.literal(1),
		scope: liveScopeSchema,
		maxTurns: z.number().int().min(1).max(12),
		expiresAt: z.number().int().positive(),
		lastSequence: z.number().int().nonnegative(),
		turnsStarted: z.number().int().min(0).max(12),
		pending: z
			.discriminatedUnion("phase", [
				pendingBase.extend({ phase: z.literal("running") }).strict(),
				pendingBase
					.extend({
						phase: z.literal("reply_ready"),
						reply: liveReplySchema,
						host: hostReceiptSchema,
					})
					.strict(),
			])
			.nullable(),
		receipts: z
			.array(
				z
					.object({
						messageId: z.string().uuid(),
						sequence: z.number().int().positive(),
						disposition: z.enum(["replied", "no_reply"]),
						replyMessageId: z.string().uuid().nullable(),
						host: hostReceiptSchema,
					})
					.strict(),
			)
			.max(12),
	})
	.strict()
	.superRefine((state, context) => {
		if (
			state.turnsStarted > state.maxTurns ||
			state.turnsStarted !== state.receipts.length + (state.pending ? 1 : 0)
		) {
			context.addIssue({
				code: "custom",
				message: "Live turn accounting does not match the journal",
			});
		}
		if (state.pending && state.pending.sequence <= state.lastSequence) {
			context.addIssue({ code: "custom", message: "Pending turn is behind the durable sequence" });
		}
	});
export type LiveJournal = z.infer<typeof liveJournalSchema>;

export interface LiveRuntime {
	/** Prepare the local host without starting a model turn. */
	prepare(signal: AbortSignal): Promise<void>;
	runTurn(
		input: { messageId: string; content: string },
		signal: AbortSignal,
	): Promise<{
		reply: string | null;
		host: LiveHostReceipt;
	}>;
	close(): Promise<void>;
}

export class LiveSessionError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "LiveSessionError";
	}
}
