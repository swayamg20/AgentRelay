import { z } from "zod";

export const SHARE_CONTENT_BYTES = 64 * 1024;
export const SHARE_REPLY_BYTES = 16 * 1024;
export const shareIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

function boundedContent(maxBytes: number) {
	return z
		.string()
		.min(1)
		.refine((content) => Buffer.byteLength(content, "utf8") <= maxBytes)
		.refine((content) => !content.includes("\u0000"));
}

export const createShareSchema = z
	.object({
		content: boundedContent(SHARE_CONTENT_BYTES),
		idempotency_key: z.string().uuid(),
		expires_in_days: z.number().int().min(1).max(30).default(7),
	})
	.strict();

export const shareReplySchema = z
	.object({
		content: boundedContent(SHARE_REPLY_BYTES),
		idempotency_key: z.string().uuid().optional(),
	})
	.strict();

export const shareAnswerSchema = z
	.object({
		content: boundedContent(SHARE_REPLY_BYTES),
		idempotency_key: z.string().uuid(),
	})
	.strict();

export const shareReleaseSchema = z
	.object({ confirmation: z.literal("release_to_inbox") })
	.strict();

export const shareInboxSchema = z
	.object({
		after_cursor: z
			.string()
			.regex(/^(0|[1-9][0-9]{0,18})$/)
			.pipe(z.string().refine((value) => BigInt(value) <= 9223372036854775807n))
			.default("0"),
		limit: z.coerce.number().int().min(1).max(10).default(10),
		since: z.string().datetime().optional(),
	})
	.strict();

export type CreateShareInput = z.infer<typeof createShareSchema>;
export type ShareReplyInput = z.infer<typeof shareReplySchema>;
export type ShareAnswerInput = z.infer<typeof shareAnswerSchema>;
export type ShareInboxInput = z.infer<typeof shareInboxSchema>;
